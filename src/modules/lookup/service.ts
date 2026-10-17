import type { Db } from "../../db/pool.js";
import { business } from "../../config.js";
import { normaliseCode } from "../../domain/codes.js";
import type { LookupResult, OrderFacts, PaymentInfo } from "./types.js";

export type { LookupResult } from "./types.js";

const IN_WAREHOUSE = new Set(["received", "ready", "out_for_delivery", "delivered"]);
const PAID = new Set(["paid", "cod_collected", "credited"]);

interface ParcelRow { parcel_id: string; status: string; order_id: string | null; label_name: string | null }
interface OrderRow {
  id: string; public_code: string; arrival_risk: string | null; status: string; payment_status: string;
  total_cents: number; currency: string; port_name: string | null; eta: Date | null;
}

const ORDER_SELECT = `SELECT o.id, o.public_code, o.arrival_risk, o.status, o.payment_status, o.total_cents, o.currency,
    pt.name AS port_name, pc.eta
  FROM "order" o LEFT JOIN port_call pc ON pc.id=o.port_call_id LEFT JOIN port pt ON pt.id=pc.port_id`;

function paymentInfo(o: OrderRow): PaymentInfo {
  const base = { totalCents: o.total_cents, currency: o.currency };
  if (PAID.has(o.payment_status)) return { ...base, status: "paid", options: [], awaitingStaffPricing: false };
  // Price is not final until staff approve a manual_review order: never offer a pay link before that.
  if (o.status === "manual_review") return { ...base, status: "unpaid", options: [], awaitingStaffPricing: true };
  return { ...base, status: "unpaid", awaitingStaffPricing: false, options: [{ type: "card", url: null }, { type: "cod" }] };
}
const facts = (o: OrderRow): OrderFacts => ({
  orderCode: o.public_code, portName: o.port_name, deliveryDate: o.eta ? o.eta.toISOString().slice(0, 10) : null,
  arrivalRisk: o.arrival_risk, payment: paymentInfo(o),
});

export async function lookup(db: Db, raw: string, second?: { surname?: string; vesselImo?: string }): Promise<LookupResult> {
  const code = normaliseCode(raw);
  if (!code) return { kind: "invalid_code" };
  const bookUrl = `/book?code=${code}`;

  // Our own order code
  const ord = await db.query<OrderRow>(
    `${ORDER_SELECT} JOIN tracking_alias a ON a.order_id=o.id WHERE a.code_normalised=$1 AND a.type='order' LIMIT 1`, [code]);
  if (ord.rowCount) {
    const o = ord.rows[0]!;
    const ps = await db.query(`SELECT status FROM parcel WHERE order_id=$1 ORDER BY created_at`, [o.id]);
    return { kind: "order_summary", ...facts(o), parcels: ps.rows.map((r) => ({ status: r.status })) };
  }

  // Carrier / declared / warehouse-tag parcel code
  const hits = await db.query<ParcelRow>(
    `SELECT DISTINCT p.id AS parcel_id, p.status, p.order_id, p.label_name
       FROM tracking_alias a JOIN parcel p ON p.id=a.parcel_id
      WHERE a.code_normalised=$1 AND a.type IN ('carrier','declared')`, [code]);
  let rows = hits.rows;
  if (rows.length === 0) return { kind: "no_record", bookUrl, baseCents: business.pricePerParcelCents };

  if (rows.length > 1) { // carrier numbers can collide: disambiguate by surname, never reveal the candidates
    const s = second?.surname?.trim().toLowerCase();
    if (s) rows = rows.filter((r) => r.label_name?.toLowerCase().includes(s));
    if (rows.length !== 1) return { kind: "needs_second_factor" };
  }
  const p = rows[0]!;
  const here = IN_WAREHOUSE.has(p.status);
  if (!p.order_id) {
    return here
      ? { kind: "in_warehouse_unlinked", bookUrl, prefill: { parcelCodes: [code] }, baseCents: business.pricePerParcelCents }
      : { kind: "no_record", bookUrl, baseCents: business.pricePerParcelCents }; // declared-but-unbooked behaves as no record
  }
  const o = (await db.query<OrderRow>(`${ORDER_SELECT} WHERE o.id=$1`, [p.order_id])).rows[0]!;
  const f = facts(o);
  const paid = f.payment.status === "paid";
  return { kind: here ? (paid ? "in_warehouse_paid" : "in_warehouse_unpaid") : (paid ? "in_transit_paid" : "in_transit_unpaid"), ...f };
}
