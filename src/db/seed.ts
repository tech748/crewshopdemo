import { pool } from "./pool.js";

await pool.query(`TRUNCATE tracking_alias, order_line, parcel, delivery_booking, "order", port_call, assignment, vessel, port RESTART IDENTITY CASCADE`);
const port = (await pool.query(`INSERT INTO port(code,name,delivery_address) VALUES
  ('ZADUR','Durban','Gate 3, Maydon Wharf Rd, Durban (demo address)'),
  ('ZACPT','Cape Town','V&A Waterfront Gate 1 (demo address)') RETURNING id,code`)).rows;
const dur = port.find((p) => p.code === "ZADUR")!.id;
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
await parcel(ord, "received", "J Dela Cruz", ["1Z999AA10123456784", "carrier"]);   // outcome 1
await parcel(ord, "expected", "J Dela Cruz", ["TBA123456789", "carrier"]);         // outcome 2
await parcel(null, "received", "A Petrov", ["AMZUNATTACH001", "carrier"]);         // outcome 3
// outcome 4: any code not in DB
console.log("seeded");
await pool.end();
