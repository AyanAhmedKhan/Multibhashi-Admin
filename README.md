# MultiBhashi Admin Console

The staff console for the whole platform: AI tutor, learners, insights and cost today;
CRM, bookings, finance, trainers, classes, content, B2B and marketing next. The full plan
(architecture, panels, roles, permissions, security practices, roadmap) is in
[`docs/PLAN.md`](docs/PLAN.md).

```
api/   AdonisJS 6 (TypeScript) JSON API under /api   port 3500
web/   React 18 + Vite + Tailwind single-page app     port 5175 (proxies /api)
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

First Super Admin (prints a one-time setup link where they choose a password and scan the
authenticator QR code):

```bash
cd api && node --env-file=../.env ace console:bootstrap --email=you@company.com --name="Your Name"
```

Everyone else is invited from **Staff** in the console.

## Tests

```bash
cd api
node --env-file=../.env ace test unit                    # TOTP vectors, masking, password policy, role invariants
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
- `APP_KEY` signs sessions and encrypts MFA secrets: keep it in the secret store; rotating
  it signs everyone out and forces MFA re-enrolment.
- Run `console:sync-roles` after every deploy that changes `app/rbac/roles.ts`.
- `console:dev-schema` and `console:seed-demo` refuse to run unless `NODE_ENV=development`
  and the database is on localhost.
"# Multibhashi-Admin" 
