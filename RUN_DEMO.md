# See the engine on your own computer (needs Node 22 + Docker)
    docker compose up -d
    npm install
    export DATABASE_URL=postgres://postgres:dev@localhost:5432/crew
    npm run migrate && npm run seed
    npm run dev          # http://localhost:3000/demo
Open http://localhost:3000/demo on your PC (or your phone on the same Wi-Fi via your PC's IP).
Tap the example chips to see the 6 lookup scenarios. Demo data only.
Optional staff login: `SEED_STAFF_PASSWORD='<pick one>' npm run seed`, then POST /v1/staff/login (see docs/API_M2_1_M3.md).
