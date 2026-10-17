import type { Db } from "../../db/pool.js";

/** Append-only audit entry (DB trigger forbids update/delete). Never put PII in before/after. */
export async function audit(
  db: Db,
  a: { actor: "staff" | "system" | "customer"; actorId?: string | null; entity: string; entityId: string; action: string; before?: unknown; after?: unknown },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,before,after) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [a.actor, a.actorId ?? null, a.entity, a.entityId, a.action,
     a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after)],
  );
}
