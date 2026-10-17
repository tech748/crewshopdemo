import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../../db/pool.js";
import { audit } from "./audit.js";
import { verifyPassword } from "./password.js";

export const SESSION_COOKIE = "crew_staff";
export const SESSION_TTL_MS = 12 * 3_600_000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64"); // equalise timing for unknown emails

export interface StaffContext { staffId: string; email: string; fullName: string; isOpsManager: boolean; warehouseId: string; sessionId: string }
export class AuthError extends Error {
  constructor(public status: 401 | 403 | 423, public code: string, message = code) { super(message); }
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function login(db: Db, email: string, password: string, warehouseId: string, now = new Date()) {
  const u = (await db.query(
    `SELECT id, email, full_name, password_hash, is_ops_manager, active, failed_logins, locked_until
       FROM staff_user WHERE lower(email)=lower($1)`, [email])).rows[0];
  if (u?.locked_until && u.locked_until > now) throw new AuthError(423, "account_locked");
  const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !u.active || !ok) {
    if (u) {
      const locked = u.failed_logins + 1 >= MAX_FAILS;
      await db.query(`UPDATE staff_user SET failed_logins=$2, locked_until=$3 WHERE id=$1`,
        [u.id, locked ? 0 : u.failed_logins + 1, locked ? new Date(now.getTime() + LOCK_MS) : null]);
      await audit(db, { actor: "system", entity: "staff_user", entityId: u.id, action: locked ? "login_locked" : "login_failed" });
    }
    throw new AuthError(401, "invalid_credentials");
  }
  // Warehouse is chosen at login and must be on the user's allow-list; the session is then locked to it.
  const wh = await db.query(
    `SELECT w.id FROM staff_warehouse sw JOIN warehouse w ON w.id=sw.warehouse_id
      WHERE sw.staff_id=$1 AND w.id=$2 AND w.active`, [u.id, warehouseId]);
  if (!wh.rowCount) throw new AuthError(403, "warehouse_not_allowed");

  const token = randomBytes(32).toString("base64url");
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  const s = await db.query(
    `INSERT INTO staff_session(token_hash,staff_id,warehouse_id,expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
    [sha(token), u.id, warehouseId, expires]);
  await db.query(`UPDATE staff_user SET failed_logins=0, locked_until=NULL WHERE id=$1`, [u.id]);
  await audit(db, { actor: "staff", actorId: u.id, entity: "staff_session", entityId: s.rows[0].id, action: "login", after: { warehouseId } });
  return { token, expires, staff: { id: u.id, email: u.email, fullName: u.full_name, isOpsManager: u.is_ops_manager, warehouseId } };
}

export async function resolveSession(db: Db, token: string, now = new Date()): Promise<StaffContext | null> {
  const r = await db.query(
    `SELECT s.id AS session_id, s.warehouse_id, u.id AS staff_id, u.email, u.full_name, u.is_ops_manager
       FROM staff_session s JOIN staff_user u ON u.id=s.staff_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 AND u.active`, [sha(token), now]);
  const x = r.rows[0];
  return x ? { staffId: x.staff_id, email: x.email, fullName: x.full_name, isOpsManager: x.is_ops_manager, warehouseId: x.warehouse_id, sessionId: x.session_id } : null;
}

export async function logout(db: Db, ctx: StaffContext) {
  await db.query(`UPDATE staff_session SET revoked_at=now() WHERE id=$1`, [ctx.sessionId]);
  await audit(db, { actor: "staff", actorId: ctx.staffId, entity: "staff_session", entityId: ctx.sessionId, action: "logout" });
}
