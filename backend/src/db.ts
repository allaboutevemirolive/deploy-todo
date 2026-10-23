import pg from "pg";

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

// A real project would use a migration tool (node-pg-migrate, Drizzle, Prisma...).
// For this walkthrough one idempotent statement is enough, and it keeps the
// deployment story simple: the app prepares its own table on startup.
export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
      done       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}
