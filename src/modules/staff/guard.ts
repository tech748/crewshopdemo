import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../../db/pool.js";
import { AuthError, SESSION_COOKIE, resolveSession, type StaffContext } from "./session.js";

declare module "fastify" { interface FastifyRequest { staff?: StaffContext } }

export const requireStaff = (db: Db) => async (req: FastifyRequest, _reply: FastifyReply) => {
  const token = req.cookies[SESSION_COOKIE];
  const ctx = token ? await resolveSession(db, token) : null;
  if (!ctx) throw new AuthError(401, "unauthenticated");
  req.staff = ctx;
};
export const requireOpsManager = async (req: FastifyRequest) => {
  if (!req.staff?.isOpsManager) throw new AuthError(403, "ops_manager_required");
};
/** Non-null accessor for handlers that run after requireStaff. */
export const staffOf = (req: FastifyRequest): StaffContext => {
  if (!req.staff) throw new AuthError(401, "unauthenticated");
  return req.staff;
};
