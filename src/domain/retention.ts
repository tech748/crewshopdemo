import type { Db } from "../db/pool.js";
/**
 * POPIA/GDPR-friendly retention: strip personal identifiers, KEEP operational/statistical
 * records (orders, parcels, vessel calls, dates). Orders keep their person FK but the
 * person row no longer identifies anyone.
 */
export async function anonymisePerson(db: Db, personId: string, actor: string): Promise<void> {
  await db.query(
    `UPDATE person SET phone_enc=NULL, phone_hash=NULL, email_enc=NULL, full_name_enc=NULL, erased_at=now(), updated_at=now() WHERE id=$1`,
    [personId],
  );
  await db.query(`UPDATE parcel SET label_name=NULL WHERE order_id IN (SELECT id FROM "order" WHERE recipient_person_id=$1 OR payer_person_id=$1)`, [personId]);
  await db.query(
    `INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES ('staff',$2,'person',$1,'anonymise')`,
    [personId, actor],
  );
}
/** Candidates once a policy period is chosen: people whose last order is older than N months. */
export const retentionCandidatesSql = `
  SELECT p.id FROM person p
  WHERE p.erased_at IS NULL AND p.updated_at < now() - make_interval(months => $1) AND NOT EXISTS (
    SELECT 1 FROM "order" o WHERE (o.recipient_person_id=p.id OR o.payer_person_id=p.id)
      AND o.updated_at > now() - make_interval(months => $1))`;
