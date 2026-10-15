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
  it("outcome 1", async () => expect((await lookup(pool, "code1-aaaa")).outcome).toBe("attached_received"));
  it("outcome 2", async () => expect((await lookup(pool, "CODE2AAAA")).outcome).toBe("attached_expected"));
  it("outcome 3", async () => {
    const r = await lookup(pool, "CODE3AAAA");
    expect(r.outcome).toBe("unattached_received"); expect(r.nextAction.type).toBe("book_form");
  });
  it("outcome 4", async () => expect((await lookup(pool, "NOPE123456")).outcome).toBe("unknown"));
  it("invalid code", async () => expect((await lookup(pool, "a")).outcome).toBe("invalid_code"));
  it("ambiguous needs second factor, then resolves", async () => {
    expect((await lookup(pool, "SHAREDCODE")).outcome).toBe("needs_second_factor");
    expect((await lookup(pool, "SHAREDCODE", { surname: "jones" })).outcome).toBe("attached_received");
  });
  it("order code summary", async () => {
    await pool.query(`INSERT INTO tracking_alias(code_normalised,type,order_id) SELECT 'CRAAAAAA','order',id FROM "order"`);
    const r = await lookup(pool, "CRAAAAAA");
    expect(r.outcome).toBe("order"); expect(r.parcels!.length).toBe(3);
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
