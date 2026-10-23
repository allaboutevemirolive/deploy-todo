// All configuration comes from environment variables (the "12-factor" way).
// The same image runs on your laptop, in CI and on the server; only the
// environment changes.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Listen on all interfaces so the container is reachable from other
  // containers. (127.0.0.1 would only be reachable from inside itself.)
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: required("DATABASE_URL"),
  // Which commit this build came from. CI bakes it into the image, so the
  // health endpoint can prove which version is actually running.
  version: process.env.APP_VERSION ?? "dev",
};
