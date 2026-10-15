import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createBooking, BookingError } from "../src/modules/booking/service.js";
import { BookingCreate } from "../src/modules/booking/schema.js";
import { computeQuote } from "../src/modules/pricing/engine.js";
import { withinCutoffWindow } from "../src/domain/cutoff.js";
import { lookup } from "../src/modules/lookup/service.js";
import { runRetention } from "../src/jobs/retention.js";
import { encryptPii, decryptPii } from "../src/security/pii.js";

const rules = [
  { id: "b", kind: "base" as const, params: { perParcelCents: 8500 }, priority: 0 },
  { id: "p", kind: "promo" as const, params: { code: "SEA10", percentOff: 10 }, priority: 0 },
];
describe("pricing", () => {
  it("R85 per parcel", () => expect(computeQuote(rules, 3).totalCents).toBe(25500));
  it("percent promo", () => expect(computeQuote(rules, 2, "sea10").totalCents).toBe(15300));
  it("unknown promo ignored", () => expect(computeQuote(rules, 1, "NOPE").totalCents).toBe(8500));
});
describe("cutoff + pii", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  it("exactly 24h is allowed", () => expect(withinCutoffWindow(now, new Date("2026-11-02T12:00:00Z"), 24)).toBe(true));
  it("23h59 is not", () => expect(withinCutoffWindow(now, new Date("2026-11-02T11:59:00Z"), 24)).toBe(false));
  it("pii roundtrip", () => { const e = encryptPii("+2782"); expect(e).not.toContain("2782"); expect(decryptPii(e)).toBe("+2782"); });
});

const url = process.env.TEST_DATABASE_URL;
const base = (over: object = {}) => BookingCreate.parse({
  parcelCodes: ["AMZ-0001-AAAA"], portCode: "ZADUR", vesselName: "MV Test",
  eta: new Date(Date.now() + 5 * 864e5).toISOString(),
  recipient: { fullName: "Juan Dela Cruz", phone: "+639171234567" },
  paymentMethod: "prepaid", consent: { transactional: true, marketing: true, wordingVersion: "v1" }, ...over });

describe.skipIf(!url)("booking (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });
  beforeAll(async () => {
    await pool.query(`TRUNCATE tracking_alias, order_line, delivery_booking, parcel, "order", port_call, assignment, vessel, port, person, consent_record, outbox_job RESTART IDENTITY CASCADE`).catch(async () =>
      pool.query(`TRUNCATE tracking_alias, order_line, delivery_booking, parcel, "order", port_call, assignment, vessel, port, person RESTART IDENTITY CASCADE`));
    await pool.query(`INSERT INTO port(code,name,delivery_address) VALUES ('ZADUR','Durban','x')`);
  });
  afterAll(() => pool.end());

  it("creates a prepaid order, encrypts PII, writes audit + outbox + consent", async () => {
    const r = await createBooking(pool, base());
    expect(r.outcome).toBe("created"); expect(r.status).toBe("awaiting_payment"); expect(r.totalCents).toBe(8500); expect(r.nextStep).toBe("pay");
    const p = (await pool.query(`SELECT full_name_enc, phone_enc FROM person`)).rows[0];
    expect(p.full_name_enc).not.toContain("Juan"); expect(p.phone_enc).not.toContain("639");
    expect((await pool.query(`SELECT count(*)::int c FROM audit_log WHERE entity='order'`)).rows[0].c).toBe(1);
    expect((await pool.query(`SELECT count(*)::int c FROM outbox_job`)).rows[0].c).toBe(1);
    expect((await pool.query(`SELECT count(*)::int c FROM consent_record`)).rows[0].c).toBe(2);
    // parcel declared -> lookup now says outcome 2
    expect((await lookup(pool, "AMZ0001AAAA")).outcome).toBe("attached_expected");
    expect((await lookup(pool, r.orderCode!)).outcome).toBe("order");
  });
  it("attaches an existing unattached parcel (outcome 3 -> 1 path)", async () => {
    const id = (await pool.query(`INSERT INTO parcel(status) VALUES ('received') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO tracking_alias(code_normalised,type,parcel_id) VALUES ('HERENOORDER1','carrier',$1)`, [id]);
    expect((await lookup(pool, "HERENOORDER1")).outcome).toBe("unattached_received");
    await createBooking(pool, base({ parcelCodes: ["HERENOORDER1"] }));
    expect((await lookup(pool, "HERENOORDER1")).outcome).toBe("attached_received");
  });
  it("refuses a parcel already booked", async () => {
    await expect(createBooking(pool, base())).rejects.toBeInstanceOf(BookingError);
  });
  it("outside cut-off: no order unless manual review requested", async () => {
    const eta = new Date(Date.now() + 10 * 3600e3).toISOString();
    const r = await createBooking(pool, base({ parcelCodes: ["LATE0000AAAA"], eta }));
    expect(r.outcome).toBe("outside_cutoff"); expect(r.quote.handoffUrl).toContain("wa.me");
    const m = await createBooking(pool, base({ parcelCodes: ["LATE0000AAAA"], eta, requestManualReview: true }));
    expect(m.outcome).toBe("manual_review_created"); expect(m.status).toBe("manual_review"); expect(m.riskFlags).toContain("inside_cutoff");
  });
  it("COD is pending verification and flagged for a human", async () => {
    const r = await createBooking(pool, base({ parcelCodes: ["CODPARCEL001"], paymentMethod: "cod", recipient: { fullName: "New Person", phone: "+639170000001" } }));
    expect(r.status).toBe("cod_pending_verification"); expect(r.nextStep).toBe("verify_recipient"); expect(r.riskFlags).toContain("first_time_recipient");
  });
  it("rejects bad phone numbers", () => expect(() => base({ recipient: { fullName: "X Y", phone: "0821234567" } })).toThrow());
  it("retention anonymises only inactive people, keeps orders", async () => {
    await pool.query(`UPDATE person SET updated_at = now() - interval '13 months'`);
    await pool.query(`UPDATE "order" SET updated_at = now() - interval '13 months'`);
    const orders = (await pool.query(`SELECT count(*)::int c FROM "order"`)).rows[0].c;
    expect(await runRetention(pool, 12)).toBeGreaterThan(0);
    expect((await pool.query(`SELECT count(*)::int c FROM person WHERE phone_enc IS NOT NULL`)).rows[0].c).toBe(0);
    expect((await pool.query(`SELECT count(*)::int c FROM "order"`)).rows[0].c).toBe(orders);
  });
});
