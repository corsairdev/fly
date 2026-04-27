import pg from "pg";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Creates tables the control server owns directly.
// The corsair SDK tables (corsair_permissions, corsair_integrations, etc.)
// are created by the runtime on its first startup via the SDK's own init.
export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_api_keys (
      id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      name         VARCHAR(100) NOT NULL,
      client_id    TEXT NOT NULL UNIQUE,
      key_hash     TEXT NOT NULL UNIQUE,
      key_prefix   TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );
  `);
}
