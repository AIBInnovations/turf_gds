# Turf GDS — local environment

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
