# Staging deploy (Railway; Fly/Render work with the same Dockerfile)
1. Push this folder to a private GitHub repo.
2. Railway -> New Project -> Deploy from GitHub repo. Add a **PostgreSQL** plugin.
3. Variables on the app service:
   - `DATABASE_URL` = reference to the Postgres plugin URL
   - `NODE_ENV=staging`
   - `PII_ENCRYPTION_KEY` = output of `openssl rand -hex 32` (**store it safely; losing it makes stored PII unreadable**)
   - `WHATSAPP_NUMBER` = your number, digits only, e.g. 27821234567
4. Deploy. Migrations run on start. Health check: `/health`.
5. Load demo data once (staging ONLY, it truncates tables): in the Railway shell run `npx tsx src/db/seed.ts`
   (needs devDependencies; or run it locally with DATABASE_URL pointing at the staging DB).
6. Open `https://<your-app>.up.railway.app/demo` and `/book`.
Region: pick EU or Africa-nearest. Turn on Postgres backups before real data.
