import {
  Feed, Change, Route, Stop, Trip, Departure, StopRoute, RouteStop
} from './models.js'

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createStore(models = {
  Feed, Change, Route, Stop, Trip, Departure, StopRoute, RouteStop
}) {
  return {
    async listFeeds() {
      return models.Feed.find().sort({ feed_id: 1 }).lean()
    },
    async getFeed(feedId) {
      return models.Feed.findOne({ feed_id: feedId }).lean()
    },
    async listChanges({ feed_id, since, limit, offset }) {
      const filter = {}
      if (feed_id) filter.feed_id = feed_id
      if (since) filter.detected_at = { $gte: new Date(since) }
      const [total, data] = await Promise.all([
        models.Change.countDocuments(filter),
        models.Change.find(filter).sort({ detected_at: -1 }).skip(offset).limit(limit).lean()
      ])
      return { total, data }
    },
    async recentChanges(feedId, n = 5) {
      return models.Change.find({ feed_id: feedId }).sort({ detected_at: -1 }).limit(n).lean()
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
        models.Route.find(filter).sort({ route_short_name: 1, route_id: 1 }).skip(offset).limit(limit).lean()
      ])
      return { total, data }
    },
    async getRoute(feedId, routeId) {
      return models.Route.findOne({ feed_id: feedId, route_id: routeId }).lean()
    },
    async getRouteStops(feedId, routeId) {
      return models.RouteStop.findOne({ feed_id: feedId, route_id: routeId }).lean()
    },
    async tripsToday(feedId, routeId, serviceIds) {
      const filter = { feed_id: feedId, route_id: routeId }
      if (serviceIds?.length) filter.service_id = { $in: serviceIds }
      return models.Trip.find(filter).lean()
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
        models.Stop.find(filter).skip(offset).limit(limit).lean()
      ])
      return { total, data }
    },
    async getStop(feedId, stopId) {
      return models.Stop.findOne({ feed_id: feedId, stop_id: stopId }).lean()
    },
    async getStopRoutes(feedId, stopId) {
      return models.StopRoute.findOne({ feed_id: feedId, stop_id: stopId }).lean()
    },
    async routesByIds(feedId, routeIds) {
      if (!routeIds?.length) return []
      return models.Route.find({ feed_id: feedId, route_id: { $in: routeIds } }).lean()
    },
    async getDepartures(feedId, stopId, date) {
      return models.Departure.find({ feed_id: feedId, stop_id: stopId, date }).sort({ part: 1 }).lean()
    },
    async nearStops(lat, lon, radius, limit) {
      return models.Stop.find({
        location: {
          $geoWithin: {
            $centerSphere: [[lon, lat], radius / 6_371_000]
          }
        }
      }).limit(limit).lean()
    },
    async departuresForStops(stops, date) {
      if (!stops.length) return []
      const or = stops.map((s) => ({ feed_id: s.feed_id, stop_id: s.stop_id, date }))
      return models.Departure.find({ $or: or }).lean()
    },
    async feedStats() {
      const feeds = await models.Feed.find().lean()
      return feeds
    }
  }
}

export const defaultStore = createStore()
