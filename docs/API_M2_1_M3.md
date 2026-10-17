# API spec: M2.1 Lookup + M3 Staff (handoff)

All staff routes need the `crew_staff` cookie (httpOnly, SameSite=Strict, Secure in staging/prod, 12h). Errors: `{ "code": "...", "message"?: "..." }`.
Every mutation writes an append-only `audit_log` row (no PII in before/after) and, where Monday is affected, an `outbox_job`.

## Public: `GET /v1/lookup/:code[?surname=]`  (20/min/IP)
Returns `LookupResult` (`src/modules/lookup/types.ts`), discriminated by `kind`. No names or addresses are ever returned.

| kind | Scenario | Key fields |
|---|---|---|
| `in_warehouse_paid` | 1 | `orderCode, portName, deliveryDate, payment{status:"paid"}` |
| `in_warehouse_unpaid` | 2 | + `payment.options: [{card,url}, {cod}]` |
| `in_transit_paid` | 3 | as 1 (UI shows "On the way to warehouse · Paid in Full") |
| `in_transit_unpaid` | 4 | as 2 |
| `in_warehouse_unlinked` | 5 | `bookUrl, prefill.parcelCodes, baseCents (8500)` |
| `no_record` | 6 | `bookUrl, baseCents` |
| `order_summary` | (customer typed our own order code) | order facts + `parcels[].status` |
| `needs_second_factor` / `invalid_code` | (carrier-code collision / bad input) | none |

- `payment.options[].card.url` is **null until Paystack (M7)**; UI shows a disabled "coming soon" button.
- Orders in `manual_review` return `options: []` and `awaitingStaffPricing: true`, so no one pays before the price is final.

## Staff auth
| Route | Notes |
|---|---|
| `GET /v1/staff/warehouses` | Public list for the login picker (id, code, name, portName). |
| `POST /v1/staff/login` `{email,password,warehouseId}` | 10/min/IP. Account locks 15 min after 5 failures (423). Warehouse must be on the user's allow-list (403). Session is locked to that warehouse. |
| `GET /v1/staff/me` · `POST /v1/staff/logout` | Logout revokes server-side. |

Roles: one `STAFF` role; `is_ops_manager` additionally unlocks `approve`, `reject`, handover `unlock`.

## Receiving & unmatched queue
- `POST /v1/staff/intake` `{clientScanId (8-64, idempotency key), code, weightKg?, bin?}` -> 201 (200 + `replay:true` on retry)
  `result`: `received` | `already_received` | `unmatched` (unknown code: parcel created in this warehouse) | `ambiguous` (code matches >1 parcel; nothing changed).
  Also returns `linked`, `orderCode`, `portMismatch` (parcel's order is for another port).
- `GET /v1/staff/unmatched`: unlinked parcels in the session's warehouse (codes, ageHours, bin, weight, label name).
- `POST /v1/staff/unmatched/:parcelId/match` `{orderCode}`: same-port only (409 `port_mismatch`), open orders only.

## Manual review (inside the 24h cut-off)
- `GET /v1/staff/manual-review`: queue for the warehouse's port.
- `POST /v1/staff/orders/:code/approve` *(Ops)* `{rushFeeCents?: 0..1_000_000}` -> `awaiting_payment` (COD orders -> `cod_pending_verification`).
  Adds a "Rush fee (staff override)" order line and updates total. **Blocked once paid** (409 `already_paid`) or if not in review.
- `POST /v1/staff/orders/:code/reject` *(Ops)* `{reason}` -> `cancelled`.

## Gangway handover
- `POST /v1/staff/handover` `{orderCode, code (6 digits), codCollected?}`
  1. Order must be `confirmed` (409 `order_not_confirmed`), and all its parcels received **at this warehouse** (409 `parcels_not_ready`).
  2. Code is verified against **this order only**. 5 wrong codes lock the order (423 `handover_locked`); counted under a row lock so parallel guessing can't bypass it.
  3. COD: a correct code without `codCollected` returns 409 `cod_collection_required` + `amountDueCents`. Re-send with `codCollected:true` to record cash, deliver all parcels, and complete the order.
- `POST /v1/staff/handover/:orderCode/unlock` *(Ops)*.

### Handover code lifecycle (important for M6/M7)
`issueHandoverCode(db, orderId)` (`handoverService.ts`) creates the 6-digit code for a **confirmed** order (idempotent). Stored as keyed hash (verify) + AES-GCM ciphertext (display). **M6 (COD verification) and M7 (Paystack webhook) must call it in the transition to `confirmed`**, and a recipient-authenticated endpoint must expose it to their phone. Neither exists yet.

## Ops
- Create staff: `STAFF_PASSWORD=<12+ chars> npm run staff:create -- ops@x.com "Name" CPT-HUB,DUR-HUB --ops`
- Demo seed: `SEED_STAFF_PASSWORD=... npm run seed` (creates `ops@demo.test`; no default password).
