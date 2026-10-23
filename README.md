# MultiBhashi Admin Console

The staff console for the whole platform: AI tutor, learners, insights and cost today;
CRM, bookings, finance, trainers, classes, content, B2B and marketing next. The full plan
(architecture, panels, roles, permissions, security practices, roadmap) is in
[`docs/PLAN.md`](docs/PLAN.md).

```
api/   AdonisJS 6 (TypeScript) JSON API under /api   port 3500
web/   React 19 + Vite + Tailwind + shadcn/ui app     port 5175 (proxies /api)
docs/  PLAN.md
.env   shared by api/ (see .env.example)
```

## Run locally

Needs the Docker dev stack (`D:\MultiBhashi\dev-env`: MySQL on 3307, LiveKit on 7880) and
Node 22.

```bash
cd api
npm install
node --env-file=../.env ace migration:run      # console_* tables (tracked in console_api_schema)
node --env-file=../.env ace console:sync-roles # the 13 built-in roles

# Local-only demo data so every page has something to show (ids 5001+, removable):
node --env-file=../.env ace console:dev-schema
node --env-file=../.env ace console:seed-demo  # add --remove to delete it again

npm run dev                                    # API on http://localhost:3500

cd ../web && npm install && npm run dev        # console on http://localhost:5175
```

First Super Admin (prints a one-time setup link where they choose a password; with the
authenticator policy they also scan a QR code):

```bash
cd api && node --env-file=../.env ace console:bootstrap --email=you@company.com --name="Your Name"
```

Everyone else, including a second Super Admin, is invited from **Staff** in the console
(the invite can be emailed, or shared by link, WhatsApp or QR code).

Sign-in codes: without SMTP settings, local dev writes each email (code or invite) as JSON
to `api/tmp/mail/`; the subject starts with the code.

## Tests

```bash
cd api
node --env-file=../.env ace test unit                    # TOTP vectors, masking, password policy, cost model, role invariants
PORT=3510 node --env-file=../.env ace test functional    # end-to-end HTTP flows on the local DB
cd ../web && npx tsc --noEmit -p tsconfig.json && npx vite build
```

The functional tests create and remove their own learner (2001) and `@test.local` staff.
They never touch the shared test learners 1001–1003.

## Deploy (Docker, behind Traefik)

`deploy/docker-compose.yml` runs two containers: `admin-web` (nginx: the built app plus a
same-origin `/api` proxy, routed by Traefik with TLS) and `admin-api` (internal network only).
Fill `deploy/.env.production` from `deploy/.env.production.example`, then:

```bash
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml run --rm admin-api node ace migration:run --force
docker compose -f deploy/docker-compose.yml run --rm admin-api node ace console:sync-roles
docker compose -f deploy/docker-compose.yml run --rm admin-api node ace console:bootstrap --email=… --name="…"
docker compose -f deploy/docker-compose.yml up -d
```

Against a production database every write in the console is real (minutes, AI Pro, memory
erase). The demo/dev commands and the test suite refuse to run against a non-local database.

## Production notes

- Serve `web/dist` and proxy `/api` from the same origin (nginx); `CONSOLE_ORIGINS` must be
  that `https://` origin.
- Give the API its own MySQL user (writes only on the tables listed in PLAN.md §2;
  INSERT/SELECT only on `console_audit_logs`) and point `DB_ANALYTICS_*` at a read replica.
- `APP_KEY` signs sessions, hashes email codes and encrypts authenticator secrets: keep it in
  the secret store; rotating it signs everyone out (and forces authenticator re-enrolment).
- Email (sign-in codes and invites) with Gmail: turn on 2-Step Verification on the Google
  account, create an App Password (Google Account → Security → App passwords), then set
  `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=<the Gmail
  address>`, `SMTP_PASSWORD=<the 16-character app password>`,
  `MAIL_FROM="MultiBhashi Console <the Gmail address>"`. System health shows whether it
  connects. Until SMTP is set, production uses the authenticator app instead of email codes.
- Run `console:sync-roles` after every deploy that changes `app/rbac/roles.ts`.
- `console:dev-schema` and `console:seed-demo` refuse to run unless `NODE_ENV=development`
  and the database is on localhost.
"# Multibhashi-Admin" 


LANGFUSE_PUBLIC_KEY=pk-lf-c674e9c8-4e0a-4658-8334-177cf8449ec6
LANGFUSE_SECRET_KEY=sk-lf-26eed29c-7347-40b8-928d-19244f7a0db1
LANGFUSE_ADMIN_EMAIL=events@dextercapital.in
LANGFUSE_ADMIN_PASSWORD=2884320511f4cffac857d135
GRAFANA_ADMIN_PASSWORD=b841ca87d49f8a483221e75f
OTEL_INGEST_TOKEN=4200b1e850b78837e81ae6329c3879e5de8aad718b263352c28e4408a6930c47
NTFY_TOPIC=mb-tutor-alerts-a290d669c9604c37525f

I couldn't read the secrets myself: the permission system blocked printing them into this chat, and I won't work around that. Here's everything that isn't secret, and **one command** that shows you the secret values on your own screen.

**Run this to see the passwords and keys:**
```bash
ssh dexter-capital "grep -E '^(GRAFANA_ADMIN_PASSWORD|LANGFUSE_ADMIN_EMAIL|LANGFUSE_ADMIN_PASSWORD|LANGFUSE_PUBLIC_KEY|LANGFUSE_SECRET_KEY|NTFY_TOPIC|OTEL_INGEST_TOKEN)=' /opt/mb-observability/.env"
```

| Service | URL | Login | Secret in the file above |
|---|---|---|---|
| **Grafana** (dashboards, alerts) | https://grafana.93-127-172-184.sslip.io | user **`admin`** | `GRAFANA_ADMIN_PASSWORD` |
| **Langfuse** (LLM conversations) | https://langfuse.93-127-172-184.sslip.io | **`events@dextercapital.in`** | `LANGFUSE_ADMIN_PASSWORD` |
| Langfuse API keys (project **AI Tutor**, only for sending traces from code) | — | — | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` |
| **ntfy** phone alerts | the ntfy app, server `ntfy.sh` | subscribe to the topic | `NTFY_TOPIC` |
| Telemetry ingest token (production → Hostinger; keep private) | https://otel.93-127-172-184.sslip.io | — | `OTEL_INGEST_TOKEN` |
| **Admin panel** | https://admin.93-127-172-184.sslip.io | **`events@dextercapital.in`** | the password you chose through your setup link (not stored anywhere I can read) |

**Grafana and Langfuse in more detail:**
- **Grafana:** under Dashboards → folder **Tutor**: *Overview & API*, *Voice latency & providers*, *Class explorer*. Filter by `deployment_environment` = production or staging.
- **Langfuse:** organisation **Multibhashi**, project **AI Tutor**. Sign-up is off; add teammates from inside Langfuse (Settings → Members).

**Where everything is kept:**
- **Hostinger, `/opt/mb-observability/.env`:** the secrets above, plus the internal database passwords (Postgres, ClickHouse, MinIO, Redis). Those services aren't reachable from outside, so you never need them to log in.
- **Production server, `/var/www/html/multibhashi-tutor-agent/deploy/production/otel.env`:** its copy of the ingest token.
- **Hostinger, `/opt/multibhashi-admin/deploy/.env.production`:** the admin panel's secrets.

After your first login, change the Grafana password (profile → Change password) and the Langfuse password (Settings).