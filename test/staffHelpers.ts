import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/modules/staff/password.js";

export const PW = "correct horse battery";
export interface World { cpt: string; dur: string; whCpt: string; whDur: string; ops: string; clerk: string; order: string; port: string }

export async function reset(pool: pg.Pool) {
  await pool.query(`TRUNCATE staff_session, staff_warehouse, staff_user, intake_scan, warehouse, payment, order_line, delivery_booking,
    tracking_alias, parcel, "order", port_call, vessel, port RESTART IDENTITY CASCADE`);
}

/** Two ports/warehouses, an ops manager (both), a clerk (Cape Town only), and one confirmed COD order for Cape Town. */
export async function seedWorld(pool: pg.Pool): Promise<World> {
  await reset(pool);
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0].id as string;
  const cpt = await q(`INSERT INTO port(code,name,delivery_address) VALUES ('ZACPT','Cape Town','x') RETURNING id`);
  const dur = await q(`INSERT INTO port(code,name,delivery_address) VALUES ('ZADUR','Durban','x') RETURNING id`);
  const whCpt = await q(`INSERT INTO warehouse(port_id,code,name) VALUES ($1,'CPT-HUB','Cape Town Harbor Hub') RETURNING id`, [cpt]);
  const whDur = await q(`INSERT INTO warehouse(port_id,code,name) VALUES ($1,'DUR-HUB','Durban Port Hub') RETURNING id`, [dur]);
  const hash = await hashPassword(PW);
  const ops = await q(`INSERT INTO staff_user(email,full_name,password_hash,is_ops_manager) VALUES ('ops@crew.test','Ops',$1,true) RETURNING id`, [hash]);
  const clerk = await q(`INSERT INTO staff_user(email,full_name,password_hash) VALUES ('clerk@crew.test','Clerk',$1) RETURNING id`, [hash]);
  for (const [s, w] of [[ops, whCpt], [ops, whDur], [clerk, whCpt]]) await pool.query(`INSERT INTO staff_warehouse VALUES ($1,$2)`, [s, w]);
  const v = await q(`INSERT INTO vessel(name) VALUES ('MV Test') RETURNING id`);
  const pc = await q(`INSERT INTO port_call(vessel_id,port_id,eta,eta_source) VALUES ($1,$2,now()+interval '5 days','customer') RETURNING id`, [v, cpt]);
  const order = await mkOrder(pool, pc, "CRORDER001", { status: "confirmed", payment_status: "cod_pending", payment_method: "cod" });
  return { cpt, dur, whCpt, whDur, ops, clerk, order, port: pc };
}

export async function mkOrder(pool: pg.Pool, portCall: string, code: string, f: Record<string, unknown> = {}): Promise<string> {
  const o = { status: "draft", payment_status: "unpaid", payment_method: "prepaid", total_cents: 8500, ...f };
  const id = (await pool.query(`INSERT INTO "order"(public_code,port_call_id,status,payment_status,payment_method,total_cents) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [code, portCall, o.status, o.payment_status, o.payment_method, o.total_cents])).rows[0].id;
  await pool.query(`INSERT INTO tracking_alias(code_normalised,type,order_id) VALUES ($1,'order',$2)`, [code, id]);
  await pool.query(`INSERT INTO delivery_booking(order_id,port_call_id) VALUES ($1,$2)`, [id, portCall]);
  return id;
}
export async function mkParcel(pool: pg.Pool, orderId: string | null, status: string, code: string, warehouseId: string | null = null): Promise<string> {
  const id = (await pool.query(`INSERT INTO parcel(order_id,status,warehouse_id,received_at) VALUES ($1,$2,$3,CASE WHEN $2<>'expected' THEN now() END) RETURNING id`, [orderId, status, warehouseId])).rows[0].id;
  await pool.query(`INSERT INTO tracking_alias(code_normalised,type,parcel_id) VALUES ($1,'carrier',$2)`, [code, id]);
  return id;
}

export async function loginAs(app: FastifyInstance, email: string, warehouseId: string, password = PW) {
  const res = await app.inject({ method: "POST", url: "/v1/staff/login", payload: { email, password, warehouseId } });
  const raw = res.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0] ?? "";
  return { res, cookie, headers: { cookie } };
}
