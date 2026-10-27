import { crc32 } from 'node:zlib'

function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}

/** Uncompressed (store) ZIP. Used by tests to build tiny GTFS fixtures. */
export function createStoredZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  const entries = Object.entries(files)

  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data
    ])
    locals.push(local)
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf
    ])
    centrals.push(central)
    offset += local.length
  }

  const centralStart = offset
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBuf.length),
    u32(centralStart),
    u16(0)
  ])
  return Buffer.concat([...locals, centralBuf, eocd])
}

export const MINI_GTFS_FILES = {
  'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nMINI,Mini Transit,https://example.test,Europe/Lisbon\n',
  'stops.txt': 'stop_id,stop_code,stop_name,stop_lat,stop_lon,location_type\nA,A,Stop A,38.72,-9.14,0\nB,B,Stop B,38.73,-9.15,0\nC,C,Stop C,38.74,-9.16,0\nD,D,Stop D,38.75,-9.17,0\n',
  'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type,route_color\nR1,MINI,1,Line One,3,FF0000\nR2,MINI,M,Metro Line,1,0000FF\n',
  'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWEEK,1,1,1,1,1,0,0,20260101,20261231\nWEEKEND,0,0,0,0,0,1,1,20260101,20261231\n',
  'calendar_dates.txt': 'service_id,date,exception_type\nWEEK,20261026,2\nSPECIAL,20261026,1\n',
  'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id\nR1,WEEK,T1,A to D,0\nR1,WEEKEND,T2,A to D weekend,0\nR2,SPECIAL,T3,Night metro,0\n',
  'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,1\nT1,08:10:00,08:10:00,B,2\nT1,08:20:00,08:20:00,C,3\nT1,08:30:00,08:30:00,D,4\nT2,09:00:00,09:00:00,A,1\nT2,09:30:00,09:30:00,D,2\nT3,25:10:00,25:10:00,B,1\nT3,25:20:00,25:20:00,C,2\n',
  'feed_info.txt': 'feed_publisher_name,feed_start_date,feed_end_date\nMini,20260101,20261231\n'
}

export function miniGtfsZip() {
  return createStoredZip(MINI_GTFS_FILES)
}
