import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createProductionApi } from "./productionApi.js";
import { hashPassword } from "./security.js";

const STATE_KEYS = [
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
];

function createFakePool(initialUsers = []) {
  const users = [...initialUsers];
  const sessions = new Map();
  const loginAttempts = new Map();
  const transactionLog = [];
  const control = { adminCountOverride: null, onOrganizationLock: null };
  let state = null;
  let version = 0;
  const query = async (sql, values = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql.trim())) {
        return { rows: [] };
      }
      if (sql.includes("DELETE FROM xama_login_attempts WHERE reset_at")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO xama_login_attempts")) {
        const [ipHash] = values;
        const attempts = (loginAttempts.get(ipHash) ?? 0) + 1;
        loginAttempts.set(ipHash, attempts);
        return { rows: [{ attempts }] };
      }
      if (sql.includes("DELETE FROM xama_login_attempts WHERE ip_hash")) {
        loginAttempts.delete(values[0]);
        return { rows: [] };
      }
      if (sql.includes("FROM xama_organizations") && sql.includes("FOR UPDATE")) {
        control.onOrganizationLock?.();
        control.onOrganizationLock = null;
        return { rows: [{ id: values[0] }] };
      }
      if (sql.includes("SELECT role FROM xama_users")) {
        const user = users.find(item => (
          item.id === values[0]
          && item.organization_id === values[1]
          && item.active
        ));
        return { rows: user ? [{ role: user.role }] : [] };
      }
      if (sql.includes("SELECT COUNT(*)::int AS count FROM xama_users")) {
        return {
          rows: [{
            count: control.adminCountOverride ?? users.filter(item => (
              item.organization_id === values[0]
              && item.role === "admin"
              && item.active
            )).length,
          }],
        };
      }
      if (sql.includes("UPDATE xama_users SET active")) {
        const [active, id, organizationId] = values;
        const user = users.find(item => (
          item.id === id && item.organization_id === organizationId
        ));
        if (!user) return { rows: [] };
        user.active = active;
        return { rows: [{ id, email: user.email, role: user.role, active }] };
      }
      if (sql.includes("FROM xama_sessions s")) {
        const [tokenHash] = values;
        const session = sessions.get(tokenHash);
        const user = users.find(item => item.id === session?.user_id && item.active);
        return { rows: user ? [{
          id: user.id,
          email: user.email,
          role: user.role,
          organizationId: user.organization_id,
        }] : [] };
      }
      if (sql.includes("FROM xama_users") && sql.includes("password_hash")) {
        const user = users.find(item => (
          item.organization_id === values[0]
          && item.email === values[1]
          && item.active
        ));
        return { rows: user ? [user] : [] };
      }
      if (sql.includes("INSERT INTO xama_sessions")) {
        sessions.set(values[0], { user_id: values[1] });
        return { rows: [] };
      }
      if (sql.includes("DELETE FROM xama_sessions")) {
        if (sql.includes("WHERE user_id")) {
          for (const [tokenHash, session] of sessions) {
            if (session.user_id === values[0]) sessions.delete(tokenHash);
          }
        } else {
          sessions.delete(values[0]);
        }
        return { rows: [] };
      }
      if (sql.includes("SELECT id, email, role, active FROM xama_users")) {
        return {
          rows: users.filter(user => user.organization_id === values[0])
            .map(({ id, email, role, active }) => ({ id, email, role, active })),
        };
      }
      if (sql.includes("INSERT INTO xama_users")) {
        const [, organizationId, email, passwordHash] = values;
        if (users.some(user => user.organization_id === organizationId && user.email === email)) {
          return { rows: [] };
        }
        const user = {
          id: values[0],
          organization_id: organizationId,
          email,
          password_hash: passwordHash,
          role: "member",
          active: true,
        };
        users.push(user);
        return { rows: [{ id: user.id, email, role: user.role, active: user.active }] };
      }
      if (sql.includes("SELECT state, version FROM xama_app_state")) {
        return { rows: state === null ? [] : [{ state, version }] };
      }
      if (sql.includes("INSERT INTO xama_app_state")) {
        if (state !== null) return { rows: [] };
        state = JSON.parse(values[1]);
        version = 1;
        return { rows: [{ state, version }] };
      }
      if (sql.includes("UPDATE xama_app_state")) {
        if (state === null || version !== values[2]) return { rows: [] };
        state = JSON.parse(values[0]);
        version += 1;
        return { rows: [{ state, version }] };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
  };
  return {
    users,
    sessions,
    loginAttempts,
    transactionLog,
    control,
    query,
    connect: async () => ({
      query: async (sql, values) => {
        transactionLog.push(sql.trim());
        return query(sql, values);
      },
      release: () => {},
    }),
  };
}

async function createApiServer(t, api) {
  const server = createServer(async (request, response) => {
    try {
      if (!await api.handle(request, response)) {
        response.writeHead(404).end();
      }
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function login(baseUrl, email = "admin@example.com", password = "correct horse battery") {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
    body: JSON.stringify({ email, password }),
  });
  return response;
}

const admin = async () => ({
  id: randomUUID(),
  organization_id: "xama",
  email: "admin@example.com",
  password_hash: await hashPassword("correct horse battery"),
  role: "admin",
  active: true,
});

test("development without PostgreSQL stays explicitly in local-storage mode", async t => {
  const api = createProductionApi({ pool: null, env: { NODE_ENV: "development" } });
  const baseUrl = await createApiServer(t, api);
  const response = await fetch(`${baseUrl}/api/auth/me`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { mode: "local", user: null });
});

test("individual login creates a secure session, protects routes, and logout revokes it", async t => {
  const pool = createFakePool([await admin()]);
  const api = createProductionApi({ pool, env: { NODE_ENV: "production" } });
  const baseUrl = await createApiServer(t, api);

  const unauthenticated = await fetch(`${baseUrl}/api/state`);
  assert.equal(unauthenticated.status, 401);

  const loginResponse = await login(baseUrl);
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /__Host-xama_session=/);
  const token = cookie.match(/__Host-xama_session=([^;]+)/)?.[1];
  assert.ok(token);

  const me = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: `__Host-xama_session=${token}` },
  });
  assert.equal((await me.json()).user.email, "admin@example.com");

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: `__Host-xama_session=${token}`, Origin: baseUrl },
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/state`, {
    headers: { Cookie: `__Host-xama_session=${token}` },
  })).status, 401);
});

test("login attempts are capped per IP in shared PostgreSQL state", async t => {
  const pool = createFakePool([]);
  const api = createProductionApi({ pool, env: { NODE_ENV: "production" } });
  const baseUrl = await createApiServer(t, api);
  const statuses = [];

  for (let attempt = 0; attempt < 9; attempt += 1) {
    const response = await login(baseUrl, `missing-${attempt}@example.com`, "incorrect password");
    statuses.push(response.status);
  }

  assert.deepEqual(statuses, [...Array(8).fill(401), 429]);
  assert.equal(pool.loginAttempts.size, 1);
});

test("the last active administrator cannot be deactivated", async t => {
  const account = await admin();
  const target = { ...await admin(), id: randomUUID(), email: "other-admin@example.com" };
  const pool = createFakePool([account, target]);
  const api = createProductionApi({ pool, env: { NODE_ENV: "production" } });
  const baseUrl = await createApiServer(t, api);
  const loginResponse = await login(baseUrl);
  const cookie = `__Host-xama_session=${loginResponse.headers.get("set-cookie").match(/__Host-xama_session=([^;]+)/)[1]}`;
  pool.control.onOrganizationLock = () => {
    account.active = false;
    pool.control.adminCountOverride = 1;
  };
  const response = await fetch(`${baseUrl}/api/auth/users/${target.id}`, {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      Origin: baseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ active: false }),
  });

  assert.equal(response.status, 409);
  assert.equal(target.active, true);
  assert.match(pool.transactionLog[0], /^BEGIN$/);
  assert.match(pool.transactionLog[1], /FOR UPDATE/);
  assert.match(pool.transactionLog.at(-1), /^ROLLBACK$/);
});

test("state migration and optimistic versioning reject stale writes without overwriting data", async t => {
  const pool = createFakePool([await admin()]);
  const api = createProductionApi({ pool, env: { NODE_ENV: "test" } });
  const baseUrl = await createApiServer(t, api);
  const loginResponse = await login(baseUrl);
  const cookie = `xama_session=${loginResponse.headers.get("set-cookie").match(/xama_session=([^;]+)/)[1]}`;
  const state = Object.fromEntries(STATE_KEYS.map(key => [key, []]));
  const firstSave = await fetch(`${baseUrl}/api/state`, {
    method: "PUT",
    headers: { Cookie: cookie, Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ state, expectedVersion: 0 }),
  });
  assert.equal(firstSave.status, 200);
  assert.equal((await firstSave.json()).version, 1);

  const changedState = { ...state, "xama.crm.corridas": [{ id: "saved" }] };
  const secondSave = await fetch(`${baseUrl}/api/state`, {
    method: "PUT",
    headers: { Cookie: cookie, Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ state: changedState, expectedVersion: 1 }),
  });
  assert.equal(secondSave.status, 200);

  const staleSave = await fetch(`${baseUrl}/api/state`, {
    method: "PUT",
    headers: { Cookie: cookie, Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ state, expectedVersion: 1 }),
  });
  assert.equal(staleSave.status, 409);

  const loaded = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } });
  const payload = await loaded.json();
  assert.equal(payload.version, 2);
  assert.deepEqual(payload.state["xama.crm.corridas"], [{ id: "saved" }]);
});

test("admin can provision individual member accounts; members cannot create users", async t => {
  const pool = createFakePool([await admin()]);
  const api = createProductionApi({ pool, env: { NODE_ENV: "test" } });
  const baseUrl = await createApiServer(t, api);
  const adminLogin = await login(baseUrl);
  const adminCookie = `xama_session=${adminLogin.headers.get("set-cookie").match(/xama_session=([^;]+)/)[1]}`;
  const created = await fetch(`${baseUrl}/api/auth/users`, {
    method: "POST",
    headers: { Cookie: adminCookie, Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "staff@example.com", password: "a secure team password" }),
  });
  assert.equal(created.status, 201);

  const memberLogin = await login(baseUrl, "staff@example.com", "a secure team password");
  const memberCookie = `xama_session=${memberLogin.headers.get("set-cookie").match(/xama_session=([^;]+)/)[1]}`;
  const denied = await fetch(`${baseUrl}/api/auth/users`, {
    method: "POST",
    headers: { Cookie: memberCookie, Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "other@example.com", password: "another secure password" }),
  });
  assert.equal(denied.status, 403);
});
