import mongoose from 'mongoose'

const { Schema } = mongoose

const feedSchema = new Schema({
  feed_id: { type: String, required: true, unique: true },
  name: String,
  region: String,
  license: String,
  attribution: String,
  source_url: String,
  resolved_url: String,
  etag: String,
  last_modified: String,
  sha256: String,
  bytes: Number,
  valid_from: String,
  valid_to: String,
  expired: { type: Boolean, default: false },
  counts: {
    stops: Number,
    routes: Number,
    trips: Number,
    stop_times_window: Number
  },
  last_checked: Date,
  last_changed: Date,
  last_error: String
}, { collection: 'feeds' })

const feedVersionSchema = new Schema({
  feed_id: { type: String, required: true },
  version_hash: String,
  detected_at: { type: Date, default: Date.now },
  valid_from: String,
  valid_to: String,
  snapshot: Schema.Types.Mixed
}, { collection: 'feed_versions' })
feedVersionSchema.index({ feed_id: 1, detected_at: -1 })

const changeSchema = new Schema({
  feed_id: { type: String, required: true },
  version_hash: String,
  detected_at: { type: Date, default: Date.now },
  summary: Schema.Types.Mixed
}, { collection: 'changes' })
changeSchema.index({ feed_id: 1, detected_at: -1 })
changeSchema.index({ detected_at: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 })

const agencySchema = new Schema({
  feed_id: { type: String, required: true },
  agency_id: { type: String, default: '' },
  agency_name: String,
  agency_url: String,
  agency_timezone: String,
  agency_lang: String
}, { collection: 'agencies' })
agencySchema.index({ feed_id: 1, agency_id: 1 }, { unique: true })

const routeSchema = new Schema({
  feed_id: { type: String, required: true },
  route_id: { type: String, required: true },
  agency_id: String,
  route_short_name: String,
  route_long_name: String,
  route_type: Number,
  route_color: String,
  route_text_color: String
}, { collection: 'routes' })
routeSchema.index({ feed_id: 1, route_id: 1 }, { unique: true })
routeSchema.index({ route_short_name: 1 })

const stopSchema = new Schema({
  feed_id: { type: String, required: true },
  stop_id: { type: String, required: true },
  stop_code: String,
  stop_name: String,
  lat: Number,
  lon: Number,
  location: {
    type: { type: String, enum: ['Point'] },
    coordinates: [Number]
  },
  parent_station: String,
  location_type: Number,
  wheelchair_boarding: Number,
  municipality_name: String
}, { collection: 'stops' })
stopSchema.index({ feed_id: 1, stop_id: 1 }, { unique: true })
stopSchema.index({ location: '2dsphere' })
stopSchema.index({ stop_name: 'text' })

const tripSchema = new Schema({
  feed_id: { type: String, required: true },
  trip_id: { type: String, required: true },
  route_id: String,
  service_id: String,
  headsign: String,
  direction_id: Number,
  shape_id: String
}, { collection: 'trips' })
tripSchema.index({ feed_id: 1, trip_id: 1 }, { unique: true })
tripSchema.index({ feed_id: 1, route_id: 1 })

const calendarSchema = new Schema({
  feed_id: { type: String, required: true },
  service_id: { type: String, required: true },
  monday: Number,
  tuesday: Number,
  wednesday: Number,
  thursday: Number,
  friday: Number,
  saturday: Number,
  sunday: Number,
  start_date: String,
  end_date: String
}, { collection: 'calendar' })
calendarSchema.index({ feed_id: 1, service_id: 1 })

const calendarDateSchema = new Schema({
  feed_id: { type: String, required: true },
  service_id: { type: String, required: true },
  date: String,
  exception_type: Number
}, { collection: 'calendar_dates' })
calendarDateSchema.index({ feed_id: 1, service_id: 1 })

const departureSchema = new Schema({
  feed_id: { type: String, required: true },
  stop_id: { type: String, required: true },
  date: { type: String, required: true },
  part: { type: Number, default: 0 },
  deps: [{
    t: String,
    ts: Date,
    trip_id: String,
    route_id: String,
    route_short_name: String,
    headsign: String,
    direction_id: Number
  }]
}, { collection: 'departures' })
departureSchema.index({ feed_id: 1, stop_id: 1, date: 1, part: 1 }, { unique: true })
departureSchema.index({ date: 1 })

const stopRouteSchema = new Schema({
  feed_id: { type: String, required: true },
  stop_id: { type: String, required: true },
  route_ids: [String]
}, { collection: 'stop_routes' })
stopRouteSchema.index({ feed_id: 1, stop_id: 1 }, { unique: true })

const routeStopSchema = new Schema({
  feed_id: { type: String, required: true },
  route_id: { type: String, required: true },
  stop_ids: [String]
}, { collection: 'route_stops' })
routeStopSchema.index({ feed_id: 1, route_id: 1 }, { unique: true })

export const Feed = mongoose.models.Feed || mongoose.model('Feed', feedSchema)
export const FeedVersion = mongoose.models.FeedVersion || mongoose.model('FeedVersion', feedVersionSchema)
export const Change = mongoose.models.Change || mongoose.model('Change', changeSchema)
export const Agency = mongoose.models.Agency || mongoose.model('Agency', agencySchema)
export const Route = mongoose.models.Route || mongoose.model('Route', routeSchema)
export const Stop = mongoose.models.Stop || mongoose.model('Stop', stopSchema)
export const Trip = mongoose.models.Trip || mongoose.model('Trip', tripSchema)
export const Calendar = mongoose.models.Calendar || mongoose.model('Calendar', calendarSchema)
export const CalendarDate = mongoose.models.CalendarDate || mongoose.model('CalendarDate', calendarDateSchema)
export const Departure = mongoose.models.Departure || mongoose.model('Departure', departureSchema)
export const StopRoute = mongoose.models.StopRoute || mongoose.model('StopRoute', stopRouteSchema)
export const RouteStop = mongoose.models.RouteStop || mongoose.model('RouteStop', routeStopSchema)

export const MODELS = {
  Feed, FeedVersion, Change, Agency, Route, Stop, Trip,
  Calendar, CalendarDate, Departure, StopRoute, RouteStop
}

export async function ensureIndexes() {
  await Promise.all(Object.values(MODELS).map((m) => m.createIndexes().catch(() => {})))
}
