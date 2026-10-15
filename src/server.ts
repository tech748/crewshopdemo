import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./config.js";
import type pg from "pg";
import { pool } from "./db/pool.js";
import { lookupRoutes } from "./modules/lookup/routes.js";
import { bookingRoutes } from "./modules/booking/routes.js";

export async function buildServer(db: pg.Pool = pool) {
  const app = Fastify({ logger: env.NODE_ENV === "development" });
  await app.register(rateLimit, { global: false });
  app.get("/health", async () => ({ ok: true }));
  await app.register(lookupRoutes, { db });
  await app.register(bookingRoutes, { db });
  const demo = readFileSync(join(process.cwd(), "public", "demo.html"), "utf8");
  app.get("/demo", async (_req, reply) => reply.type("text/html").send(demo));
  const book = readFileSync(join(process.cwd(), "public", "book.html"), "utf8");
  app.get("/book", async (_req, reply) => reply.type("text/html").send(book));
  return app;
}
if (process.argv[1]?.match(/server\.(ts|js)$/)) {
  const app = await buildServer();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}
