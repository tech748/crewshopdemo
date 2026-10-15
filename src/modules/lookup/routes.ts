import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/pool.js";
import { lookup } from "./service.js";

const Query = z.object({ surname: z.string().max(60).optional(), vesselImo: z.string().max(10).optional() });

export async function lookupRoutes(app: FastifyInstance, opts: { db: Db }) {
  app.get<{ Params: { code: string } }>(
    "/v1/lookup/:code",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => lookup(opts.db, req.params.code, Query.parse(req.query)),
  );
}
