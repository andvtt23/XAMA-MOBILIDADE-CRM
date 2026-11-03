import pg from "pg";
import { randomUUID } from "node:crypto";
import { hashPassword } from "./security.js";

const { Pool } = pg;

export function createDatabase(env = process.env) {
  const connectionString = String(env.DATABASE_URL ?? "").trim();
  if (!connectionString) return null;
  return new Pool({
    connectionString,
    max: Number(env.PG_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function initializeDatabase(pool, env = process.env) {
  if (!pool) {
    throw new Error("DATABASE_URL não foi configurada para o banco PostgreSQL.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS xama_organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS xama_users (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES xama_organizations(id),
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, email)
    );
    CREATE TABLE IF NOT EXISTS xama_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES xama_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS xama_sessions_expiry_idx
      ON xama_sessions (expires_at);
    CREATE TABLE IF NOT EXISTS xama_login_attempts (
      ip_hash TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      reset_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS xama_login_attempts_reset_idx
      ON xama_login_attempts (reset_at);
    CREATE TABLE IF NOT EXISTS xama_app_state (
      organization_id TEXT PRIMARY KEY REFERENCES xama_organizations(id),
      state JSONB NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    "INSERT INTO xama_organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    ["xama", "Xama Mobilidade"],
  );

  const users = await pool.query(
    "SELECT COUNT(*)::int AS count FROM xama_users WHERE organization_id = $1",
    ["xama"],
  );
  if (users.rows[0].count === 0) {
    const email = String(env.INITIAL_ADMIN_EMAIL ?? "").trim().toLocaleLowerCase("en-US");
    const password = String(env.INITIAL_ADMIN_PASSWORD ?? "");
    if (Boolean(email) !== Boolean(password)) {
      throw new Error("Configure INITIAL_ADMIN_EMAIL e INITIAL_ADMIN_PASSWORD juntas para criar a conta administradora inicial.");
    }
    if (!email || password.length < 12) {
      throw new Error("O banco ainda não tem usuários. Configure INITIAL_ADMIN_EMAIL e uma INITIAL_ADMIN_PASSWORD com pelo menos 12 caracteres.");
    }
    const passwordHash = await hashPassword(password);
    await pool.query(
      `INSERT INTO xama_users (id, organization_id, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin')`,
      [randomUUID(), "xama", email, passwordHash],
    );
  }
}
