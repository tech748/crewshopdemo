import type pg from "pg";
import type { Db } from "../../db/pool.js";
import { business, env } from "../../config.js";
import { generateOrderCode } from "../../domain/codes.js";
import { withinCutoffWindow, whatsappHandoffUrl } from "../../domain/cutoff.js";
import { nextOrderStatus, type OrderStatus } from "../../domain/stateMachine.js";
import { arrivalRisk } from "../../domain/arrivalRisk.js";
import { codRiskFlags } from "../../domain/codRisk.js";
import { encryptPii, hashPii } from "../../security/pii.js";
import { computeQuote, loadActiveRules, type Quote } from "../pricing/engine.js";
import type { BookingCreateInput, QuoteRequestInput } from "./schema.js";

export class BookingError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface QuoteResult extends Quote {
  withinCutoff: boolean; cutoffHours: number; portName: string; handoffUrl: string | null; indicative: null;
}

async function getPort(db: Db, code: string) {
  const r = await db.query(`SELECT id, name, cutoff_hours, handling_buffer_hours FROM port WHERE code=$1 AND active`, [code.toUpperCase()]);
  if (!r.rowCount) throw new BookingError(404, "port_not_found", "Unknown or inactive port");
  return r.rows[0] as { id: string; name: string; cutoff_hours: number; handling_buffer_hours: number };
}
const handoffText = (codes: string[], port: string, eta: Date) =>
  `Hi, I'd like to book delivery for parcel(s) ${codes.join(", ")} to ${port}, ship ETA ${eta.toISOString().slice(0, 10)}. (Inside the online cut-off.)`;

export async function quote(db: Db, req: QuoteRequestInput, now = new Date()): Promise<QuoteResult> {
  const port = await getPort(db, req.portCode);
  const q = computeQuote(await loadActiveRules(db, now), req.parcelCodes.length, req.promoCode);
  const ok = withinCutoffWindow(now, req.eta, port.cutoff_hours);
  return { ...q, withinCutoff: ok, cutoffHours: port.cutoff_hours, portName: port.name, indicative: null,
    handoffUrl: ok ? null : whatsappHandoffUrl(env.WHATSAPP_NUMBER, handoffText(req.parcelCodes, port.name, req.eta)) };
}

async function upsertPerson(c: pg.PoolClient, p: { fullName: string; phone: string; email?: string }): Promise<string> {
  const r = await c.query(
    `INSERT INTO person(phone_enc, phone_hash, full_name_enc, email_enc) VALUES ($1,$2,$3,$4)
     ON CONFLICT (phone_hash) DO UPDATE SET full_name_enc=EXCLUDED.full_name_enc,
       email_enc=COALESCE(EXCLUDED.email_enc, person.email_enc), erased_at=NULL, updated_at=now()
     RETURNING id`,
    [encryptPii(p.phone), hashPii(p.phone), encryptPii(p.fullName), p.email ? encryptPii(p.email) : null]);
  return r.rows[0].id;
}

export interface BookingResult {
  outcome: "created" | "manual_review_created" | "outside_cutoff";
  orderCode?: string; status?: OrderStatus; totalCents?: number; riskFlags?: string[];
  quote: QuoteResult; nextStep?: "pay" | "verify_recipient" | "await_staff";
}

export async function createBooking(pool: pg.Pool, input: BookingCreateInput, now = new Date()): Promise<BookingResult> {
  const qt = await quote(pool, input, now);
  if (!qt.withinCutoff && !input.requestManualReview) return { outcome: "outside_cutoff", quote: qt };
  const manual = !qt.withinCutoff;
  const port = await getPort(pool, input.portCode);

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const recipientId = await upsertPerson(c, input.recipient);
    const payerId = input.payer ? await upsertPerson(c, input.payer) : recipientId;

    // vessel + port call
    let vesselId: string;
    const v = input.vesselImo ? await c.query(`SELECT id FROM vessel WHERE imo=$1`, [input.vesselImo]) : await c.query(`SELECT id FROM vessel WHERE lower(name)=lower($1) AND imo IS NULL`, [input.vesselName]);
    vesselId = v.rowCount ? v.rows[0].id
      : (await c.query(`INSERT INTO vessel(imo,name) VALUES ($1,$2) RETURNING id`, [input.vesselImo ?? null, input.vesselName])).rows[0].id;
    await c.query(`INSERT INTO assignment(person_id,vessel_id) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM assignment WHERE person_id=$1 AND vessel_id=$2 AND to_date IS NULL)`, [recipientId, vesselId]);
    const pcId = (await c.query(`INSERT INTO port_call(vessel_id,port_id,eta,eta_source) VALUES ($1,$2,$3,'customer') RETURNING id`, [vesselId, port.id, input.eta])).rows[0].id;

    // parcels: attach unattached ones, create expected ones, refuse parcels owned by another order
    const parcelIds: { id: string; received: boolean }[] = [];
    for (const code of input.parcelCodes) {
      const hit = await c.query(
        `SELECT p.id, p.order_id, p.status FROM tracking_alias a JOIN parcel p ON p.id=a.parcel_id
          WHERE a.code_normalised=$1 AND a.type IN ('carrier','declared') FOR UPDATE OF p`, [code]);
      if (hit.rowCount && hit.rowCount > 1) throw new BookingError(409, "ambiguous_code", `Code ${code} matches several parcels; please contact us on WhatsApp`);
      if (hit.rowCount) {
        const p = hit.rows[0];
        if (p.order_id) throw new BookingError(409, "parcel_already_booked", `Parcel ${code} is already linked to an order`);
        parcelIds.push({ id: p.id, received: ["received", "ready"].includes(p.status) });
      } else {
        const id = (await c.query(`INSERT INTO parcel(status,label_name) VALUES ('expected',$1) RETURNING id`, [input.recipient.fullName])).rows[0].id;
        await c.query(`INSERT INTO tracking_alias(code_normalised,type,parcel_id) VALUES ($1,'declared',$2)`, [code, id]);
        parcelIds.push({ id, received: false });
      }
    }

    // order status via the state machine
    let status: OrderStatus = "draft";
    status = manual ? nextOrderStatus(status, "flag_manual")
      : input.paymentMethod === "cod" ? nextOrderStatus(status, "submit_cod") : nextOrderStatus(status, "submit_prepaid");

    const etaHours = (input.eta.getTime() - now.getTime()) / 3_600_000;
    const prior = (await c.query(`SELECT count(*)::int n FROM "order" WHERE recipient_person_id=$1 AND status IN ('confirmed','completed')`, [recipientId])).rows[0].n;
    const flags = input.paymentMethod === "cod"
      ? codRiskFlags({ totalCents: qt.totalCents, recipientPriorCompletedOrders: prior, vesselEtaWithinHours: etaHours, softThresholdCents: business.codCapCents }) : [];
    if (manual) flags.push("inside_cutoff");
    const risk = parcelIds.every((p) => p.received) ? "on_track"
      : arrivalRisk({ now, vesselEta: input.eta, cutoffHours: port.cutoff_hours, handlingBufferHours: port.handling_buffer_hours,
          warnWindowHours: business.warnWindowHours, parcelReceived: false });

    let orderId = "", code = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      code = generateOrderCode();
      try {
        await c.query("SAVEPOINT o");
        orderId = (await c.query(
          `INSERT INTO "order"(public_code,payer_person_id,recipient_person_id,port_call_id,status,payment_status,payment_method,
              source,manual_review,total_cents,arrival_risk,risk_flags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [code, payerId, recipientId, pcId, status, input.paymentMethod === "cod" ? "cod_pending" : "unpaid", input.paymentMethod,
           input.source, manual, qt.totalCents, risk, flags])).rows[0].id;
        break;
      } catch (e: any) { if (e.code === "23505") { await c.query("ROLLBACK TO o"); continue; } throw e; }
    }
    if (!orderId) throw new Error("Could not allocate order code");

    await c.query(`UPDATE parcel SET order_id=$1, updated_at=now() WHERE id = ANY($2::uuid[])`, [orderId, parcelIds.map((p) => p.id)]);
    await c.query(`INSERT INTO tracking_alias(code_normalised,type,order_id) VALUES ($1,'order',$2)`, [code, orderId]);
    await c.query(`INSERT INTO delivery_booking(order_id,port_call_id) VALUES ($1,$2)`, [orderId, pcId]);
    for (const l of qt.lines) await c.query(`INSERT INTO order_line(order_id,description,amount_cents,rule_id) VALUES ($1,$2,$3,$4)`, [orderId, l.description, l.amountCents, l.ruleId ?? null]);

    // consent (append-only)
    const consent = (purpose: string, granted: boolean) =>
      c.query(`INSERT INTO consent_record(person_id,channel,purpose,granted,wording_version,source) VALUES ($1,'whatsapp',$2,$3,$4,'booking_form')`,
        [recipientId, purpose, granted, input.consent.wordingVersion]);
    await consent("transactional", true); await consent("marketing", input.consent.marketing);

    await c.query(`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,after) VALUES ('customer',$1,'order',$2,'create',$3)`,
      [recipientId, orderId, JSON.stringify({ status, manual, totalCents: qt.totalCents, flags })]);
    await c.query(`INSERT INTO outbox_job(type,payload,dedupe_key) VALUES ('monday.order.upsert',$1,$2)`, [JSON.stringify({ orderId }), `order-create-${orderId}`]);
    await c.query("COMMIT");

    return {
      outcome: manual ? "manual_review_created" : "created", orderCode: code, status, totalCents: qt.totalCents, riskFlags: flags, quote: qt,
      nextStep: manual ? "await_staff" : input.paymentMethod === "cod" ? "verify_recipient" : "pay",
    };
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
