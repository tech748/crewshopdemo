import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./config.js";
import { pool, type Db } from "./db/pool.js";
import { lookupRoutes } from "./modules/lookup/routes.js";

export async function buildServer(db: Db = pool) {
  const app = Fastify({ logger: env.NODE_ENV === "development" });
  await app.register(rateLimit, { global: false });
  app.get("/health", async () => ({ ok: true }));
  await app.register(lookupRoutes, { db });
  const demo = readFileSync(join(process.cwd(), "public", "demo.html"), "utf8");
  app.get("/demo", async (_req, reply) => reply.type("text/html").send(demo));
  return app;
}
if (process.argv[1]?.endsWith("server.ts")) {
  const app = await buildServer();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}
