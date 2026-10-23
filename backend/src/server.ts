import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createPool, migrate } from "./db.js";

const pool = createPool(config.databaseUrl);
await migrate(pool);

const app = buildApp(pool);

// Docker stops containers with SIGTERM. Close cleanly so in-flight requests
// finish and database connections are released.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
