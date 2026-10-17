import type pg from "pg";
import { normaliseCode } from "../../domain/codes.js";
import { nextParcelStatus, type ParcelStatus } from "../../domain/stateMachine.js";
import { withTx } from "../../db/tx.js";
import { audit } from "./audit.js";
import { StaffOpError } from "./errors.js";
import type { StaffContext } from "./session.js";

export type ScanResult = "received" | "already_received" | "unmatched" | "ambiguous";
export interface ScanOutcome {
  result: ScanResult; parcelId: string | null; replay: boolean;
  linked?: boolean; orderCode?: string | null; portMismatch?: boolean;
}
export interface ScanInput { clientScanId: string; code: string; weightKg?: number; bin?: string }

const HERE = new Set(["received", "ready", "out_for_delivery", "delivered"]);

async function previous(db: pg.Pool | pg.PoolClient, id: string): Promise<ScanOutcome | null> {
  const r = await db.query(`SELECT result, parcel_id FROM intake_scan WHERE client_scan_id=$1`, [id]);
  return r.rowCount ? { result: r.rows[0].result, parcelId: r.rows[0].parcel_id, replay: true } : null;
}

/** Receive (or create-as-unmatched) a parcel at the staff member's warehouse. Idempotent on clientScanId. */
export async function receiveScan(pool: pg.Pool, ctx: StaffContext, input: ScanInput): Promise<ScanOutcome> {
  const code = normaliseCode(input.code);
  if (!code) throw new StaffOpError(400, "invalid_code");
  const seen = await previous(pool, input.clientScanId);
  if (seen) return seen;
  try {
    return await withTx(pool, async (c) => {
      const hits = (await c.query(
        `SELECT DISTINCT p.id, p.status, p.order_id FROM tracking_alias a JOIN parcel p ON p.id=a.parcel_id
          WHERE a.code_normalised=$1 AND a.type IN ('carrier','declared')`, [code])).rows as { id: string; status: ParcelStatus; order_id: string | null }[];
      let out: ScanOutcome;
      if (hits.length > 1) {
        out = { result: "ambiguous", parcelId: null, replay: false }; // staff resolve by hand; nothing is mutated
      } else if (hits.length === 0) {
        const id = (await c.query(
          `INSERT INTO parcel(status,received_at,warehouse_id,weight_kg,bin) VALUES ('received',now(),$1,$2,$3) RETURNING id`,
          [ctx.warehouseId, input.weightKg ?? null, input.bin ?? null])).rows[0].id;
        await c.query(`INSERT INTO tracking_alias(code_normalised,type,parcel_id) VALUES ($1,'carrier',$2)`, [code, id]);
        out = { result: "unmatched", parcelId: id, replay: false, linked: false, orderCode: null };
      } else {
        const p = hits[0]!;
        await c.query(`SELECT 1 FROM parcel WHERE id=$1 FOR UPDATE`, [p.id]);
        if (HERE.has(p.status)) {
          out = { result: "already_received", parcelId: p.id, replay: false, linked: !!p.order_id };
        } else {
          let to: ParcelStatus;
          try { to = nextParcelStatus(p.status, "receive"); }
          catch { throw new StaffOpError(409, "illegal_parcel_state", `Parcel is ${p.status}; resolve the exception first`); }
          await c.query(
            `UPDATE parcel SET status=$2, received_at=now(), warehouse_id=$3, weight_kg=COALESCE($4,weight_kg), bin=COALESCE($5,bin), updated_at=now() WHERE id=$1`,
            [p.id, to, ctx.warehouseId, input.weightKg ?? null, input.bin ?? null]);
          out = { result: "received", parcelId: p.id, replay: false, linked: !!p.order_id };
        }
        if (p.order_id) {
          const o = (await c.query(
            `SELECT o.public_code, pt.id AS port_id FROM "order" o LEFT JOIN port_call pc ON pc.id=o.port_call_id LEFT JOIN port pt ON pt.id=pc.port_id WHERE o.id=$1`, [p.order_id])).rows[0];
          const w = (await c.query(`SELECT port_id FROM warehouse WHERE id=$1`, [ctx.warehouseId])).rows[0];
          out.orderCode = o.public_code; out.portMismatch = !!o.port_id && o.port_id !== w.port_id; // parcel at the wrong port's hub
        }
      }
      await c.query(`INSERT INTO intake_scan(client_scan_id,warehouse_id,staff_id,code_normalised,parcel_id,result) VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.clientScanId, ctx.warehouseId, ctx.staffId, code, out.parcelId, out.result]);
      if (out.parcelId && out.result !== "already_received") {
        await audit(c, { actor: "staff", actorId: ctx.staffId, entity: "parcel", entityId: out.parcelId, action: `intake_${out.result}`, after: { warehouseId: ctx.warehouseId } });
        await c.query(`INSERT INTO outbox_job(type,payload,dedupe_key) VALUES ('monday.parcel.upsert',$1,$2) ON CONFLICT (dedupe_key) DO NOTHING`,
          [JSON.stringify({ parcelId: out.parcelId }), `parcel-intake-${out.parcelId}`]);
      }
      return out;
    });
  } catch (e: any) {
    if (e?.code === "23505") { const s = await previous(pool, input.clientScanId); if (s) return s; } // concurrent retry of same scan
    throw e;
  }
}

export async function unmatchedQueue(pool: pg.Pool, ctx: StaffContext) {
  const r = await pool.query(
    `SELECT p.id, p.status, p.received_at AS "receivedAt", p.weight_kg AS "weightKg", p.bin, p.label_name AS "labelName",
            COALESCE(array_agg(a.code_normalised) FILTER (WHERE a.id IS NOT NULL), '{}') AS codes,
            floor(extract(epoch FROM now()-p.received_at)/3600)::int AS "ageHours"
       FROM parcel p LEFT JOIN tracking_alias a ON a.parcel_id=p.id AND a.type IN ('carrier','declared')
      WHERE p.order_id IS NULL AND p.warehouse_id=$1 AND p.status IN ('received','ready')
      GROUP BY p.id ORDER BY p.received_at`, [ctx.warehouseId]);
  return r.rows;
}

/** Link an unmatched parcel in this warehouse to an order (same port only). */
export async function matchParcel(pool: pg.Pool, ctx: StaffContext, parcelId: string, orderCode: string) {
  const oc = normaliseCode(orderCode);
  if (!oc) throw new StaffOpError(400, "invalid_code");
  return withTx(pool, async (c) => {
    const p = (await c.query(`SELECT id FROM parcel WHERE id=$1 AND order_id IS NULL AND warehouse_id=$2 FOR UPDATE`, [parcelId, ctx.warehouseId])).rows[0];
    if (!p) throw new StaffOpError(404, "parcel_not_in_queue");
    const o = (await c.query(
      `SELECT o.id, o.status, pc.port_id FROM tracking_alias a JOIN "order" o ON o.id=a.order_id LEFT JOIN port_call pc ON pc.id=o.port_call_id
        WHERE a.code_normalised=$1 AND a.type='order' FOR UPDATE OF o`, [oc])).rows[0];
    if (!o) throw new StaffOpError(404, "order_not_found");
    if (["cancelled", "refunded", "completed"].includes(o.status)) throw new StaffOpError(409, "order_closed");
    const w = (await c.query(`SELECT port_id FROM warehouse WHERE id=$1`, [ctx.warehouseId])).rows[0];
    if (o.port_id && o.port_id !== w.port_id) throw new StaffOpError(409, "port_mismatch", "Order is for a different port");
    await c.query(`UPDATE parcel SET order_id=$2, updated_at=now() WHERE id=$1`, [parcelId, o.id]);
    await audit(c, { actor: "staff", actorId: ctx.staffId, entity: "parcel", entityId: parcelId, action: "manual_match", before: { orderId: null }, after: { orderId: o.id } });
    await c.query(`INSERT INTO outbox_job(type,payload,dedupe_key) VALUES ('monday.parcel.upsert',$1,$2) ON CONFLICT (dedupe_key) DO NOTHING`,
      [JSON.stringify({ parcelId }), `parcel-match-${parcelId}-${o.id}`]);
    return { parcelId, orderCode: oc };
  });
}
