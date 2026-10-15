import type { Db } from "../db/pool.js";
import { anonymisePerson, retentionCandidatesSql } from "../domain/retention.js";
import { business } from "../config.js";

/** Anonymises people with no order activity in `months`. Returns count. Run daily (cron / scheduler). */
export async function runRetention(db: Db, months = business.retentionMonths): Promise<number> {
  if (months == null) return 0;
  const { rows } = await db.query(retentionCandidatesSql, [months]);
  for (const r of rows) await anonymisePerson(db, r.id, "system:retention");
  return rows.length;
}
