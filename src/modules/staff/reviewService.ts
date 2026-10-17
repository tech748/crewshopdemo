import type pg from "pg";
import { normaliseCode } from "../../domain/codes.js";
import { IllegalTransition, nextOrderStatus, type OrderStatus } from "../../domain/stateMachine.js";
import { withTx } from "../../db/tx.js";
import { audit } from "./audit.js";
import { StaffOpError } from "./errors.js";
import type { StaffContext } from "./session.js";

export const MAX_RUSH_FEE_CENTS = 1_000_000; // R10,000 sanity cap on a typo

/** Orders inside the cut-off awaiting pricing, for this warehouse's port. No PII returned. */
export async function manualReviewQueue(pool: pg.Pool, ctx: StaffContext) {
  return (await pool.query(
    `SELECT o.public_code AS "orderCode", o.total_cents AS "totalCents", o.payment_method AS "paymentMethod", o.risk_flags AS "riskFlags",
            pc.eta, o.created_at AS "createdAt", (SELECT count(*)::int FROM parcel WHERE order_id=o.id) AS "parcelCount"
       FROM "order" o JOIN port_call pc ON pc.id=o.port_call_id JOIN warehouse w ON w.port_id=pc.port_id AND w.id=$1
      WHERE o.status='manual_review' ORDER BY pc.eta`, [ctx.warehouseId])).rows;
}

async function lockReviewOrder(c: pg.PoolClient, ctx: StaffContext, orderCode: string) {
  const code = normaliseCode(orderCode);
  if (!code) throw new StaffOpError(400, "invalid_code");
  const o = (await c.query(
    `SELECT o.id, o.status, o.payment_status, o.payment_method, o.total_cents, pc.port_id FROM tracking_alias a JOIN "order" o ON o.id=a.order_id
       LEFT JOIN port_call pc ON pc.id=o.port_call_id WHERE a.code_normalised=$1 AND a.type='order' FOR UPDATE OF o`, [code])).rows[0];
  const w = (await c.query(`SELECT port_id FROM warehouse WHERE id=$1`, [ctx.warehouseId])).rows[0];
  if (!o || (o.port_id && o.port_id !== w.port_id)) throw new StaffOpError(404, "order_not_found");
  return o as { id: string; status: OrderStatus; payment_status: string; payment_method: string | null; total_cents: number };
}

/** Approve a manual_review order with an optional rush fee. Blocked once any money has moved. */
export async function approveOrder(pool: pg.Pool, ctx: StaffContext, orderCode: string, rushFeeCents = 0) {
  if (!Number.isInteger(rushFeeCents) || rushFeeCents < 0 || rushFeeCents > MAX_RUSH_FEE_CENTS) throw new StaffOpError(400, "invalid_rush_fee");
  return withTx(pool, async (c) => {
    const o = await lockReviewOrder(c, ctx, orderCode);
    if (o.payment_status !== "unpaid" && o.payment_status !== "cod_pending") throw new StaffOpError(409, "already_paid", "Price cannot change after payment");
    let to: OrderStatus;
    try { to = nextOrderStatus(o.status, o.payment_method === "cod" ? "approve_manual_cod" : "approve_manual"); }
    catch (e) { if (e instanceof IllegalTransition) throw new StaffOpError(409, "not_in_review", `Order is ${o.status}`); throw e; }
    const total = o.total_cents + rushFeeCents;
    if (rushFeeCents > 0) {
      await c.query(`INSERT INTO order_line(order_id,description,amount_cents) VALUES ($1,'Rush fee (staff override)',$2)`, [o.id, rushFeeCents]);
    }
    await c.query(`UPDATE "order" SET status=$2, total_cents=$3, rush_fee_cents=$4, updated_at=now() WHERE id=$1`, [o.id, to, total, rushFeeCents]);
    await audit(c, { actor: "staff", actorId: ctx.staffId, entity: "order", entityId: o.id, action: "manual_review_approve",
      before: { status: o.status, totalCents: o.total_cents }, after: { status: to, totalCents: total, rushFeeCents } });
    await c.query(`INSERT INTO outbox_job(type,payload,dedupe_key) VALUES ('monday.order.upsert',$1,$2) ON CONFLICT (dedupe_key) DO NOTHING`,
      [JSON.stringify({ orderId: o.id }), `order-approve-${o.id}`]);
    return { orderCode: normaliseCode(orderCode)!, status: to, totalCents: total, rushFeeCents };
  });
}

export async function rejectOrder(pool: pg.Pool, ctx: StaffContext, orderCode: string, reason: string) {
  return withTx(pool, async (c) => {
    const o = await lockReviewOrder(c, ctx, orderCode);
    let to: OrderStatus;
    try { to = nextOrderStatus(o.status, "cancel"); }
    catch { throw new StaffOpError(409, "not_cancellable", `Order is ${o.status}`); }
    if (o.status !== "manual_review") throw new StaffOpError(409, "not_in_review", `Order is ${o.status}`);
    await c.query(`UPDATE "order" SET status=$2, updated_at=now() WHERE id=$1`, [o.id, to]);
    await audit(c, { actor: "staff", actorId: ctx.staffId, entity: "order", entityId: o.id, action: "manual_review_reject", before: { status: o.status }, after: { status: to, reason } });
    return { orderCode: normaliseCode(orderCode)!, status: to };
  });
}
