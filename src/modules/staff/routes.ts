import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import type pg from "pg";
import { requireOpsManager, requireStaff, staffOf } from "./guard.js";
import { AuthError } from "./session.js";
import { StaffOpError } from "./errors.js";
import { staffAuthRoutes } from "./authRoutes.js";
import { matchParcel, receiveScan, unmatchedQueue } from "./intakeService.js";
import { approveOrder, manualReviewQueue, rejectOrder } from "./reviewService.js";
import { unlockHandover, verifyHandover } from "./handoverService.js";

const Scan = z.object({ clientScanId: z.string().min(8).max(64), code: z.string().min(1).max(60), weightKg: z.number().positive().max(999).optional(), bin: z.string().max(20).optional() });
const Match = z.object({ orderCode: z.string().min(1).max(20) });
const Approve = z.object({ rushFeeCents: z.number().int().min(0).max(1_000_000).optional() });
const Reject = z.object({ reason: z.string().min(1).max(200) });
const Handover = z.object({ orderCode: z.string().min(1).max(20), code: z.string().length(6), codCollected: z.boolean().optional() });

export async function staffRoutes(app: FastifyInstance, opts: { db: pg.Pool }) {
  const { db } = opts;
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: "validation", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    if (err instanceof AuthError) return reply.code(err.status).send({ code: err.code });
    if (err instanceof StaffOpError) return reply.code(err.status).send({ code: err.code, message: err.message, ...err.extra });
    if ((err as { statusCode?: number }).statusCode === 429) return reply.code(429).send({ code: "rate_limited" });
    app.log.error(err); return reply.code(500).send({ code: "internal" });
  });
  await app.register(staffAuthRoutes, { db });

  const auth = { preHandler: requireStaff(db) };
  const ops = { preHandler: [requireStaff(db), requireOpsManager] };
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });

  // Receiving
  app.post("/v1/staff/intake", { ...auth, config: limit(120) }, async (req, reply) => {
    const r = await receiveScan(db, staffOf(req), Scan.parse(req.body));
    return reply.code(r.replay ? 200 : 201).send(r);
  });
  app.get("/v1/staff/unmatched", auth, async (req) => unmatchedQueue(db, staffOf(req)));
  app.post<{ Params: { id: string } }>("/v1/staff/unmatched/:id/match", { ...auth, config: limit(60) }, async (req) =>
    matchParcel(db, staffOf(req), z.string().uuid().parse(req.params.id), Match.parse(req.body).orderCode));

  // Manual review (cut-off pricing) - Ops Manager only to mutate
  app.get("/v1/staff/manual-review", auth, async (req) => manualReviewQueue(db, staffOf(req)));
  app.post<{ Params: { code: string } }>("/v1/staff/orders/:code/approve", { ...ops, config: limit(30) }, async (req) =>
    approveOrder(db, staffOf(req), req.params.code, Approve.parse(req.body ?? {}).rushFeeCents ?? 0));
  app.post<{ Params: { code: string } }>("/v1/staff/orders/:code/reject", { ...ops, config: limit(30) }, async (req) =>
    rejectOrder(db, staffOf(req), req.params.code, Reject.parse(req.body).reason));

  // Gangway handover
  app.post("/v1/staff/handover", { ...auth, config: limit(30) }, async (req) => verifyHandover(db, staffOf(req), Handover.parse(req.body)));
  app.post<{ Params: { code: string } }>("/v1/staff/handover/:code/unlock", { ...ops, config: limit(10) }, async (req) =>
    unlockHandover(db, staffOf(req), req.params.code));
}
