import { pool } from "./pool.js";

if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed (truncates tables) in production");

await pool.query(`TRUNCATE staff_session, staff_warehouse, staff_user, intake_scan, warehouse, payment, tracking_alias, order_line, parcel, delivery_booking, "order", port_call, assignment, vessel, port RESTART IDENTITY CASCADE`);
const port = (await pool.query(`INSERT INTO port(code,name,delivery_address) VALUES
  ('ZADUR','Durban','Gate 3, Maydon Wharf Rd, Durban (demo address)'),
  ('ZACPT','Cape Town','V&A Waterfront Gate 1 (demo address)') RETURNING id,code`)).rows;
const cpt = port.find((p) => p.code === "ZACPT")!.id;
const dur = port.find((p) => p.code === "ZADUR")!.id;
await pool.query(`INSERT INTO warehouse(port_id,code,name) VALUES ($1,'CPT-HUB','Cape Town Harbor Hub'),($2,'DUR-HUB','Durban Port Hub')`, [cpt, dur]);
const v = (await pool.query(`INSERT INTO vessel(imo,name) VALUES ('9999991','MV Demo Star') RETURNING id`)).rows[0].id;
const pc = (await pool.query(`INSERT INTO port_call(vessel_id,port_id,eta,eta_source) VALUES ($1,$2, now()+interval '6 days','customer') RETURNING id`, [v, dur])).rows[0].id;
const ord = (await pool.query(`INSERT INTO "order"(public_code,port_call_id,status,payment_status,payment_method,total_cents,arrival_risk)
  VALUES ('CRK7M2QX',$1,'confirmed','paid','prepaid',17000,'on_track') RETURNING id`, [pc])).rows[0].id;
const parcel = async (orderId: string | null, status: string, label: string | null, ...codes: [string, string][]) => {
  const id = (await pool.query(`INSERT INTO parcel(order_id,status,label_name,received_at) VALUES ($1,$2,$3, CASE WHEN $2='received' THEN now() END) RETURNING id`, [orderId, status, label])).rows[0].id;
  for (const [c, t] of codes) await pool.query(`INSERT INTO tracking_alias(code_normalised,type,parcel_id) VALUES ($1,$2,$3)`, [c, t, id]);
  return id;
};
await pool.query(`INSERT INTO tracking_alias(code_normalised,type,order_id) VALUES ('CRK7M2QX','order',$1)`, [ord]);
// Scenario 1: here + order + paid;  3: in transit + order + paid
await parcel(ord, "received", "J Dela Cruz", ["1Z999AA10123456784", "carrier"]);
await parcel(ord, "expected", "J Dela Cruz", ["TBA123456789", "carrier"]);
// Scenario 2: here + order + unpaid (COD);  4: in transit + order + unpaid
const unpaid = (await pool.query(`INSERT INTO "order"(public_code,port_call_id,status,payment_status,payment_method,total_cents,arrival_risk)
  VALUES ('CRU9P4ZT',$1,'awaiting_payment','unpaid','prepaid',17000,'on_track') RETURNING id`, [pc])).rows[0].id;
await pool.query(`INSERT INTO tracking_alias(code_normalised,type,order_id) VALUES ('CRU9P4ZT','order',$1)`, [unpaid]);
await parcel(unpaid, "received", "M Santos", ["1ZUNPAID0000001", "carrier"]);
await parcel(unpaid, "expected", "M Santos", ["TBAUNPAID000002", "carrier"]);
// Scenario 5: here, no order
await parcel(null, "received", "A Petrov", ["AMZUNATTACH001", "carrier"]);
// Scenario 6: any code not in the DB (e.g. NOSUCHCODE123)

// Optional staff demo login (staging has a public URL: no default password, supply SEED_STAFF_PASSWORD).
if (process.env.SEED_STAFF_PASSWORD) {
  const { hashPassword } = await import("../modules/staff/password.js");
  const h = await hashPassword(process.env.SEED_STAFF_PASSWORD);
  const ops = (await pool.query(`INSERT INTO staff_user(email,full_name,password_hash,is_ops_manager) VALUES ('ops@demo.test','Demo Ops',$1,true) RETURNING id`, [h])).rows[0].id;
  await pool.query(`INSERT INTO staff_warehouse SELECT $1, id FROM warehouse`, [ops]);
  console.log("seeded staff ops@demo.test (OPS_MANAGER, both warehouses)");
}
console.log("seeded");
await pool.end();
