import { SERVICE_NAME, VERSION, windowDays } from './config.js'
import { enabledFeeds } from './feeds.js'
import { windowRange } from './window.js'

export async function metaRoutes(app) {
  app.get('/gtfs/meta', {
    schema: {
      description: 'Metadata and per-feed stats for the GTFS connector',
      tags: ['GTFS']
    }
  }, async () => {
    const store = app.store
    const feeds = await store.feedStats()
    const window = windowRange()
    return {
      connector: SERVICE_NAME,
      version: VERSION,
      description: 'Unified GTFS schedules for Portuguese operators',
      update_freq: 'daily 03:30 Europe/Lisbon; departures roll at 00:05',
      window_days: windowDays(),
      window,
      endpoints: [
        { path: '/v1/gtfs/feeds', description: 'Configured operator feeds' },
        { path: '/v1/gtfs/feeds/:feed_id', description: 'One feed plus recent diffs' },
        { path: '/v1/gtfs/changes', description: 'Feed diffs (stops/routes/trips)' },
        { path: '/v1/gtfs/routes', description: 'Routes, filterable by feed and text' },
        { path: '/v1/gtfs/routes/:feed_id/:route_id', description: 'Route, ordered stops, trips today' },
        { path: '/v1/gtfs/stops', description: 'Stops, text and geo search' },
        { path: '/v1/gtfs/stops/:feed_id/:stop_id', description: 'Stop plus serving routes' },
        { path: '/v1/gtfs/stops/:feed_id/:stop_id/departures', description: 'Departures in the window' },
        { path: '/v1/gtfs/departures/near', description: 'Next departures around a point' }
      ],
      feeds: enabledFeeds().map((def) => {
        const row = feeds.find((f) => f.feed_id === def.id)
        return {
          feed_id: def.id,
          name: def.name,
          region: def.region,
          license: def.license,
          attribution: def.attribution,
          valid_from: row?.valid_from ?? null,
          valid_to: row?.valid_to ?? null,
          expired: Boolean(row?.expired),
          last_checked: row?.last_checked ?? null,
          last_changed: row?.last_changed ?? null,
          counts: row?.counts ?? null,
          last_error: row?.last_error ?? null
        }
      })
    }
  })
}
