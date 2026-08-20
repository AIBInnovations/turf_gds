# Turf GDS — local environment

## Repository layout

There is no monorepo. Each piece is its own repository, and they are expected to sit side by side
in one parent folder — `scripts/dev.sh` and `scripts/seed.mjs` both resolve the apps as siblings
of this backend, and skip any that is not checked out:

```
<parent>/
  turf_gds/                    this repo — API, worker, seed script
  turfgang-admin-portal/       admin console      (Vercel)
  turfgang-owner-web/          venue-owner web    (Vercel)
  turfgang-partner-console/    partner console    (Vercel)
  turfgang-owner-mobile/       React Native app
```

Each app repo vendors its own copy of `packages/ui` and `packages/api-client` and declares
`"workspaces": ["packages/*"]`. **Never copy `package.json`, `package-lock.json`, `.gitignore`,
`next.config.ts` or `vercel.json` between repos** — those are per-repo, and overwriting them is
what previously stripped the `workspaces` declaration and broke every deploy with an
`npm 404 @turfgang/api-client`.

## Status

| Piece | State |
|---|---|
| Backend API | Running on `http://localhost:3000`, base path `/api/v1` |
| Worker | Running (required — see below) |
| MongoDB | Local single-node replica set `rs0` on `127.0.0.1:27017` |
| Cloudinary | Connected (`/ready` reports `cloudinary: up`) |

## ⚠️ MongoDB Atlas credentials are rejected

The Atlas URI supplied for this project fails with `bad auth : authentication failed`:

```
mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?appName=Cluster0
```

That is a credential rejection from Atlas itself, not a network or IP-allowlist problem. Either the
database user's password differs, or the user does not exist on that cluster. **Fix it in Atlas →
Database Access, then set `MONGODB_URI` in `turf_gds/.env`**, which is gitignored and is the only
place the real connection string should ever live.

Development uses a local replica set until then. A replica set — not a standalone `mongod` — is
mandatory, because the backend uses multi-document transactions throughout.

## Starting from scratch

```sh
# 1. MongoDB (once per machine reboot)
export PATH="/opt/homebrew/opt/mongodb-community@8.0/bin:$PATH"
mongod --dbpath ~/data/turfgang-db --logpath ~/data/turfgang-log/mongod.log \
       --replSet rs0 --bind_ip 127.0.0.1 --port 27017 --fork
mongosh --quiet --eval 'rs.status().members[0].stateStr'   # expect PRIMARY

# 2. Backend (two processes, both required)
cd turf_gds
npm run dev          # API    → http://localhost:3000
npm run worker:dev   # worker → outbox delivery, hold expiry, payout reconciliation
```

**The worker is not optional.** Without it, expired slot holds are never released (inventory
leaks), webhooks never deliver, and owner notifications never arrive. `/ready` surfaces this as
`dependencies.backgroundJobs: stale | down` — but deliberately still reports `status: ready`, so
alert on the field, not the overall status.

First-time only:

```sh
npm run db:init        # collections, validators, indexes, role-permission seed
npm run admin:create   # bootstrap admin from BOOTSTRAP_* vars in .env
```

## Seeded credentials

Platform admin (from `.env`, change before any real deployment):

- `admin@turfgang.com` / `TurfGang@Admin2026` — role `ADMIN`

## Health checks

```sh
curl localhost:3000/health   # liveness
curl localhost:3000/ready    # mongodb + cloudinary + backgroundJobs
curl localhost:3000/api/v1   # { service, apiVersion }
curl 'localhost:3000/api/v1/openapi.json?partner=true'   # partner-only OpenAPI surface
```

## Secrets note

`ADMIN_ACCESS_TOKEN_SECRET` and `PARTNER_CREDENTIAL_MASTER_SECRET` are freshly generated 32-byte
hex values and **must not be equal** — the config loader refuses to boot if they are.

Rotating `PARTNER_CREDENTIAL_MASTER_SECRET` invalidates every partner API key at once, because
signing secrets are derived from it rather than stored.

## Deploying the web apps to Vercel

`turfgang-admin-portal`, `turfgang-owner-web` and `turfgang-partner-console` each carry a
`vercel.json`. All three are Next.js App Router apps, so Vercel routes them natively — there is
**no** SPA catch-all rewrite, and adding one (`/(.*) → /index.html`) would break them, because
there is no `index.html` to serve.

Each app is its own repository whose root *is* the app, so the dashboard needs nothing unusual:
leave **Root Directory** empty and **Include files outside root directory** off. `vercel.json`
sets the framework and output directory; install and build are the defaults.

What each repo must keep for the build to resolve its shared code:

| File | Why |
| --- | --- |
| `package.json` → `"workspaces": ["packages/*"]` | tells npm that `@turfgang/ui` and `@turfgang/api-client` are the vendored local packages, not registry ones |
| `package-lock.json` | records those links |
| `packages/ui`, `packages/api-client` | the vendored source itself |

Losing the first two is how a deploy fails with `npm error 404 … @turfgang/api-client`: npm falls
back to the public registry, where those names do not exist. When copying code between repos,
copy **only** `src/` and `packages/*/src/` — never `package.json`, `package-lock.json`,
`.gitignore`, `next.config.ts` or `vercel.json`.

### Required environment variable

```
API_ORIGIN=https://your-backend-host
```

Both apps proxy `/api/*` and `/ready` to `API_ORIGIN` through a Next rewrite, which is what keeps
browser requests same-origin — the backend still registers no CORS plugin, so a direct
cross-origin call from the deployed frontend is refused. `API_ORIGIN` defaults to
`http://localhost:3000`, which exists only on a developer machine: leave it unset in a deployment
and every API call fails while the pages themselves render fine.

### Why `distDir` is conditional

Locally, production builds go to `.next-build` so that running `npm run build` cannot overwrite
the `.next` a dev server is still reading. Vercel's builder only ever looks in `.next`, and it
builds with `NODE_ENV=production` — so on Vercel (`process.env.VERCEL`) the split is switched
off. Without that guard the output lands in `.next-build`, Vercel finds an empty `.next`, and
**every route 404s** even though the build log says it succeeded.
