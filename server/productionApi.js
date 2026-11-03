import { createHash, randomUUID } from "node:crypto";
import {
  hashPassword,
  hashSessionToken,
  newSessionToken,
  verifyPassword,
} from "./security.js";

const DEVELOPMENT_SESSION_COOKIE = "xama_session";
const PRODUCTION_SESSION_COOKIE = "__Host-xama_session";
const SESSION_SECONDS = 60 * 60 * 24 * 14;
const MAX_BODY_BYTES = 12_000_000;
const MAX_LOGIN_ATTEMPTS = 8;
const ALLOWED_STATE_KEYS = new Set([
  "xama.crm.motoristas",
  "xama.crm.motoristas.inicializados.v1",
  "xama.crm.resumo.periodo.inicio",
  "xama.crm.resumo.periodo.fim",
  "xama.crm.corridas",
  "xama.crm.pagamentos",
  "xama.crm.transacoes",
  "xama.crm.importacoes",
  "xama.crm.corridasImportadas",
  "xama.crm.revisoesImportacao",
  "xama.crm.vinculosWhatsApp",
  "xama.crm.fechamentos",
]);
function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function cookieOptions(env, maxAge = SESSION_SECONDS) {
  const name = env.NODE_ENV === "production" ? PRODUCTION_SESSION_COOKIE : DEVELOPMENT_SESSION_COOKIE;
  return `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

function readCookie(request, name) {
  const pair = String(request.headers.cookie ?? "")
    .split(";")
    .map(value => value.trim())
    .find(value => value.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : "";
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("Os dados excedem o limite permitido para persistência.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    const error = new Error("O corpo da requisição não é um JSON válido.");
    error.statusCode = 400;
    throw error;
  }
}

function requestHasSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function rateLimitKey(request) {
  return createHash("sha256")
    .update(String(request.socket.remoteAddress ?? "unknown"))
    .digest("hex");
}

function assertState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("O estado enviado tem formato inválido.");
  }
  const keys = Object.keys(state);
  if (
    keys.length !== ALLOWED_STATE_KEYS.size
    || keys.some(key => !ALLOWED_STATE_KEYS.has(key))
  ) {
    throw new Error("O estado não contém exatamente os conjuntos de dados suportados.");
  }
  for (const [key, value] of Object.entries(state)) {
    if (value === undefined) throw new Error(`O conjunto ${key} está incompleto.`);
  }
}

export function createProductionApi({ pool, env = process.env }) {
  async function findUser(request) {
    const cookieName = env.NODE_ENV === "production"
      ? PRODUCTION_SESSION_COOKIE
      : DEVELOPMENT_SESSION_COOKIE;
    const token = readCookie(request, cookieName);
    if (!token) return null;
    const result = await pool.query(
      `SELECT u.id, u.email, u.role, u.organization_id AS "organizationId"
       FROM xama_sessions s
       JOIN xama_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = TRUE`,
      [hashSessionToken(token)],
    );
    return result.rows[0] ?? null;
  }

  async function requireUser(request, response) {
    if (!pool) {
      sendJson(response, 503, { error: "O banco PostgreSQL não está configurado." });
      return null;
    }
    const user = await findUser(request);
    if (!user) sendJson(response, 401, { error: "Sessão expirada. Entre novamente." });
    return user;
  }

  async function handle(request, response) {
    const { pathname } = new URL(request.url, "http://localhost");
    if (pathname === "/api/health" && request.method === "GET") {
      if (!pool) {
        sendJson(response, env.NODE_ENV === "production" ? 503 : 200, {
          status: env.NODE_ENV === "production" ? "unavailable" : "local",
          database: "not-configured",
        });
        return true;
      }
      try {
        await pool.query("SELECT 1");
        sendJson(response, 200, { status: "ok", database: "connected" });
      } catch {
        sendJson(response, 503, { status: "unavailable", database: "disconnected" });
      }
      return true;
    }

    if (pathname === "/api/auth/me" && request.method === "GET") {
      if (!pool && env.NODE_ENV !== "production") {
        sendJson(response, 200, { mode: "local", user: null });
        return true;
      }
      if (!pool) {
        sendJson(response, 503, { error: "Banco PostgreSQL não configurado." });
        return true;
      }
      const user = await findUser(request);
      sendJson(response, 200, {
        mode: "production",
        user: user ? { id: user.id, email: user.email, role: user.role } : null,
      });
      return true;
    }

    if (pathname === "/api/auth/login" && request.method === "POST") {
      if (!requestHasSameOrigin(request)) {
        sendJson(response, 403, { error: "Origem da solicitação não permitida." });
        return true;
      }
      if (!pool) {
        sendJson(response, 503, { error: "Banco PostgreSQL não configurado." });
        return true;
      }
      const body = await readJsonBody(request);
      const email = String(body.email ?? "").trim().toLocaleLowerCase("en-US");
      const password = String(body.password ?? "");
      if (password.length > 1024) {
        sendJson(response, 401, { error: "E-mail ou senha inválidos." });
        return true;
      }
      const key = rateLimitKey(request);
      await pool.query("DELETE FROM xama_login_attempts WHERE reset_at <= NOW()");
      const attemptResult = await pool.query(
        `INSERT INTO xama_login_attempts (ip_hash, attempts, reset_at)
         VALUES ($1, 1, NOW() + INTERVAL '15 minutes')
         ON CONFLICT (ip_hash) DO UPDATE
         SET attempts = CASE
           WHEN xama_login_attempts.reset_at <= NOW() THEN 1
           ELSE xama_login_attempts.attempts + 1
         END,
         reset_at = CASE
           WHEN xama_login_attempts.reset_at <= NOW() THEN NOW() + INTERVAL '15 minutes'
           ELSE xama_login_attempts.reset_at
         END
         RETURNING attempts`,
        [key],
      );
      if (Number(attemptResult.rows[0]?.attempts ?? 0) > MAX_LOGIN_ATTEMPTS) {
        sendJson(response, 429, { error: "Muitas tentativas de acesso. Aguarde 15 minutos." });
        return true;
      }

      const result = await pool.query(
        `SELECT id, email, password_hash, role
         FROM xama_users
         WHERE organization_id = $1 AND email = $2 AND active = TRUE`,
        ["xama", email],
      );
      const account = result.rows[0];
      if (!account || !(await verifyPassword(password, account.password_hash))) {
        sendJson(response, 401, { error: "E-mail ou senha inválidos." });
        return true;
      }
      await pool.query("DELETE FROM xama_login_attempts WHERE ip_hash = $1", [key]);
      const token = newSessionToken();
      const cookieName = env.NODE_ENV === "production"
        ? PRODUCTION_SESSION_COOKIE
        : DEVELOPMENT_SESSION_COOKIE;
      await pool.query(
        "INSERT INTO xama_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '14 days')",
        [hashSessionToken(token), account.id],
      );
      sendJson(response, 200, {
        user: { id: account.id, email: account.email, role: account.role },
      }, {
        "Set-Cookie": `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${env.NODE_ENV === "production" ? "; Secure" : ""}`,
      });
      return true;
    }

    if (pathname === "/api/auth/logout" && request.method === "POST") {
      if (!requestHasSameOrigin(request)) {
        sendJson(response, 403, { error: "Origem da solicitação não permitida." });
        return true;
      }
      const cookieName = env.NODE_ENV === "production"
        ? PRODUCTION_SESSION_COOKIE
        : DEVELOPMENT_SESSION_COOKIE;
      const token = readCookie(request, cookieName);
      if (pool && token) {
        await pool.query("DELETE FROM xama_sessions WHERE token_hash = $1", [hashSessionToken(token)]);
      }
      sendJson(response, 200, { ok: true }, { "Set-Cookie": cookieOptions(env, 0) });
      return true;
    }

    if (pathname === "/api/auth/users" && request.method === "GET") {
      const user = await requireUser(request, response);
      if (!user) return true;
      if (user.role !== "admin") {
        sendJson(response, 403, { error: "Somente administradores podem gerenciar contas." });
        return true;
      }
      const users = await pool.query(
        "SELECT id, email, role, active FROM xama_users WHERE organization_id = $1 ORDER BY email",
        [user.organizationId],
      );
      sendJson(response, 200, { users: users.rows });
      return true;
    }

    if (pathname === "/api/auth/users" && request.method === "POST") {
      if (!requestHasSameOrigin(request)) {
        sendJson(response, 403, { error: "Origem da solicitação não permitida." });
        return true;
      }
      const user = await requireUser(request, response);
      if (!user) return true;
      if (user.role !== "admin") {
        sendJson(response, 403, { error: "Somente administradores podem criar contas." });
        return true;
      }
      const body = await readJsonBody(request);
      const email = String(body.email ?? "").trim().toLocaleLowerCase("en-US");
      const password = String(body.password ?? "");
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        || password.length < 12
        || password.length > 1024
      ) {
        sendJson(response, 400, { error: "Informe um e-mail válido e uma senha entre 12 e 1024 caracteres." });
        return true;
      }
      const passwordHash = await hashPassword(password);
      const created = await pool.query(
        `INSERT INTO xama_users (id, organization_id, email, password_hash, role)
         VALUES ($1, $2, $3, $4, 'member')
         ON CONFLICT (organization_id, email) DO NOTHING
         RETURNING id, email, role, active`,
        [randomUUID(), user.organizationId, email, passwordHash],
      );
      if (!created.rows[0]) {
        sendJson(response, 409, { error: "Já existe uma conta com esse e-mail." });
        return true;
      }
      sendJson(response, 201, { user: created.rows[0] });
      return true;
    }

    const userRoute = pathname.match(/^\/api\/auth\/users\/([^/]+)$/);
    if (userRoute && request.method === "PATCH") {
      if (!requestHasSameOrigin(request)) {
        sendJson(response, 403, { error: "Origem da solicitação não permitida." });
        return true;
      }
      const user = await requireUser(request, response);
      if (!user) return true;
      if (user.role !== "admin") {
        sendJson(response, 403, { error: "Somente administradores podem alterar contas." });
        return true;
      }
      const body = await readJsonBody(request);
      if (typeof body.active !== "boolean") {
        sendJson(response, 400, { error: "Informe o novo estado ativo da conta." });
        return true;
      }
      const targetId = decodeURIComponent(userRoute[1]);
      if (targetId === user.id && !body.active) {
        sendJson(response, 400, { error: "Não é possível desativar a própria conta." });
        return true;
      }
      const client = body.active ? pool : await pool.connect();
      let transactionOpen = false;
      try {
        if (!body.active) {
          await client.query("BEGIN");
          transactionOpen = true;
          await client.query(
            "SELECT id FROM xama_organizations WHERE id = $1 FOR UPDATE",
            [user.organizationId],
          );
          const target = await client.query(
            "SELECT role FROM xama_users WHERE id = $1 AND organization_id = $2 AND active = TRUE",
            [targetId, user.organizationId],
          );
          if (target.rows[0]?.role === "admin") {
            const admins = await client.query(
              "SELECT COUNT(*)::int AS count FROM xama_users WHERE organization_id = $1 AND role = 'admin' AND active = TRUE",
              [user.organizationId],
            );
            if (admins.rows[0].count <= 1) {
              await client.query("ROLLBACK");
              transactionOpen = false;
              sendJson(response, 409, { error: "A empresa precisa manter ao menos uma conta administradora ativa." });
              return true;
            }
          }
        }
        const updated = await client.query(
          `UPDATE xama_users SET active = $1
           WHERE id = $2 AND organization_id = $3
           RETURNING id, email, role, active`,
          [body.active, targetId, user.organizationId],
        );
        if (!updated.rows[0]) {
          if (transactionOpen) {
            await client.query("ROLLBACK");
            transactionOpen = false;
          }
          sendJson(response, 404, { error: "Conta não encontrada." });
          return true;
        }
        if (!body.active) {
          await client.query("DELETE FROM xama_sessions WHERE user_id = $1", [targetId]);
          await client.query("COMMIT");
          transactionOpen = false;
        }
        sendJson(response, 200, { user: updated.rows[0] });
        return true;
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK");
        throw error;
      } finally {
        if (!body.active) client.release();
      }
    }

    if (pathname === "/api/auth/password" && request.method === "POST") {
      if (!requestHasSameOrigin(request)) {
        sendJson(response, 403, { error: "Origem da solicitação não permitida." });
        return true;
      }
      const user = await requireUser(request, response);
      if (!user) return true;
      const body = await readJsonBody(request);
      const currentPassword = String(body.currentPassword ?? "");
      const newPassword = String(body.newPassword ?? "");
      if (newPassword.length < 12 || newPassword.length > 1024) {
        sendJson(response, 400, { error: "A nova senha deve ter entre 12 e 1024 caracteres." });
        return true;
      }
      const current = await pool.query(
        "SELECT password_hash FROM xama_users WHERE id = $1 AND organization_id = $2 AND active = TRUE",
        [user.id, user.organizationId],
      );
      if (!current.rows[0] || !(await verifyPassword(currentPassword, current.rows[0].password_hash))) {
        sendJson(response, 401, { error: "Senha atual inválida." });
        return true;
      }
      const passwordHash = await hashPassword(newPassword);
      await pool.query(
        "UPDATE xama_users SET password_hash = $1 WHERE id = $2 AND organization_id = $3",
        [passwordHash, user.id, user.organizationId],
      );
      const token = readCookie(
        request,
        env.NODE_ENV === "production" ? PRODUCTION_SESSION_COOKIE : DEVELOPMENT_SESSION_COOKIE,
      );
      await pool.query(
        "DELETE FROM xama_sessions WHERE user_id = $1 AND token_hash <> $2",
        [user.id, hashSessionToken(token)],
      );
      sendJson(response, 200, { ok: true });
      return true;
    }

    if (pathname === "/api/state" && request.method === "GET") {
      const user = await requireUser(request, response);
      if (!user) return true;
      const result = await pool.query(
        "SELECT state, version FROM xama_app_state WHERE organization_id = $1",
        [user.organizationId],
      );
      const row = result.rows[0];
      sendJson(response, 200, {
        state: row ? row.state : null,
        version: row ? Number(row.version) : 0,
      });
      return true;
    }

    if (pathname === "/api/state" && request.method === "PUT") {
      if (!requestHasSameOrigin(request)) {
        sendJson(response, 403, { error: "Origem da solicitação não permitida." });
        return true;
      }
      const user = await requireUser(request, response);
      if (!user) return true;
      const body = await readJsonBody(request);
      try {
        assertState(body.state);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return true;
      }
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
        sendJson(response, 400, { error: "Versão de estado inválida." });
        return true;
      }

      if (body.expectedVersion === 0) {
        const inserted = await pool.query(
          `INSERT INTO xama_app_state (organization_id, state, version)
           VALUES ($1, $2::jsonb, 1)
           ON CONFLICT (organization_id) DO NOTHING
           RETURNING state, version`,
          [user.organizationId, JSON.stringify(body.state)],
        );
        if (inserted.rows[0]) {
          sendJson(response, 200, { state: inserted.rows[0].state, version: Number(inserted.rows[0].version) });
          return true;
        }
      } else {
        const updated = await pool.query(
          `UPDATE xama_app_state
           SET state = $1::jsonb, version = version + 1, updated_at = NOW()
           WHERE organization_id = $2 AND version = $3
           RETURNING state, version`,
          [JSON.stringify(body.state), user.organizationId, body.expectedVersion],
        );
        if (updated.rows[0]) {
          sendJson(response, 200, { state: updated.rows[0].state, version: Number(updated.rows[0].version) });
          return true;
        }
      }
      const current = await pool.query(
        "SELECT state, version FROM xama_app_state WHERE organization_id = $1",
        [user.organizationId],
      );
      const row = current.rows[0];
      sendJson(response, 409, {
        error: "Os dados foram alterados por outra sessão. Recarregue o estado antes de salvar para evitar sobrescrever alterações.",
        state: row?.state ?? null,
        version: row ? Number(row.version) : 0,
      });
      return true;
    }

    return false;
  }

  return {
    handle,
    findUser,
    requireUser,
  };
}
