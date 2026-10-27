# API Aberta — GTFS Connector

Unified GTFS schedules for Portuguese operators: Carris Metropolitana, Metro Lisboa, CP, Fertagus, Metro do Porto, and STCP.

Gateway prefix: `/gtfs`. Port **3018**. Database `apiaberta-gtfs`. pm2 name `apiaberta-gtfs`.

## Features

- Daily ingest at `30 3 * * *` Europe/Lisbon in a forked child (`--max-old-space-size=384`, 20 min timeout)
- Departure window roll at `5 0 * * *`
- Streaming unzip (`yauzl`) + CSV (`csv-parse`) — `stop_times.txt` is never loaded into memory or extracted to disk
- Per-feed `expired` flag when `valid_to` is before today
- No shapes or fares in v1

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

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Optional env: `GTFS_WINDOW_DAYS` (1–3, default 2), `GTFS_FEEDS` (comma-separated ids; `carris` matches `carris-metropolitana`).

## Data sources

Operator GTFS feeds (fixed URLs, dados.gov.pt, or Porto CKAN). Attribution per feed in `/gtfs/feeds`.

## License

MIT
