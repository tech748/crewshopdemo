# crew-core (M0 foundations)
Node 22 / TypeScript / Fastify / Postgres. Modular monolith.
- `npm test` — domain tests (state machines, arrival risk, codes)
- `DATABASE_URL=... npm run migrate` — apply SQL migrations
- `npm run dev` — /health
Business defaults live in `src/config.ts` (R85/parcel, 24h cut-off, 24h handling buffer, no COD cap, no auto-retention).
