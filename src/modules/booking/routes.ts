import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type pg from "pg";
import { BookingCreate, QuoteRequest } from "./schema.js";
import { BookingError, createBooking, quote } from "./service.js";

export async function bookingRoutes(app: FastifyInstance, opts: { db: pg.Pool }) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: "validation", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    if (err instanceof BookingError) return reply.code(err.status).send({ code: err.code, message: err.message });
    if ((err as any).statusCode === 429) return reply.code(429).send({ code: "rate_limited" });
    app.log.error(err); return reply.code(500).send({ code: "internal" });
  });
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

  app.get("/v1/ports", async () =>
    (await opts.db.query(`SELECT code, name, cutoff_hours AS "cutoffHours" FROM port WHERE active ORDER BY name`)).rows);

  app.post("/v1/quotes", limit(30), async (req) => quote(opts.db, QuoteRequest.parse(req.body)));

  app.post("/v1/bookings", limit(10), async (req, reply) => {
    const r = await createBooking(opts.db, BookingCreate.parse(req.body));
    return reply.code(r.outcome === "outside_cutoff" ? 409 : 201).send(r);
  });
}
