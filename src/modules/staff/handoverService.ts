import { timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { generateHandoverCode, normaliseCode } from "../../domain/codes.js";
import { nextOrderStatus, nextParcelStatus, type ParcelStatus } from "../../domain/stateMachine.js";
import { withTx } from "../../db/tx.js";
import { decryptPii, encryptPii, hashPii } from "../../security/pii.js";
import { audit } from "./audit.js";
import { StaffOpError } from "./errors.js";
import type { StaffContext } from "./session.js";

export const MAX_HANDOVER_ATTEMPTS = 5;
const DELIVERABLE = new Set(["received", "ready", "out_for_delivery"]);

/**
 * Issue the 6-digit gangway code for a CONFIRMED order (idempotent: returns the same code if already issued).
 * Must be called from the confirm transition (payment webhook in M7 / COD verification in M6).
 * Verification copy is a keyed hash; the display copy is encrypted so the recipient's phone can show it.
 */
export async function issueHandoverCode(db: Pick<pg.Pool, "query">, orderId: string): Promise<string> {
  const r = await db.query(`SELECT status, handover_code_enc FROM "order" WHERE id=$1`, [orderId]);
  const o = r.rows[0];
  if (!o) throw new StaffOpError(404, "order_not_found");
  if (o.status !== "confirmed") throw new StaffOpError(409, "order_not_confirmed");
  if (o.handover_code_enc) return decryptPii(o.handover_code_enc);
  const code = generateHandoverCode();
  await db.query(`UPDATE "order" SET handover_code_hash=$2, handover_code_enc=$3, updated_at=now() WHERE id=$1 AND handover_code_enc IS NULL`,
    [orderId, hashPii(`handover:${orderId}:${code}`), encryptPii(code)]);
  const again = (await db.query(`SELECT handover_code_enc FROM "order" WHERE id=$1`, [orderId])).rows[0];
  return decryptPii(again.handover_code_enc);
}

export interface HandoverInput { orderCode: string; code: string; codCollected?: boolean }

/**
 * Driver/gangway verification. The code is checked against ONE order only (never searched globally),
 * failures are counted under a row lock, and the order locks after MAX_HANDOVER_ATTEMPTS.
 */
export async function verifyHandover(pool: pg.Pool, ctx: StaffContext, input: HandoverInput) {
  const oc = normaliseCode(input.orderCode);
  if (!oc || !/^\d{6}$/.test(input.code)) throw new StaffOpError(400, "invalid_input");
  const fail: { err: StaffOpError | null } = { err: null };

  const result = await withTx(pool, async (c) => {
    const o = (await c.query(
      `SELECT o.* FROM tracking_alias a JOIN "order" o ON o.id=a.order_id WHERE a.code_normalised=$1 AND a.type='order' FOR UPDATE OF o`, [oc])).rows[0];
    if (!o) throw new StaffOpError(404, "order_not_found");
    if (o.handover_locked_at) throw new StaffOpError(423, "handover_locked", "Too many wrong codes; an Ops Manager must unlock");
    if (o.status !== "confirmed") throw new StaffOpError(409, "order_not_confirmed", "No parcel leaves without a confirmed order");
    if (!o.handover_code_hash) throw new StaffOpError(409, "no_handover_code");

    const parcels = (await c.query(`SELECT id, status, warehouse_id FROM parcel WHERE order_id=$1 FOR UPDATE`, [o.id])).rows as
      { id: string; status: ParcelStatus; warehouse_id: string | null }[];
    if (!parcels.length || parcels.some((p) => !DELIVERABLE.has(p.status) || p.warehouse_id !== ctx.warehouseId))
      throw new StaffOpError(409, "parcels_not_ready", "All parcels must be received at this warehouse", { parcelCount: parcels.length });

    const want = Buffer.from(o.handover_code_hash), got = Buffer.from(hashPii(`handover:${o.id}:${input.code}`));
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      const n = o.handover_failed_attempts + 1, lock = n >= MAX_HANDOVER_ATTEMPTS;
      await c.query(`UPDATE "order" SET handover_failed_attempts=$2, handover_locked_at=$3 WHERE id=$1`, [o.id, n, lock ? new Date() : null]);
      await audit(c, { actor: "staff", actorId: ctx.staffId, entity: "order", entityId: o.id, action: lock ? "handover_locked" : "handover_code_failed", after: { attempts: n, warehouseId: ctx.warehouseId } });
      fail.err = new StaffOpError(lock ? 423 : 409, lock ? "handover_locked" : "wrong_code", lock ? "Too many wrong codes" : "Wrong code", { attemptsLeft: Math.max(0, MAX_HANDOVER_ATTEMPTS - n) });
      return null; // commit the counter, then throw
    }

    const cod = o.payment_method === "cod" && o.payment_status === "cod_pending";
    if (cod && !input.codCollected) {
      await c.query(`UPDATE "order" SET handover_failed_attempts=0 WHERE id=$1`, [o.id]);
      await audit(c, { actor: "staff", actorId: ctx.staffId, entity: "order", entityId: o.id, action: "handover_code_verified_cod_due", after: { amountDueCents: o.total_cents } });
      fail.err = new StaffOpError(409, "cod_collection_required", "Collect payment, then confirm", { amountDueCents: o.total_cents, currency: o.currency });
      return null;
    }
    if (cod) {
      await c.query(`INSERT INTO payment(order_id,provider,provider_ref,amount_cents,currency,status,event_hash) VALUES ($1,'cod',$2,$3,$4,'collected',$5)`,
        [o.id, ctx.staffId, o.total_cents, o.currency, `cod-${o.id}`]);
      await c.query(`UPDATE "order" SET payment_status='cod_collected' WHERE id=$1`, [o.id]);
    }
    for (const p of parcels) { // walk the state machine so each hop is validated
      let s = p.status;
      for (const ev of ["mark_ready", "dispatch", "deliver"] as const) {
        try { s = nextParcelStatus(s, ev); } catch { /* already past this hop */ }
      }
      await c.query(`UPDATE parcel SET status=$2, updated_at=now() WHERE id=$1`, [p.id, s]);
    }
    const done = nextOrderStatus("confirmed", "complete");
    await c.query(`UPDATE "order" SET status=$2, handover_failed_attempts=0, updated_at=now() WHERE id=$1`, [o.id, done]);
    await c.query(`UPDATE delivery_booking SET delivered_at=now(), handover_confirmed_at=now() WHERE order_id=$1`, [o.id]);
    await audit(c, { actor: "staff", actorId: ctx.staffId, entity: "order", entityId: o.id, action: "handover_complete",
      after: { warehouseId: ctx.warehouseId, parcels: parcels.length, codCollectedCents: cod ? o.total_cents : 0 } });
    await c.query(`INSERT INTO outbox_job(type,payload,dedupe_key) VALUES ('monday.order.upsert',$1,$2) ON CONFLICT (dedupe_key) DO NOTHING`,
      [JSON.stringify({ orderId: o.id }), `order-complete-${o.id}`]);
    return { orderCode: oc, status: done, parcelsDelivered: parcels.length, codCollectedCents: cod ? (o.total_cents as number) : 0 };
  });
  if (fail.err) throw fail.err;
  return result!;
}

export async function unlockHandover(pool: pg.Pool, ctx: StaffContext, orderCode: string) {
  const oc = normaliseCode(orderCode);
  if (!oc) throw new StaffOpError(400, "invalid_code");
  return withTx(pool, async (c) => {
    const o = (await c.query(`SELECT o.id FROM tracking_alias a JOIN "order" o ON o.id=a.order_id WHERE a.code_normalised=$1 AND a.type='order' FOR UPDATE OF o`, [oc])).rows[0];
    if (!o) throw new StaffOpError(404, "order_not_found");
    await c.query(`UPDATE "order" SET handover_failed_attempts=0, handover_locked_at=NULL WHERE id=$1`, [o.id]);
    await audit(c, { actor: "staff", actorId: ctx.staffId, entity: "order", entityId: o.id, action: "handover_unlock" });
    return { orderCode: oc, unlocked: true };
  });
}
