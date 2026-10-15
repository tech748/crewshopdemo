CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE person (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text, phone_hash text UNIQUE,      -- phone encrypted app-side; hash for lookup
  email_enc text, full_name_enc text,
  language text NOT NULL DEFAULT 'en',
  erased_at timestamptz,                         -- erasure-on-request (POPIA/GDPR)
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE consent_record (                    -- append-only
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES person(id),
  channel text NOT NULL CHECK (channel IN ('whatsapp','email')),
  purpose text NOT NULL CHECK (purpose IN ('transactional','marketing')),
  granted boolean NOT NULL, wording_version text NOT NULL,
  source text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE vessel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imo text UNIQUE, name text NOT NULL, operator text, verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES person(id), vessel_id uuid NOT NULL REFERENCES vessel(id),
  from_date date NOT NULL DEFAULT current_date, to_date date,
  source text NOT NULL DEFAULT 'declared'
);
CREATE TABLE port (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE, name text NOT NULL, delivery_address text NOT NULL,
  cutoff_hours int NOT NULL DEFAULT 24, handling_buffer_hours int NOT NULL DEFAULT 0,
  notes text, active boolean NOT NULL DEFAULT true, synced_from_monday_at timestamptz
);
CREATE TABLE port_call (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id uuid NOT NULL REFERENCES vessel(id), port_id uuid NOT NULL REFERENCES port(id),
  eta timestamptz NOT NULL, etd timestamptz,
  eta_source text NOT NULL CHECK (eta_source IN ('customer','staff','ais','agent')),
  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('low','med','high'))
);
CREATE TABLE partner (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, api_key_hash text NOT NULL UNIQUE,
  webhook_url text, webhook_secret_enc text, active boolean NOT NULL DEFAULT true
);
CREATE TABLE "order" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code text NOT NULL UNIQUE,
  payer_person_id uuid REFERENCES person(id), recipient_person_id uuid REFERENCES person(id),
  port_call_id uuid REFERENCES port_call(id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','manual_review','awaiting_payment','cod_pending_verification','confirmed','completed','cancelled','refunded')),
  payment_status text NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','paid','cod_pending','cod_collected','refunded','credited')),
  payment_method text CHECK (payment_method IN ('prepaid','cod')),
  cod_verified_at timestamptz, handover_code_hash text,
  risk_flags text[] NOT NULL DEFAULT '{}',          -- system flags, a human decides
  source text NOT NULL DEFAULT 'web' CHECK (source IN ('web','whatsapp','partner','staff')),
  partner_id uuid REFERENCES partner(id),
  manual_review boolean NOT NULL DEFAULT false,
  total_cents int NOT NULL DEFAULT 0, currency text NOT NULL DEFAULT 'ZAR',
  arrival_risk text CHECK (arrival_risk IN ('on_track','at_risk','will_miss')),
  monday_item_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE parcel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES "order"(id),            -- NULL = unattached parcel
  status text NOT NULL DEFAULT 'expected'
    CHECK (status IN ('expected','in_transit','received','ready','out_for_delivery','delivered','exception')),
  received_at timestamptz, label_name text, label_vessel text, weight_kg numeric(6,2),
  bin text, notes text, monday_item_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parcel_order_idx ON parcel(order_id);
CREATE TABLE tracking_alias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_normalised text NOT NULL, type text NOT NULL CHECK (type IN ('order','carrier','declared')),
  parcel_id uuid REFERENCES parcel(id), order_id uuid REFERENCES "order"(id),
  CHECK (parcel_id IS NOT NULL OR order_id IS NOT NULL),
  UNIQUE (code_normalised, type, parcel_id)
);
CREATE INDEX alias_code_idx ON tracking_alias(code_normalised);
CREATE TABLE delivery_booking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES "order"(id), port_call_id uuid NOT NULL REFERENCES port_call(id),
  confirmed boolean NOT NULL DEFAULT false, delivered_at timestamptz, handover_confirmed_at timestamptz
);
CREATE TABLE price_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('base','promo','package')),
  params jsonb NOT NULL, priority int NOT NULL DEFAULT 0,
  active_from timestamptz, active_to timestamptz
);
INSERT INTO price_rule (kind, params) VALUES ('base', '{"perParcelCents":8500}');
CREATE TABLE order_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES "order"(id), parcel_id uuid REFERENCES parcel(id),
  description text NOT NULL, amount_cents int NOT NULL, rule_id uuid REFERENCES price_rule(id)
);
CREATE TABLE payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES "order"(id), provider text NOT NULL, provider_ref text,
  amount_cents int NOT NULL, currency text NOT NULL DEFAULT 'ZAR', status text NOT NULL,
  event_hash text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE message_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid REFERENCES person(id), order_id uuid REFERENCES "order"(id),
  channel text NOT NULL, template text NOT NULL, status text NOT NULL,
  provider_msg_id text, at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL, payload jsonb NOT NULL, dedupe_key text UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','dead')),
  attempts int NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(), last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inbox_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL, dedupe_key text UNIQUE, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending', received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('staff','system','customer','partner')),
  actor_id text, entity text NOT NULL, entity_id text NOT NULL, action text NOT NULL,
  before jsonb, after jsonb, at timestamptz NOT NULL DEFAULT now()
);
-- Append-only enforcement
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_ro BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER consent_ro BEFORE UPDATE OR DELETE ON consent_record FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
