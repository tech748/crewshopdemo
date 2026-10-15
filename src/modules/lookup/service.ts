import type { Db } from "../../db/pool.js";
import { normaliseCode } from "../../domain/codes.js";

export type Outcome =
  | "order" | "attached_received" | "attached_expected"
  | "unattached_received" | "unknown" | "needs_second_factor" | "invalid_code";

export interface LookupResult {
  outcome: Outcome;
  orderCode?: string;
  parcelStatus?: string;
  portName?: string;
  arrivalRisk?: string | null;
  parcels?: { status: string }[];
  nextAction: { type: "none" | "book_form" | "declare_form" | "second_factor"; url?: string };
}
const RECEIVED = new Set(["received", "ready", "out_for_delivery", "delivered"]);

interface Row { parcel_id: string; status: string; order_id: string | null; label_name: string | null; label_vessel: string | null }

export async function lookup(db: Db, raw: string, second?: { surname?: string; vesselImo?: string }): Promise<LookupResult> {
  const code = normaliseCode(raw);
  if (!code) return { outcome: "invalid_code", nextAction: { type: "none" } };

  // Our own order code
  const ord = await db.query(
    `SELECT o.id, o.public_code, o.arrival_risk, pt.name AS port_name
       FROM tracking_alias a JOIN "order" o ON o.id=a.order_id
       LEFT JOIN port_call pc ON pc.id=o.port_call_id LEFT JOIN port pt ON pt.id=pc.port_id
      WHERE a.code_normalised=$1 AND a.type='order' LIMIT 1`, [code]);
  if (ord.rowCount) {
    const o = ord.rows[0];
    const ps = await db.query(`SELECT status FROM parcel WHERE order_id=$1 ORDER BY created_at`, [o.id]);
    return { outcome: "order", orderCode: o.public_code, portName: o.port_name ?? undefined, arrivalRisk: o.arrival_risk,
      parcels: ps.rows.map((r) => ({ status: r.status })), nextAction: { type: "none" } };
  }

  // Carrier / declared parcel code
  const hits = await db.query<Row>(
    `SELECT DISTINCT p.id AS parcel_id, p.status, p.order_id, p.label_name, p.label_vessel
       FROM tracking_alias a JOIN parcel p ON p.id=a.parcel_id
      WHERE a.code_normalised=$1 AND a.type IN ('carrier','declared')`, [code]);
  let rows = hits.rows;
  if (rows.length === 0) return { outcome: "unknown", nextAction: { type: "declare_form", url: `/book?code=${code}` } };

  if (rows.length > 1) {
    const s = second?.surname?.trim().toLowerCase();
    if (s) rows = rows.filter((r) => r.label_name?.toLowerCase().includes(s));
    if (rows.length !== 1) return { outcome: "needs_second_factor", nextAction: { type: "second_factor" } };
  }
  const p = rows[0]!;
  if (!p.order_id) {
    return RECEIVED.has(p.status)
      ? { outcome: "unattached_received", parcelStatus: p.status, nextAction: { type: "book_form", url: `/book?code=${code}` } }
      : { outcome: "unknown", nextAction: { type: "declare_form", url: `/book?code=${code}` } };
  }
  const o = await db.query(
    `SELECT o.public_code, o.arrival_risk, pt.name AS port_name FROM "order" o
       LEFT JOIN port_call pc ON pc.id=o.port_call_id LEFT JOIN port pt ON pt.id=pc.port_id WHERE o.id=$1`, [p.order_id]);
  const r = o.rows[0];
  return {
    outcome: RECEIVED.has(p.status) ? "attached_received" : "attached_expected",
    orderCode: r.public_code, parcelStatus: p.status, portName: r.port_name ?? undefined,
    arrivalRisk: r.arrival_risk, nextAction: { type: "none" },
  };
}
