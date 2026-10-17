import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { lookup } from "../src/modules/lookup/service.js";
import { anonymisePerson } from "../src/domain/retention.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("lookup (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });
  beforeAll(async () => {
    await pool.query(`TRUNCATE tracking_alias, parcel, "order", port_call, vessel, port, person RESTART IDENTITY CASCADE`);
    const port = (await pool.query(`INSERT INTO port(code,name,delivery_address) VALUES ('ZADUR','Durban','x') RETURNING id`)).rows[0].id;
    const v = (await pool.query(`INSERT INTO vessel(name) VALUES ('V') RETURNING id`)).rows[0].id;
    const pc = (await pool.query(`INSERT INTO port_call(vessel_id,port_id,eta,eta_source) VALUES ($1,$2,now(),'staff') RETURNING id`, [v, port])).rows[0].id;
    const o = (await pool.query(`INSERT INTO "order"(public_code,port_call_id) VALUES ('CRAAAAAA',$1) RETURNING id`, [pc])).rows[0].id;
    const mk = async (oid: string | null, st: string, name: string, code: string) => {
      const id = (await pool.query(`INSERT INTO parcel(order_id,status,label_name) VALUES ($1,$2,$3) RETURNING id`, [oid, st, name])).rows[0].id;
      await pool.query(`INSERT INTO tracking_alias(code_normalised,type,parcel_id) VALUES ($1,'carrier',$2)`, [code, id]);
    };
    await mk(o, "received", "Smith", "CODE1AAAA");
    await mk(o, "expected", "Smith", "CODE2AAAA");
    await mk(null, "received", "Jones", "CODE3AAAA");
    await mk(null, "received", "Alpha Smith", "SHAREDCODE");
    await mk(o, "received", "Beta Jones", "SHAREDCODE");
  });
  afterAll(() => pool.end());
  it("scenario 4: in transit + linked + unpaid -> card + COD options", async () => {
    const r = await lookup(pool, "CODE2AAAA");
    expect(r.kind).toBe("in_transit_unpaid");
    if (r.kind !== "in_transit_unpaid") return;
    expect(r.payment.status).toBe("unpaid"); expect(r.payment.options.map((o) => o.type)).toEqual(["card", "cod"]);
    expect(r.portName).toBe("Durban"); expect(r.deliveryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("scenario 2: in warehouse + linked + unpaid", async () => expect((await lookup(pool, "code1-aaaa")).kind).toBe("in_warehouse_unpaid"));
  it("scenario 1 and 3: paid orders show no pay options", async () => {
    await pool.query(`UPDATE "order" SET payment_status='paid'`);
    const one = await lookup(pool, "CODE1AAAA"), three = await lookup(pool, "CODE2AAAA");
    expect(one.kind).toBe("in_warehouse_paid"); expect(three.kind).toBe("in_transit_paid");
    if (one.kind === "in_warehouse_paid") { expect(one.payment.status).toBe("paid"); expect(one.payment.options).toEqual([]); }
    await pool.query(`UPDATE "order" SET payment_status='unpaid'`);
  });
  it("manual_review order never offers a pay link (price not final)", async () => {
    await pool.query(`UPDATE "order" SET status='manual_review'`);
    const r = await lookup(pool, "CODE1AAAA");
    await pool.query(`UPDATE "order" SET status='draft'`);
    expect(r.kind).toBe("in_warehouse_unpaid");
    if (r.kind === "in_warehouse_unpaid") { expect(r.payment.options).toEqual([]); expect(r.payment.awaitingStaffPricing).toBe(true); }
  });
  it("scenario 5: in warehouse, not linked -> prefilled book form at R85", async () => {
    const r = await lookup(pool, "CODE3AAAA");
    expect(r).toMatchObject({ kind: "in_warehouse_unlinked", baseCents: 8500, prefill: { parcelCodes: ["CODE3AAAA"] } });
  });
  it("scenario 6: no record", async () => expect(await lookup(pool, "NOPE123456")).toMatchObject({ kind: "no_record", baseCents: 8500 }));
  it("invalid code", async () => expect((await lookup(pool, "a")).kind).toBe("invalid_code"));
  it("ambiguous needs second factor, then resolves", async () => {
    expect((await lookup(pool, "SHAREDCODE")).kind).toBe("needs_second_factor");
    expect((await lookup(pool, "SHAREDCODE", { surname: "jones" })).kind).toBe("in_warehouse_unpaid");
  });
  it("order code summary", async () => {
    await pool.query(`INSERT INTO tracking_alias(code_normalised,type,order_id) SELECT 'CRAAAAAA','order',id FROM "order"`);
    const r = await lookup(pool, "CRAAAAAA");
    expect(r.kind).toBe("order_summary"); if (r.kind === "order_summary") expect(r.parcels.length).toBe(3);
  });
  it("response never leaks names", async () => expect(JSON.stringify(await lookup(pool, "CODE1AAAA"))).not.toMatch(/Smith/));
  it("anonymise strips PII but keeps orders/parcels", async () => {
    const p = (await pool.query(`INSERT INTO person(phone_enc,phone_hash,full_name_enc) VALUES ('+1','h','n') RETURNING id`)).rows[0].id;
    await pool.query(`UPDATE "order" SET recipient_person_id=$1`, [p]);
    await anonymisePerson(pool, p, "test");
    const row = (await pool.query(`SELECT * FROM person WHERE id=$1`, [p])).rows[0];
    expect(row.phone_enc).toBeNull(); expect(row.erased_at).not.toBeNull();
    expect((await pool.query(`SELECT count(*)::int c FROM parcel`)).rows[0].c).toBe(5);
  });
});
