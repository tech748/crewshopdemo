import Fastify from "fastify";
import { env } from "./config.js";

export function buildServer() {
  const app = Fastify({ logger: env.NODE_ENV !== "test" });
  app.get("/health", async () => ({ ok: true }));
  return app;
}
if (process.argv[1]?.endsWith("server.ts")) {
  buildServer().listen({ port: env.PORT, host: "0.0.0.0" });
}
