/**
 * Create/update a staff user.  STAFF_PASSWORD=... npm run staff:create -- ops@x.com "Full Name" CPT-HUB[,DUR-HUB] [--ops]
 * Password comes from the environment only (never argv, so it stays out of shell history / process lists).
 */
import { pool } from "./pool.js";
import { hashPassword } from "../modules/staff/password.js";

const [email, fullName, whCodes] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const isOps = process.argv.includes("--ops");
const pw = process.env.STAFF_PASSWORD;
if (!email || !fullName || !whCodes || !pw) { console.error('usage: STAFF_PASSWORD=... staff:create <email> "<name>" <WH1[,WH2]> [--ops]'); process.exit(1); }
if (pw.length < 12) { console.error("STAFF_PASSWORD must be at least 12 characters"); process.exit(1); }

const wh = await pool.query(`SELECT id, code FROM warehouse WHERE code = ANY($1) AND active`, [whCodes.split(",")]);
if (wh.rowCount !== whCodes.split(",").length) { console.error("unknown/inactive warehouse code in:", whCodes); process.exit(1); }
const u = await pool.query(
  `INSERT INTO staff_user(email,full_name,password_hash,is_ops_manager) VALUES ($1,$2,$3,$4)
   ON CONFLICT (lower(email)) DO UPDATE SET full_name=EXCLUDED.full_name, password_hash=EXCLUDED.password_hash, is_ops_manager=EXCLUDED.is_ops_manager, active=true, failed_logins=0, locked_until=NULL
   RETURNING id`, [email, fullName, await hashPassword(pw), isOps]);
await pool.query(`DELETE FROM staff_warehouse WHERE staff_id=$1`, [u.rows[0].id]);
for (const w of wh.rows) await pool.query(`INSERT INTO staff_warehouse VALUES ($1,$2)`, [u.rows[0].id, w.id]);
console.log(`staff ${email} ready (${isOps ? "OPS_MANAGER" : "STAFF"}) @ ${whCodes}`);
await pool.end();
