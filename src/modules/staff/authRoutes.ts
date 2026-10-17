import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.js";
import { env } from "../../config.js";
import { requireStaff, staffOf } from "./guard.js";
import { SESSION_COOKIE, SESSION_TTL_MS, login, logout } from "./session.js";

const Login = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200), warehouseId: z.string().uuid() });

export async function staffAuthRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  app.get("/v1/staff/warehouses", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async () =>
    (await db.query(`SELECT w.id, w.code, w.name, p.name AS "portName" FROM warehouse w JOIN port p ON p.id=w.port_id WHERE w.active ORDER BY w.name`)).rows);

  app.post("/v1/staff/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const b = Login.parse(req.body);
    const r = await login(db, b.email, b.password, b.warehouseId);
    reply.setCookie(SESSION_COOKIE, r.token, {
      httpOnly: true, sameSite: "strict", path: "/", secure: env.NODE_ENV === "production" || env.NODE_ENV === "staging",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return { staff: r.staff };
  });

  app.get("/v1/staff/me", { preHandler: requireStaff(db) }, async (req) => staffOf(req));

  app.post("/v1/staff/logout", { preHandler: requireStaff(db) }, async (req, reply) => {
    await logout(db, staffOf(req));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
