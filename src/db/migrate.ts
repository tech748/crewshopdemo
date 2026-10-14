import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { env } from "../config.js";

const dir = join(process.cwd(), "migrations");
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
await client.query("CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, at timestamptz DEFAULT now())");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  const done = await client.query("SELECT 1 FROM _migrations WHERE name=$1", [f]);
  if (done.rowCount) continue;
  await client.query("BEGIN");
  try {
    await client.query(readFileSync(join(dir, f), "utf8"));
    await client.query("INSERT INTO _migrations(name) VALUES ($1)", [f]);
    await client.query("COMMIT");
    console.log("applied", f);
  } catch (e) { await client.query("ROLLBACK"); throw e; }
}
await client.end();
