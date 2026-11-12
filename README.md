# API Aberta — GTFS Connector

Unified GTFS schedules for Portuguese operators: Carris Metropolitana, Metro Lisboa, CP, Fertagus, Metro do Porto, and STCP.

Gateway prefix: `/gtfs`. Port **3018**. Database `apiaberta-gtfs`. pm2 name `apiaberta-gtfs`.

## Features

- Daily ingest at `0 4 * * *` Europe/Lisbon in a forked child (`--max-old-space-size=384`, 20 min timeout). 04:00 avoids overlapping connector-geo’s 03:30 sync.
- Departure window roll at `5 0 * * *`
- Streaming unzip (`yauzl`) + CSV (`csv-parse`) — `stop_times.txt` is never loaded into memory or extracted to disk
- Static tables and trips are stream-parsed and written with `bulkWrite` batches (1000); departures flush every 40 000 stop_times rows
- Per-feed `expired` flag when `valid_to` is before today
- No shapes or fares in v1

## Memory (v1.1)

The API process is capped at **192 MB** heap (`node_args` and `NODE_OPTIONS` in `ecosystem.config.cjs` — these must stay equal; production previously had 192 vs 256). `max_memory_restart` is 250M. Ingest does not use that cap: the child is forked with `--max-old-space-size=384`, which overrides inherited `NODE_OPTIONS`.

`gtfs.departures` stored one nested object per stop-time (field names, `ts`, denormalised `headsign` / `route_short_name`, plus a Mongoose subdocument `_id`). That was ~13 KiB/doc and ~319 MiB logical for ~26k docs. v1.1 stores packed strings `"HH:MM:SS\\ttrip_id\\troute_id"` instead (~5–7× smaller BSON). `headsign` and `route_short_name` are joined from `trips` / `routes` at read time for the page of results only. Expected effect: Mongo working set for this collection drops from hundreds of MiB toward tens of MiB; ingest peak RAM stays bounded by the 40k-row flush rather than a whole Carris day.

**Schema rollout:** `deps` is Mixed. Pre-1.1 object-shaped documents keep working. The next full ingest (or each date as the 00:05 job rewrites it) deletes that date and inserts packed docs. No new indexes. Unique `(feed_id, stop_id, date, part)` and `{ date: 1 }` are unchanged.

## Endpoints

- `GET /health` — service health
- `GET /gtfs/meta` — connector info and per-feed stats
- `GET /gtfs/feeds` — configured feeds
- `GET /gtfs/feeds/:feed_id` — one feed plus the last 5 diffs
- `GET /gtfs/changes?feed_id=&since=&limit=&offset=` — diff feed
- `GET /gtfs/routes?feed_id=&q=&route_type=&limit=&offset=`
- `GET /gtfs/routes/:feed_id/:route_id` — route, ordered stops, `trips_today`
- `GET /gtfs/stops?feed_id=&q=&near=lat,lon&radius=`
- `GET /gtfs/stops/:feed_id/:stop_id` — stop plus serving routes
- `GET /gtfs/stops/:feed_id/:stop_id/departures?date=&from=&limit=&route_id=`
- `GET /gtfs/departures/near?lat=&lon=&radius=&limit=`

Public route and response shapes are unchanged.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Optional env: `GTFS_WINDOW_DAYS` (1–3, default 2), `GTFS_FEEDS` (comma-separated ids; `carris` matches `carris-metropolitana`), `GTFS_INGEST_CRON` (default `0 4 * * *`), `GTFS_DEPARTURES_CRON` (default `5 0 * * *`).

Tests (`npm test`) and `npm run dev` must not use the production MongoDB URI.

## Data sources

Operator GTFS feeds (fixed URLs, dados.gov.pt, or Porto CKAN). Attribution per feed in `/gtfs/feeds`.

## License

MIT
