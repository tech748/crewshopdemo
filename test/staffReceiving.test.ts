import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { seedWorld, loginAs, mkOrder, mkParcel, type World } from "./staffHelpers.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("staff receiving, unmatched queue, manual review (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });
  let app: Awaited<ReturnType<typeof buildServer>>; let w: World; let h: { cookie: string }; let ops: { cookie: string };
  const post = (u: string, payload: unknown, headers = h) => app.inject({ method: "POST", url: u, payload: payload as object, headers });
  beforeAll(async () => { app = await buildServer(pool, { rateLimit: false }); });
  beforeEach(async () => {
    w = await seedWorld(pool);
    h = (await loginAs(app, "clerk@crew.test", w.whCpt)).headers; ops = (await loginAs(app, "ops@crew.test", w.whCpt)).headers;
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  it("receives an expected parcel into the session's warehouse, with audit + outbox", async () => {
    const p = await mkParcel(pool, w.order, "in_transit", "TBA111111111");
    const r = await post("/v1/staff/intake", { clientScanId: "scan-0001-a", code: "tba-111111111", weightKg: 1.5, bin: "A3" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ result: "received", linked: true, orderCode: "CRORDER001", portMismatch: false });
    expect((await pool.query(`SELECT status, warehouse_id, bin FROM parcel WHERE id=$1`, [p])).rows[0]).toMatchObject({ status: "received", warehouse_id: w.whCpt, bin: "A3" });
    expect((await pool.query(`SELECT count(*)::int c FROM audit_log WHERE entity_id=$1 AND action='intake_received'`, [p])).rows[0].c).toBe(1);
    expect((await pool.query(`SELECT count(*)::int c FROM outbox_job WHERE dedupe_key=$1`, [`parcel-intake-${p}`])).rows[0].c).toBe(1);
  });
  it("is idempotent on clientScanId (device retry creates no duplicates)", async () => {
    const body = { clientScanId: "scan-0002-b", code: "NEWUNKNOWN01" };
    const a = await post("/v1/staff/intake", body), b = await post("/v1/staff/intake", body);
    expect(a.statusCode).toBe(201); expect(b.statusCode).toBe(200); expect(b.json().replay).toBe(true);
    expect((await pool.query(`SELECT count(*)::int c FROM parcel`)).rows[0].c).toBe(1);
  });
  it("unknown code becomes an unmatched parcel in the queue (this warehouse only)", async () => {
    await post("/v1/staff/intake", { clientScanId: "scan-0003-c", code: "MYSTERY0001" });
    const q = (await app.inject({ method: "GET", url: "/v1/staff/unmatched", headers: h })).json();
    expect(q).toHaveLength(1); expect(q[0].codes).toEqual(["MYSTERY0001"]);
    const durOps = (await loginAs(app, "ops@crew.test", w.whDur)).headers;
    expect((await app.inject({ method: "GET", url: "/v1/staff/unmatched", headers: durOps })).json()).toHaveLength(0);
  });
  it("re-scan of a received parcel reports already_received; ambiguous codes mutate nothing", async () => {
    await mkParcel(pool, w.order, "received", "DUP000000001", w.whCpt);
    expect((await post("/v1/staff/intake", { clientScanId: "scan-0004-d", code: "DUP000000001" })).json().result).toBe("already_received");
    await mkParcel(pool, null, "expected", "SHARED000001"); await mkParcel(pool, null, "expected", "SHARED000001");
    expect((await post("/v1/staff/intake", { clientScanId: "scan-0005-e", code: "SHARED000001" })).json().result).toBe("ambiguous");
    expect((await pool.query(`SELECT count(*)::int c FROM parcel WHERE status='received'`)).rows[0].c).toBe(1);
  });
  it("flags a parcel scanned at the wrong port's hub", async () => {
    await mkParcel(pool, w.order, "in_transit", "WRONGPORT001");
    const durOps = (await loginAs(app, "ops@crew.test", w.whDur)).headers;
    expect((await post("/v1/staff/intake", { clientScanId: "scan-0006-f", code: "WRONGPORT001" }, durOps)).json().portMismatch).toBe(true);
  });
  it("manually matches an unmatched parcel to an order, with audit", async () => {
    const id = (await post("/v1/staff/intake", { clientScanId: "scan-0007-g", code: "MYSTERY0002" })).json().parcelId;
    const r = await post(`/v1/staff/unmatched/${id}/match`, { orderCode: "crorder001" });
    expect(r.statusCode).toBe(200);
    expect((await pool.query(`SELECT order_id FROM parcel WHERE id=$1`, [id])).rows[0].order_id).toBe(w.order);
    expect((await pool.query(`SELECT count(*)::int c FROM audit_log WHERE action='manual_match' AND entity_id=$1`, [id])).rows[0].c).toBe(1);
    expect((await post(`/v1/staff/unmatched/${id}/match`, { orderCode: "CRORDER001" })).statusCode).toBe(404); // no longer in queue
  });
  it("refuses to match across ports", async () => {
    const durPc = (await pool.query(`INSERT INTO port_call(vessel_id,port_id,eta,eta_source) SELECT id,$1,now()+interval '5 days','staff' FROM vessel RETURNING id`, [w.dur])).rows[0].id;
    await mkOrder(pool, durPc, "CRDURBAN01");
    const id = (await post("/v1/staff/intake", { clientScanId: "scan-0008-h", code: "MYSTERY0003" })).json().parcelId;
    expect((await post(`/v1/staff/unmatched/${id}/match`, { orderCode: "CRDURBAN01" })).json().code).toBe("port_mismatch");
  });

  describe("manual review / rush fee", () => {
    beforeEach(async () => { await mkOrder(pool, w.port, "CRRUSH0001", { status: "manual_review" }); });
    it("only an Ops Manager may approve; clerks can still see the queue", async () => {
      expect((await post("/v1/staff/orders/CRRUSH0001/approve", {})).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/v1/staff/manual-review", headers: h })).json()).toHaveLength(1);
    });
    it("approves with a rush fee override: total, order line, status and audit all move together", async () => {
      const r = await post("/v1/staff/orders/CRRUSH0001/approve", { rushFeeCents: 15000 }, ops);
      expect(r.json()).toMatchObject({ status: "awaiting_payment", totalCents: 23500, rushFeeCents: 15000 });
      expect((await pool.query(`SELECT amount_cents FROM order_line WHERE description LIKE 'Rush fee%'`)).rows[0].amount_cents).toBe(15000);
      const a = (await pool.query(`SELECT before, after FROM audit_log WHERE action='manual_review_approve'`)).rows[0];
      expect(a.before.totalCents).toBe(8500); expect(a.after.totalCents).toBe(23500);
    });
    it("approve without an override keeps the price; COD orders go to cod_pending_verification", async () => {
      expect((await post("/v1/staff/orders/CRRUSH0001/approve", {}, ops)).json()).toMatchObject({ status: "awaiting_payment", totalCents: 8500 });
      await mkOrder(pool, w.port, "CRRUSH0002", { status: "manual_review", payment_method: "cod", payment_status: "cod_pending" });
      expect((await post("/v1/staff/orders/CRRUSH0002/approve", {}, ops)).json().status).toBe("cod_pending_verification");
    });
    it("blocks re-approval, post-payment changes, and absurd fees", async () => {
      await post("/v1/staff/orders/CRRUSH0001/approve", {}, ops);
      expect((await post("/v1/staff/orders/CRRUSH0001/approve", { rushFeeCents: 100 }, ops)).statusCode).toBe(409);
      await mkOrder(pool, w.port, "CRRUSH0003", { status: "manual_review", payment_status: "paid" });
      expect((await post("/v1/staff/orders/CRRUSH0003/approve", { rushFeeCents: 100 }, ops)).json().code).toBe("already_paid");
      expect((await post("/v1/staff/orders/CRRUSH0001/approve", { rushFeeCents: 99_999_999 }, ops)).statusCode).toBe(400);
    });
    it("reject cancels with a reason in the audit log", async () => {
      expect((await post("/v1/staff/orders/CRRUSH0001/reject", { reason: "vessel already sailed" }, ops)).json().status).toBe("cancelled");
      expect((await pool.query(`SELECT after FROM audit_log WHERE action='manual_review_reject'`)).rows[0].after.reason).toBe("vessel already sailed");
    });
    it("other ports' orders are invisible to this warehouse", async () => {
      const durPc = (await pool.query(`INSERT INTO port_call(vessel_id,port_id,eta,eta_source) SELECT id,$1,now()+interval '5 days','staff' FROM vessel RETURNING id`, [w.dur])).rows[0].id;
      await mkOrder(pool, durPc, "CRDURREV01", { status: "manual_review" });
      expect((await post("/v1/staff/orders/CRDURREV01/approve", {}, ops)).statusCode).toBe(404);
    });
  });
});
