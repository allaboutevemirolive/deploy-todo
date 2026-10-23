import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { config } from "./config.js";

interface Todo {
  id: number;
  title: string;
  done: boolean;
  created_at: string;
}

const idParams = {
  type: "object",
  properties: { id: { type: "integer", minimum: 1 } },
  required: ["id"],
} as const;

export function buildApp(pool: pg.Pool): FastifyInstance {
  const app = Fastify({ logger: true });

  // Health check: used by Docker, by the smoke test and by you.
  // It touches the database, so "ok" means the whole chain works.
  app.get("/api/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok", version: config.version };
    } catch {
      return reply.code(503).send({ status: "database unavailable" });
    }
  });

  app.get("/api/todos", async () => {
    const { rows } = await pool.query<Todo>(
      "SELECT id, title, done, created_at FROM todos ORDER BY id",
    );
    return rows;
  });

  app.post<{ Body: { title: string } }>(
    "/api/todos",
    {
      schema: {
        body: {
          type: "object",
          properties: { title: { type: "string", minLength: 1, maxLength: 200 } },
          required: ["title"],
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { rows } = await pool.query<Todo>(
        "INSERT INTO todos (title) VALUES ($1) RETURNING id, title, done, created_at",
        [req.body.title.trim()],
      );
      return reply.code(201).send(rows[0]);
    },
  );

  app.patch<{ Params: { id: number }; Body: { done?: boolean; title?: string } }>(
    "/api/todos/:id",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          properties: {
            done: { type: "boolean" },
            title: { type: "string", minLength: 1, maxLength: 200 },
          },
          additionalProperties: false,
          minProperties: 1,
        },
      },
    },
    async (req, reply) => {
      // COALESCE keeps the existing value when a field is not sent.
      const { rows } = await pool.query<Todo>(
        `UPDATE todos
            SET done  = COALESCE($2, done),
                title = COALESCE($3, title)
          WHERE id = $1
      RETURNING id, title, done, created_at`,
        [req.params.id, req.body.done ?? null, req.body.title?.trim() ?? null],
      );
      if (rows.length === 0) return reply.code(404).send({ error: "Todo not found" });
      return rows[0];
    },
  );

  app.delete<{ Params: { id: number } }>(
    "/api/todos/:id",
    { schema: { params: idParams } },
    async (req, reply) => {
      const result = await pool.query("DELETE FROM todos WHERE id = $1", [req.params.id]);
      if (result.rowCount === 0) return reply.code(404).send({ error: "Todo not found" });
      return reply.code(204).send();
    },
  );

  return app;
}
