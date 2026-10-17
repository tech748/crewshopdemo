import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { buildServer } from "../src/server.js";
import { seedWorld, loginAs, PW, type World } from "./staffHelpers.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("staff auth (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });
  let app: Awaited<ReturnType<typeof buildServer>>; let w: World;
  beforeAll(async () => { app = await buildServer(pool, { rateLimit: false }); });
  beforeEach(async () => { w = await seedWorld(pool); });
  afterAll(async () => { await app.close(); await pool.end(); });

  it("login sets an httpOnly SameSite=Strict cookie and never stores the raw token", async () => {
    const { res, cookie } = await loginAs(app, "clerk@crew.test", w.whCpt);
    expect(res.statusCode).toBe(200);
    const sc = String(res.headers["set-cookie"]);
    expect(sc).toMatch(/HttpOnly/i); expect(sc).toMatch(/SameSite=Strict/i);
    const token = cookie.split("=")[1]!;
    expect((await pool.query(`SELECT count(*)::int c FROM staff_session WHERE token_hash=$1`, [token])).rows[0].c).toBe(0);
    const me = await app.inject({ method: "GET", url: "/v1/staff/me", headers: { cookie } });
    expect(me.json()).toMatchObject({ email: "clerk@crew.test", warehouseId: w.whCpt, isOpsManager: false });
  });
  it("rejects unauthenticated access", async () => {
    for (const [m, u] of [["GET", "/v1/staff/unmatched"], ["GET", "/v1/staff/manual-review"], ["POST", "/v1/staff/intake"], ["POST", "/v1/staff/handover"]] as const)
      expect((await app.inject({ method: m, url: u })).statusCode).toBe(401);
  });
  it("wrong password and unknown email look identical (401)", async () => {
    const a = await loginAs(app, "clerk@crew.test", w.whCpt, "nope"), b = await loginAs(app, "ghost@crew.test", w.whCpt, "nope");
    expect(a.res.statusCode).toBe(401); expect(b.res.json()).toEqual(a.res.json());
  });
  it("locks the account after 5 failures, even for the right password", async () => {
    for (let i = 0; i < 5; i++) await loginAs(app, "clerk@crew.test", w.whCpt, "bad");
    const r = await loginAs(app, "clerk@crew.test", w.whCpt, PW);
    expect(r.res.statusCode).toBe(423);
    expect((await pool.query(`SELECT count(*)::int c FROM audit_log WHERE action='login_locked' AND entity_id=$1`, [w.clerk])).rows[0].c).toBe(1);
  });
  it("refuses a warehouse not on the user's allow-list", async () => {
    expect((await loginAs(app, "clerk@crew.test", w.whDur)).res.statusCode).toBe(403);
    expect((await loginAs(app, "ops@crew.test", w.whDur)).res.statusCode).toBe(200);
  });
  it("logout revokes the session server-side", async () => {
    const { cookie } = await loginAs(app, "clerk@crew.test", w.whCpt);
    await app.inject({ method: "POST", url: "/v1/staff/logout", headers: { cookie } });
    expect((await app.inject({ method: "GET", url: "/v1/staff/me", headers: { cookie } })).statusCode).toBe(401);
  });
  it("an expired session is rejected", async () => {
    const { cookie } = await loginAs(app, "clerk@crew.test", w.whCpt);
    await pool.query(`UPDATE staff_session SET expires_at = now() - interval '1 minute'`);
    expect((await app.inject({ method: "GET", url: "/v1/staff/me", headers: { cookie } })).statusCode).toBe(401);
  });
  it("a deactivated user's live session stops working", async () => {
    const { cookie } = await loginAs(app, "clerk@crew.test", w.whCpt);
    await pool.query(`UPDATE staff_user SET active=false WHERE id=$1`, [w.clerk]);
    expect((await app.inject({ method: "GET", url: "/v1/staff/me", headers: { cookie } })).statusCode).toBe(401);
  });
  it("login is rate limited per IP (brute-force guard)", async () => {
    const limited = await buildServer(pool);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await loginAs(limited, `ghost${i}@crew.test`, w.whCpt, "bad")).res.statusCode);
    await limited.close();
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true); expect(codes.slice(10)).toEqual([429, 429]);
  });
});
