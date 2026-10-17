import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { issueHandoverCode } from "../src/modules/staff/handoverService.js";
import { seedWorld, loginAs, mkOrder, mkParcel, type World } from "./staffHelpers.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("gangway handover (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });
  let app: Awaited<ReturnType<typeof buildServer>>; let w: World; let h: { cookie: string }; let ops: { cookie: string };
  let code: string; // the real handover code for CRORDER001 (COD)
  const post = (u: string, payload: unknown, headers = h) => app.inject({ method: "POST", url: u, payload: payload as object, headers });
  const handover = (c: string, extra: object = {}, headers = h) => post("/v1/staff/handover", { orderCode: "CRORDER001", code: c, ...extra }, headers);
  const wrong = () => (code === "000000" ? "111111" : "000000");
  const audits = async (action: string) => (await pool.query(`SELECT count(*)::int c FROM audit_log WHERE action=$1`, [action])).rows[0].c as number;

  beforeAll(async () => { app = await buildServer(pool, { rateLimit: false }); });
  beforeEach(async () => {
    w = await seedWorld(pool);
    h = (await loginAs(app, "clerk@crew.test", w.whCpt)).headers; ops = (await loginAs(app, "ops@crew.test", w.whCpt)).headers;
    await mkParcel(pool, w.order, "received", "HOVER0000001", w.whCpt);
    await mkParcel(pool, w.order, "ready", "HOVER0000002", w.whCpt);
    code = await issueHandoverCode(pool, w.order);
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  it("issues a 6-digit code once, idempotently, and never stores it in clear", async () => {
    expect(code).toMatch(/^\d{6}$/);
    expect(await issueHandoverCode(pool, w.order)).toBe(code);
    const o = (await pool.query(`SELECT handover_code_hash h, handover_code_enc e FROM "order" WHERE id=$1`, [w.order])).rows[0];
    expect(o.h).not.toContain(code); expect(o.e).not.toContain(code);
  });
  it("refuses to issue a code for an unconfirmed order", async () => {
    const id = await mkOrder(pool, w.port, "CRDRAFT001", { status: "awaiting_payment" });
    await expect(issueHandoverCode(pool, id)).rejects.toMatchObject({ code: "order_not_confirmed" });
  });
  it("COD: correct code first demands collection; then completes, records cash, delivers all parcels", async () => {
    const due = await handover(code);
    expect(due.statusCode).toBe(409); expect(due.json()).toMatchObject({ code: "cod_collection_required", amountDueCents: 8500 });
    expect((await pool.query(`SELECT status FROM "order" WHERE id=$1`, [w.order])).rows[0].status).toBe("confirmed"); // nothing moved yet
    const ok = await handover(code, { codCollected: true });
    expect(ok.statusCode).toBe(200); expect(ok.json()).toMatchObject({ status: "completed", parcelsDelivered: 2, codCollectedCents: 8500 });
    const o = (await pool.query(`SELECT status, payment_status FROM "order" WHERE id=$1`, [w.order])).rows[0];
    expect(o).toMatchObject({ status: "completed", payment_status: "cod_collected" });
    expect((await pool.query(`SELECT DISTINCT status FROM parcel`)).rows).toEqual([{ status: "delivered" }]);
    expect((await pool.query(`SELECT amount_cents FROM payment WHERE order_id=$1 AND provider='cod'`, [w.order])).rows[0].amount_cents).toBe(8500);
    expect((await pool.query(`SELECT handover_confirmed_at FROM delivery_booking WHERE order_id=$1`, [w.order])).rows[0].handover_confirmed_at).not.toBeNull();
    expect(await audits("handover_complete")).toBe(1);
  });
  it("is not replayable: a completed order cannot be handed over (or paid) twice", async () => {
    await handover(code, { codCollected: true });
    expect((await handover(code, { codCollected: true })).json().code).toBe("order_not_confirmed");
    expect((await pool.query(`SELECT count(*)::int c FROM payment WHERE provider='cod'`)).rows[0].c).toBe(1);
  });
  it("prepaid order completes without a cash step", async () => {
    const id = await mkOrder(pool, w.port, "CRPREPAID1", { status: "confirmed", payment_status: "paid" });
    await mkParcel(pool, id, "received", "PREPAID00001", w.whCpt);
    const c = await issueHandoverCode(pool, id);
    const r = await post("/v1/staff/handover", { orderCode: "CRPREPAID1", code: c });
    expect(r.json()).toMatchObject({ status: "completed", codCollectedCents: 0 });
  });
  it("wrong codes are counted, audited, and lock the order after 5 (even the right code is then refused)", async () => {
    const left: number[] = [];
    for (let i = 0; i < 4; i++) { const r = await handover(wrong()); expect(r.json().code).toBe("wrong_code"); left.push(r.json().attemptsLeft); }
    expect(left).toEqual([4, 3, 2, 1]);
    const fifth = await handover(wrong());
    expect(fifth.statusCode).toBe(423); expect(fifth.json().code).toBe("handover_locked");
    expect((await handover(code, { codCollected: true })).statusCode).toBe(423);
    expect(await audits("handover_code_failed")).toBe(4); expect(await audits("handover_locked")).toBe(1);
    expect((await pool.query(`SELECT status FROM "order" WHERE id=$1`, [w.order])).rows[0].status).toBe("confirmed");
  });
  it("only an Ops Manager can unlock; afterwards the right code works", async () => {
    for (let i = 0; i < 5; i++) await handover(wrong());
    expect((await post("/v1/staff/handover/CRORDER001/unlock", {})).statusCode).toBe(403);
    expect((await post("/v1/staff/handover/CRORDER001/unlock", {}, ops)).statusCode).toBe(200);
    expect((await handover(code, { codCollected: true })).statusCode).toBe(200);
    expect(await audits("handover_unlock")).toBe(1);
  });
  it("concurrent guesses cannot beat the lockout (row lock serialises attempts)", async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, () => handover(wrong())));
    const n = (await pool.query(`SELECT handover_failed_attempts n, handover_locked_at l FROM "order" WHERE id=$1`, [w.order])).rows[0];
    expect(n.n).toBe(5); expect(n.l).not.toBeNull();
    expect(rs.filter((r) => r.json().code === "wrong_code").length + rs.filter((r) => r.json().code === "handover_locked").length).toBe(12);
  });
  it("a code is only valid for its own order (no cross-order matching)", async () => {
    const id = await mkOrder(pool, w.port, "CROTHER001", { status: "confirmed", payment_status: "paid" });
    await mkParcel(pool, id, "received", "OTHER0000001", w.whCpt);
    const other = await issueHandoverCode(pool, id);
    const r = await post("/v1/staff/handover", { orderCode: "CROTHER001", code });
    if (other !== code) expect(r.json().code).toBe("wrong_code");
  });
  it("no parcel leaves without a confirmed order", async () => {
    for (const status of ["awaiting_payment", "cod_pending_verification", "manual_review", "draft"]) {
      await pool.query(`UPDATE "order" SET status=$2 WHERE id=$1`, [w.order, status]);
      expect((await handover(code, { codCollected: true })).json().code).toBe("order_not_confirmed");
    }
    expect((await pool.query(`SELECT count(*)::int c FROM parcel WHERE status='delivered'`)).rows[0].c).toBe(0);
  });
  it("refuses while any parcel is still in transit or sits in another warehouse", async () => {
    await mkParcel(pool, w.order, "in_transit", "LATE00000001");
    expect((await handover(code, { codCollected: true })).json().code).toBe("parcels_not_ready");
    await pool.query(`UPDATE parcel SET status='received', warehouse_id=$1`, [w.whDur]);
    expect((await handover(code, { codCollected: true })).json().code).toBe("parcels_not_ready");
  });
  it("rejects malformed input", async () => {
    expect((await handover("12345")).statusCode).toBe(400);
    expect((await handover("abcdef")).statusCode).toBe(400);
  });
});
