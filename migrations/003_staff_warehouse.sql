-- M3: warehouses, staff auth, intake scans, handover hardening.
CREATE TABLE warehouse (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  port_id uuid NOT NULL REFERENCES port(id),
  code text NOT NULL UNIQUE, name text NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Single STAFF role; is_ops_manager unlocks pricing overrides + handover unlock.
CREATE TABLE staff_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL, full_name text NOT NULL,
  password_hash text NOT NULL,                       -- scrypt, see src/modules/staff/password.ts
  is_ops_manager boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0, locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_user_email_uq ON staff_user (lower(email));
CREATE TABLE staff_warehouse (                       -- which warehouses a staff member may log in to
  staff_id uuid NOT NULL REFERENCES staff_user(id), warehouse_id uuid NOT NULL REFERENCES warehouse(id),
  PRIMARY KEY (staff_id, warehouse_id)
);
CREATE TABLE staff_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,                   -- sha256 of cookie token; raw token never stored
  staff_id uuid NOT NULL REFERENCES staff_user(id),
  warehouse_id uuid NOT NULL REFERENCES warehouse(id),  -- locked at login
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE parcel ADD COLUMN warehouse_id uuid REFERENCES warehouse(id);
CREATE INDEX parcel_unmatched_idx ON parcel(warehouse_id) WHERE order_id IS NULL;
CREATE TABLE intake_scan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_scan_id text NOT NULL UNIQUE,               -- idempotency key from the device (retry/offline safe)
  warehouse_id uuid NOT NULL REFERENCES warehouse(id), staff_id uuid NOT NULL REFERENCES staff_user(id),
  code_normalised text NOT NULL, parcel_id uuid REFERENCES parcel(id),
  result text NOT NULL CHECK (result IN ('received','already_received','unmatched','ambiguous')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Handover: verify against ONE order only; display copy encrypted, verify copy keyed-hashed.
ALTER TABLE "order" ADD COLUMN handover_code_enc text,
  ADD COLUMN handover_failed_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN handover_locked_at timestamptz,
  ADD COLUMN rush_fee_cents int NOT NULL DEFAULT 0;
