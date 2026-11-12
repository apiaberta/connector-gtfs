import {
  Feed, Change, Route, Stop, Trip, Departure, StopRoute, RouteStop
} from './models.js'

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Public feed fields — skip etag/sha256/bytes that only ingest uses. */
export const FEED_PUBLIC_FIELDS = {
  _id: 0,
  feed_id: 1,
  name: 1,
  region: 1,
  license: 1,
  attribution: 1,
  valid_from: 1,
  valid_to: 1,
  expired: 1,
  last_checked: 1,
  last_changed: 1,
  counts: 1,
  last_error: 1
}

export const ROUTE_PUBLIC_FIELDS = {
  _id: 0,
  feed_id: 1,
  route_id: 1,
  agency_id: 1,
  route_short_name: 1,
  route_long_name: 1,
  route_type: 1,
  route_color: 1,
  route_text_color: 1
}

export const STOP_PUBLIC_FIELDS = {
  _id: 0,
  feed_id: 1,
  stop_id: 1,
  stop_code: 1,
  stop_name: 1,
  lat: 1,
  lon: 1,
  parent_station: 1,
  location_type: 1,
  wheelchair_boarding: 1,
  municipality_name: 1
}

export const STOP_NEAR_FIELDS = {
  _id: 0,
  feed_id: 1,
  stop_id: 1,
  stop_name: 1,
  lat: 1,
  lon: 1
}

export const TRIP_HYDRATE_FIELDS = {
  _id: 0,
  trip_id: 1,
  route_id: 1,
  headsign: 1
}

export const ROUTE_HYDRATE_FIELDS = {
  _id: 0,
  route_id: 1,
  route_short_name: 1,
  route_long_name: 1,
  route_color: 1
}

export const DEPARTURE_FIELDS = {
  _id: 0,
  feed_id: 1,
  stop_id: 1,
  date: 1,
  part: 1,
  deps: 1
}

export const CHANGE_LIST_FIELDS = {
  _id: 0,
  feed_id: 1,
  version_hash: 1,
  detected_at: 1,
  summary: 1
}

export function createStore(models = {
  Feed, Change, Route, Stop, Trip, Departure, StopRoute, RouteStop
}) {
  return {
    async listFeeds() {
      return models.Feed.find({}, FEED_PUBLIC_FIELDS).sort({ feed_id: 1 }).lean()
    },
    async getFeed(feedId) {
      return models.Feed.findOne({ feed_id: feedId }, FEED_PUBLIC_FIELDS).lean()
    },
    async listChanges({ feed_id, since, limit, offset }) {
      const filter = {}
      if (feed_id) filter.feed_id = feed_id
      if (since) filter.detected_at = { $gte: new Date(since) }
      const [total, data] = await Promise.all([
        models.Change.countDocuments(filter),
        models.Change.find(filter, CHANGE_LIST_FIELDS).sort({ detected_at: -1 }).skip(offset).limit(limit).lean()
      ])
      return { total, data }
    },
    async recentChanges(feedId, n = 5) {
      return models.Change.find({ feed_id: feedId }, CHANGE_LIST_FIELDS).sort({ detected_at: -1 }).limit(n).lean()
    },
    async listRoutes({ feed_id, q, route_type, limit, offset }) {
      const filter = {}
      if (feed_id) filter.feed_id = feed_id
      if (route_type != null && route_type !== '') filter.route_type = Number(route_type)
      if (q) {
        const rx = new RegExp(escapeRegex(q), 'i')
        filter.$or = [{ route_short_name: rx }, { route_long_name: rx }, { route_id: rx }]
      }
      const [total, data] = await Promise.all([
        models.Route.countDocuments(filter),
        models.Route.find(filter, ROUTE_PUBLIC_FIELDS).sort({ route_short_name: 1, route_id: 1 }).skip(offset).limit(limit).lean()
      ])
      return { total, data }
    },
    async getRoute(feedId, routeId) {
      return models.Route.findOne({ feed_id: feedId, route_id: routeId }, ROUTE_PUBLIC_FIELDS).lean()
    },
    async getRouteStops(feedId, routeId) {
      return models.RouteStop.findOne(
        { feed_id: feedId, route_id: routeId },
        { _id: 0, stop_ids: 1 }
      ).lean()
    },
    async tripsToday(feedId, routeId, serviceIds) {
      const filter = { feed_id: feedId, route_id: routeId }
      if (serviceIds?.length) filter.service_id = { $in: serviceIds }
      return models.Trip.countDocuments(filter)
    },
    async listStops({ feed_id, q, near, radius, limit, offset }) {
      const filter = {}
      if (feed_id) filter.feed_id = feed_id
      if (q) {
        filter.$or = [
          { stop_name: new RegExp(escapeRegex(q), 'i') },
          { stop_id: new RegExp(escapeRegex(q), 'i') },
          { stop_code: new RegExp(escapeRegex(q), 'i') }
        ]
      }
      if (near) {
        filter.location = {
          $geoWithin: {
            $centerSphere: [[near.lon, near.lat], radius / 6_371_000]
          }
        }
      }
      const [total, data] = await Promise.all([
        models.Stop.countDocuments(filter),
        models.Stop.find(filter, STOP_PUBLIC_FIELDS).skip(offset).limit(limit).lean()
      ])
      return { total, data }
    },
    async getStop(feedId, stopId) {
      return models.Stop.findOne({ feed_id: feedId, stop_id: stopId }, STOP_PUBLIC_FIELDS).lean()
    },
    async getStopRoutes(feedId, stopId) {
      return models.StopRoute.findOne(
        { feed_id: feedId, stop_id: stopId },
        { _id: 0, route_ids: 1 }
      ).lean()
    },
    async routesByIds(feedId, routeIds) {
      if (!routeIds?.length) return []
      return models.Route.find(
        { feed_id: feedId, route_id: { $in: routeIds } },
        ROUTE_HYDRATE_FIELDS
      ).lean()
    },
    async tripsByIds(feedId, tripIds) {
      if (!tripIds?.length) return []
      return models.Trip.find(
        { feed_id: feedId, trip_id: { $in: tripIds } },
        TRIP_HYDRATE_FIELDS
      ).lean()
    },
    async getDepartures(feedId, stopId, date) {
      return models.Departure.find(
        { feed_id: feedId, stop_id: stopId, date },
        DEPARTURE_FIELDS
      ).sort({ part: 1 }).lean()
    },
    async nearStops(lat, lon, radius, limit) {
      return models.Stop.find({
        location: {
          $geoWithin: {
            $centerSphere: [[lon, lat], radius / 6_371_000]
          }
        }
      }, STOP_NEAR_FIELDS).limit(limit).lean()
    },
    async departuresForStops(stops, date) {
      if (!stops.length) return []
      const or = stops.map((s) => ({ feed_id: s.feed_id, stop_id: s.stop_id, date }))
      return models.Departure.find({ $or: or }, DEPARTURE_FIELDS).lean()
    },
    async feedStats() {
      return models.Feed.find({}, FEED_PUBLIC_FIELDS).lean()
    }
  }
}

export const defaultStore = createStore()
