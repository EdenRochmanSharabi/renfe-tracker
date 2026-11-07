-- Relational layer over the raw JSON of the data branch: one .duckdb file per UTC day, built by ingest.py, never written
-- by the recorders. Every partition is self-contained (same schema, its own dimensions, catalog and checksums) and
-- immutable once its day is closed; federate.py attaches many of them and exposes the v_* views over the whole set.
-- Conventions:
--   Keys are (ts, small integer): ts is the capture time from the file name, the integer is a per-partition surrogate
--     (train, cercanias_vehicle) or the position in the feed (seq). Text keys cost 4x more in DuckDB's ART indexes.
--   One capture table per source kind (cap_extra, cap_cercanias, ...), so a child references a single TIMESTAMP column.
--   NULL means "the feed gave no value". Every recorder sentinel ('' strings, 0 for pos_ts/product, -1 route index,
--     JSON null) becomes NULL on ingest. One exception: delay_min in ld_position/gps_position, where the recorder writes
--     0 for an unparseable delay and 0 is also a real value, so it stays 0.
--   Every TIMESTAMP is UTC (naive). Feed strings in Europe/Madrid local time are converted on ingest.
--     schedule_stop times are TIME of day in Europe/Madrid, as the timetable prints them.
--   Positions are DECIMAL(8,5) degrees (the JSON stores lat*1e5 integers). Bounds cover Iberia and the south of France
--     (Renfe long-distance trains reach Lyon and Marseille; the weather grid reaches lat 46).
--   The v_* views are the public API: explicit column lists (adding a base column changes no view) and surrogate ids
--     resolved to their codes.

CREATE TABLE IF NOT EXISTS source (
  path VARCHAR PRIMARY KEY,
  kind VARCHAR NOT NULL CHECK (kind IN ('extra', 'cercanias', 'regional', 'env', 'schedule', 'weather', 'alerts', 'gps', 'gps-night', 'stats', 'static')),
  day DATE,                                           -- NULL for static files
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  ingested_at TIMESTAMP NOT NULL                      -- the only column left out of the checksums
);
CREATE TABLE IF NOT EXISTS rejected (                 -- quarantine: staged rows that break a constraint, never dropped silently
  source_path VARCHAR NOT NULL REFERENCES source (path),
  table_name VARCHAR NOT NULL,
  reason VARCHAR NOT NULL,
  raw VARCHAR NOT NULL,                               -- the staged row as JSON text (or the first bytes of an unparseable file)
  PRIMARY KEY (source_path, table_name, reason, raw)
);
CREATE TABLE IF NOT EXISTS checksum (                 -- rows and content hash of every table at build time (verified weekly against a rebuild)
  table_name VARCHAR PRIMARY KEY,
  rows BIGINT NOT NULL CHECK (rows >= 0),
  hash UBIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS station (                  -- static/renfe_estaciones.csv, replicated in every partition (646 rows)
  code VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  lat DECIMAL(8,5) CHECK (lat BETWEEN 27 AND 52),
  lon DECIMAL(8,5) CHECK (lon BETWEEN -19 AND 10),
  city VARCHAR,
  province VARCHAR
);
CREATE TABLE IF NOT EXISTS train (                    -- long-distance train codes seen in this partition
  id UINTEGER PRIMARY KEY,
  code VARCHAR NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS cercanias_vehicle (        -- the same vehicle id is reused by different nuclei, so (code, line) is the natural key
  id UINTEGER PRIMARY KEY,
  code VARCHAR NOT NULL,
  line VARCHAR NOT NULL,
  UNIQUE (code, line)
);

-- one capture table per source kind: ts is the UTC time in the file name (minute, or hour for hourly files)
CREATE TABLE IF NOT EXISTS cap_extra (ts TIMESTAMP PRIMARY KEY CHECK (ts BETWEEN '2026-09-01' AND '2100-01-01'), source_path VARCHAR NOT NULL REFERENCES source (path),
  feed_ts TIMESTAMP CHECK (feed_ts BETWEEN '2026-09-01' AND '2100-01-01'), not_positioned INTEGER CHECK (not_positioned >= 0));
CREATE TABLE IF NOT EXISTS cap_cercanias (ts TIMESTAMP PRIMARY KEY CHECK (ts BETWEEN '2026-09-01' AND '2100-01-01'), source_path VARCHAR NOT NULL REFERENCES source (path),
  feed_ts TIMESTAMP CHECK (feed_ts BETWEEN '2026-09-01' AND '2100-01-01'));
CREATE TABLE IF NOT EXISTS cap_regional (ts TIMESTAMP PRIMARY KEY CHECK (ts BETWEEN '2026-09-01' AND '2100-01-01'), source_path VARCHAR NOT NULL REFERENCES source (path));
CREATE TABLE IF NOT EXISTS cap_env (ts TIMESTAMP PRIMARY KEY CHECK (ts BETWEEN '2026-09-01' AND '2100-01-01'), source_path VARCHAR NOT NULL REFERENCES source (path));
CREATE TABLE IF NOT EXISTS cap_schedule (ts TIMESTAMP PRIMARY KEY CHECK (ts BETWEEN '2026-09-01' AND '2100-01-01'), source_path VARCHAR NOT NULL REFERENCES source (path),
  feed_ts TIMESTAMP CHECK (feed_ts BETWEEN '2026-09-01' AND '2100-01-01'));
CREATE TABLE IF NOT EXISTS cap_weather (ts TIMESTAMP PRIMARY KEY CHECK (ts BETWEEN '2026-09-01' AND '2100-01-01'), source_path VARCHAR NOT NULL REFERENCES source (path),
  feed_ts TIMESTAMP CHECK (feed_ts BETWEEN '2026-09-01' AND '2100-01-01'));
CREATE TABLE IF NOT EXISTS cap_alerts (ts TIMESTAMP PRIMARY KEY CHECK (ts BETWEEN '2026-09-01' AND '2100-01-01'), source_path VARCHAR NOT NULL REFERENCES source (path),
  feed_ts TIMESTAMP CHECK (feed_ts BETWEEN '2026-09-01' AND '2100-01-01'));
CREATE TABLE IF NOT EXISTS cap_gps (ts TIMESTAMP PRIMARY KEY CHECK (ts BETWEEN '2026-09-01' AND '2100-01-01'), source_path VARCHAR NOT NULL REFERENCES source (path));
CREATE TABLE IF NOT EXISTS cap_stats (ts TIMESTAMP PRIMARY KEY CHECK (ts BETWEEN '2026-09-01' AND '2100-01-01'), source_path VARCHAR NOT NULL REFERENCES source (path));

-- extra/YYYY-MM-DD/HH-MM.json (every minute)
CREATE TABLE IF NOT EXISTS ld_position (
  ts TIMESTAMP NOT NULL REFERENCES cap_extra (ts),
  train UINTEGER NOT NULL REFERENCES train (id),
  lat DECIMAL(8,5) NOT NULL CHECK (lat BETWEEN 35 AND 47),
  lon DECIMAL(8,5) NOT NULL CHECK (lon BETWEEN -10 AND 6),
  delay_min INTEGER NOT NULL CHECK (delay_min BETWEEN -1440 AND 1440),
  prev_station VARCHAR,
  next_station VARCHAR,
  next_arrival TIMESTAMP,
  pos_ts TIMESTAMP CHECK (pos_ts BETWEEN '2026-09-01' AND '2100-01-01'),
  stock VARCHAR,
  product INTEGER CHECK (product > 0),
  PRIMARY KEY (ts, train)
);
CREATE TABLE IF NOT EXISTS ld_vehicle (               -- GTFS-RT vehicle_positions_LD: no unique vehicle key per capture, so seq is the key
  ts TIMESTAMP NOT NULL REFERENCES cap_extra (ts),
  seq INTEGER NOT NULL CHECK (seq > 0),
  vehicle_id VARCHAR NOT NULL,
  status SMALLINT CHECK (status IN (0, 1, 2)),
  stop_id VARCHAR,
  PRIMARY KEY (ts, seq)
);
CREATE TABLE IF NOT EXISTS ld_trip_update (           -- GTFS-RT trip_updates_LD, SCHEDULED trips, first stop time update; a trip can repeat, so seq is the key
  ts TIMESTAMP NOT NULL REFERENCES cap_extra (ts),
  seq INTEGER NOT NULL CHECK (seq > 0),
  trip_id VARCHAR NOT NULL,
  stop_id VARCHAR,
  delay_s INTEGER CHECK (delay_s BETWEEN -86400 AND 86400),
  arrival_ts TIMESTAMP CHECK (arrival_ts BETWEEN '2026-09-01' AND '2100-01-01'),
  PRIMARY KEY (ts, seq)
);
CREATE TABLE IF NOT EXISTS weather_point (            -- extra w: Open-Meteo at 11 points of the network, every 15 min
  ts TIMESTAMP NOT NULL REFERENCES cap_extra (ts),
  lat DECIMAL(8,5) NOT NULL CHECK (lat BETWEEN 35 AND 47),
  lon DECIMAL(8,5) NOT NULL CHECK (lon BETWEEN -10 AND 6),
  temperature_2m DOUBLE CHECK (temperature_2m BETWEEN -50 AND 60),
  precipitation DOUBLE CHECK (precipitation >= 0),
  wind_speed_10m DOUBLE CHECK (wind_speed_10m >= 0),
  wind_gusts_10m DOUBLE CHECK (wind_gusts_10m >= 0),
  visibility DOUBLE CHECK (visibility >= 0),
  weather_code SMALLINT CHECK (weather_code BETWEEN 0 AND 99),
  PRIMARY KEY (ts, lat, lon)
);

-- weather/YYYY-MM-DD/HH.json (hourly)
CREATE TABLE IF NOT EXISTS weather_grid (             -- Open-Meteo on the 0.5 degree grid of cells trains cross
  ts TIMESTAMP NOT NULL REFERENCES cap_weather (ts),
  lat DECIMAL(8,5) NOT NULL CHECK (lat BETWEEN 35 AND 47),
  lon DECIMAL(8,5) NOT NULL CHECK (lon BETWEEN -10 AND 6),
  temperature_2m DOUBLE CHECK (temperature_2m BETWEEN -50 AND 60),
  precipitation DOUBLE CHECK (precipitation >= 0),
  snowfall DOUBLE CHECK (snowfall >= 0),
  wind_speed_10m DOUBLE CHECK (wind_speed_10m >= 0),
  wind_gusts_10m DOUBLE CHECK (wind_gusts_10m >= 0),
  visibility DOUBLE CHECK (visibility >= 0),
  weather_code SMALLINT CHECK (weather_code BETWEEN 0 AND 99),
  cloud_cover DOUBLE CHECK (cloud_cover BETWEEN 0 AND 100),
  pressure_msl DOUBLE CHECK (pressure_msl BETWEEN 850 AND 1100),
  relative_humidity_2m DOUBLE CHECK (relative_humidity_2m BETWEEN 0 AND 100),
  soil_moisture_0_to_1cm DOUBLE CHECK (soil_moisture_0_to_1cm >= 0),
  is_day BOOLEAN,
  PRIMARY KEY (ts, lat, lon)
);

-- cercanias/YYYY-MM-DD/HH-MM.json (every 5 min)
CREATE TABLE IF NOT EXISTS cercanias_position (
  ts TIMESTAMP NOT NULL REFERENCES cap_cercanias (ts),
  vehicle UINTEGER NOT NULL REFERENCES cercanias_vehicle (id),
  lat DECIMAL(8,5) NOT NULL CHECK (lat BETWEEN 35 AND 47),
  lon DECIMAL(8,5) NOT NULL CHECK (lon BETWEEN -10 AND 6),
  status SMALLINT CHECK (status IN (0, 1, 2)),
  stop_id VARCHAR,
  delay_s INTEGER CHECK (delay_s BETWEEN -43200 AND 43200),  -- unwrapped: the feed wraps it mod 86400 around midnight
  PRIMARY KEY (ts, vehicle)
);

-- regional/YYYY-MM-DD/HH-MM.json (every 5 min)
CREATE TABLE IF NOT EXISTS fgc_position (             -- a unit can appear several times per capture (coupled trains) or be null, so seq is the key
  ts TIMESTAMP NOT NULL REFERENCES cap_regional (ts),
  seq INTEGER NOT NULL CHECK (seq > 0),
  unit VARCHAR,
  line VARCHAR,
  lat DECIMAL(8,5) NOT NULL CHECK (lat BETWEEN 35 AND 47),
  lon DECIMAL(8,5) NOT NULL CHECK (lon BETWEEN -10 AND 6),
  direction VARCHAR CHECK (direction IN ('A', 'D')),
  origin VARCHAR,
  destination VARCHAR,
  on_time BOOLEAN,
  occupancy SMALLINT CHECK (occupancy BETWEEN 0 AND 100),
  PRIMARY KEY (ts, seq)
);
CREATE TABLE IF NOT EXISTS regional_pb (              -- raw GTFS-RT protobuf, gzipped, as the recorder stored it (decode offline)
  ts TIMESTAMP NOT NULL REFERENCES cap_regional (ts),
  feed VARCHAR NOT NULL CHECK (feed IN ('mb_vp', 'mb_tu', 'et_tu')),
  gz BLOB NOT NULL,
  PRIMARY KEY (ts, feed)
);

-- env/YYYY-MM-DD/HH-MM.json (every 15 min)
CREATE TABLE IF NOT EXISTS aemet_warning (
  ts TIMESTAMP NOT NULL REFERENCES cap_env (ts),
  cap_file VARCHAR NOT NULL,
  level VARCHAR NOT NULL CHECK (level IN ('amarillo', 'naranja', 'rojo')),
  phenomenon VARCHAR,
  zone VARCHAR,
  validity VARCHAR,
  PRIMARY KEY (ts, cap_file)
);
CREATE TABLE IF NOT EXISTS earthquake (
  ts TIMESTAMP NOT NULL REFERENCES cap_env (ts),
  evid VARCHAR NOT NULL,
  magnitude DOUBLE CHECK (magnitude BETWEEN 0 AND 10),
  place VARCHAR,
  lat DECIMAL(8,5) CHECK (lat BETWEEN -90 AND 90),
  lon DECIMAL(8,5) CHECK (lon BETWEEN -180 AND 180),
  origin_ts TIMESTAMP,
  PRIMARY KEY (ts, evid)
);
CREATE TABLE IF NOT EXISTS kp (
  ts TIMESTAMP PRIMARY KEY REFERENCES cap_env (ts),
  time_tag TIMESTAMP,
  kp_index DOUBLE CHECK (kp_index BETWEEN 0 AND 9),
  estimated_kp DOUBLE CHECK (estimated_kp BETWEEN 0 AND 9)
);
CREATE TABLE IF NOT EXISTS swpc_alert (
  ts TIMESTAMP NOT NULL REFERENCES cap_env (ts),
  product_id VARCHAR NOT NULL,
  issue_ts TIMESTAMP NOT NULL,
  message VARCHAR,
  PRIMARY KEY (ts, product_id, issue_ts)
);
CREATE TABLE IF NOT EXISTS ems_activation (
  ts TIMESTAMP NOT NULL REFERENCES cap_env (ts),
  code VARCHAR NOT NULL,
  name VARCHAR,
  event_ts TIMESTAMP,
  last_update TIMESTAMP,
  PRIMARY KEY (ts, code)
);
CREATE TABLE IF NOT EXISTS ems_country (
  ts TIMESTAMP NOT NULL,
  code VARCHAR NOT NULL,
  country VARCHAR NOT NULL,
  PRIMARY KEY (ts, code, country),
  FOREIGN KEY (ts, code) REFERENCES ems_activation (ts, code)
);

-- schedule/YYYY-MM-DD/HH.json (hourly)
CREATE TABLE IF NOT EXISTS schedule_stop (
  ts TIMESTAMP NOT NULL REFERENCES cap_schedule (ts),
  train UINTEGER NOT NULL REFERENCES train (id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  station VARCHAR NOT NULL,
  arrival TIME,
  departure TIME,
  PRIMARY KEY (ts, train, seq)
);

-- alerts/YYYY-MM-DD/HH.json (hourly)
CREATE TABLE IF NOT EXISTS alert (                    -- the same alert id can appear once per informed-entity count
  ts TIMESTAMP NOT NULL REFERENCES cap_alerts (ts),
  alert_id VARCHAR NOT NULL,
  n_entities INTEGER NOT NULL CHECK (n_entities >= 0),
  start_ts TIMESTAMP,
  end_ts TIMESTAMP,
  text VARCHAR,
  PRIMARY KEY (ts, alert_id, n_entities)
);
CREATE TABLE IF NOT EXISTS cancellation (
  ts TIMESTAMP NOT NULL REFERENCES cap_alerts (ts),
  trip_id VARCHAR NOT NULL,
  feed VARCHAR NOT NULL CHECK (feed IN ('all', 'ld')),  -- trip_updates.json (all operators) or trip_updates_LD.json
  PRIMARY KEY (ts, trip_id, feed)
);

-- gps/YYYY-MM-DD.json and gps-night/ (every 5 min, one file per day)
CREATE TABLE IF NOT EXISTS gps_position (
  ts TIMESTAMP NOT NULL REFERENCES cap_gps (ts),
  train UINTEGER NOT NULL REFERENCES train (id),
  lat DECIMAL(8,5) NOT NULL CHECK (lat BETWEEN 35 AND 47),
  lon DECIMAL(8,5) NOT NULL CHECK (lon BETWEEN -10 AND 6),
  delay_min INTEGER NOT NULL CHECK (delay_min BETWEEN -1440 AND 1440),
  PRIMARY KEY (ts, train)
);
CREATE TABLE IF NOT EXISTS gps_route (                -- origin and destination of each train, once per daily file
  source_path VARCHAR NOT NULL REFERENCES source (path),
  train UINTEGER NOT NULL REFERENCES train (id),
  origin VARCHAR,
  destination VARCHAR,
  PRIMARY KEY (source_path, train)
);

-- stats/YYYY-MM-DD.json (every 5 min, one file per day)
CREATE TABLE IF NOT EXISTS stats_snapshot (
  ts TIMESTAMP PRIMARY KEY REFERENCES cap_stats (ts),
  total INTEGER NOT NULL CHECK (total >= 0),
  delayed INTEGER NOT NULL CHECK (delayed BETWEEN 0 AND total),
  avg_delay_min DOUBLE NOT NULL CHECK (avg_delay_min >= 0),
  max_delay_min INTEGER NOT NULL CHECK (max_delay_min BETWEEN -1440 AND 1440),
  pct_delayed DOUBLE NOT NULL CHECK (pct_delayed BETWEEN 0 AND 100)
);
CREATE TABLE IF NOT EXISTS stats_route (              -- hourly per origin-destination summary
  ts TIMESTAMP NOT NULL REFERENCES cap_stats (ts),
  origin VARCHAR NOT NULL,
  destination VARCHAR NOT NULL,
  n INTEGER NOT NULL CHECK (n > 0),
  avg_delay_min DOUBLE NOT NULL CHECK (avg_delay_min >= 0),
  max_delay_min INTEGER NOT NULL CHECK (max_delay_min BETWEEN -1440 AND 1440),
  PRIMARY KEY (ts, origin, destination)
);

-- Catalog (rule 4): one row per table and per column, checked against the real catalog by test_codd.py.
CREATE TABLE IF NOT EXISTS meta_table (table_name VARCHAR PRIMARY KEY, source VARCHAR NOT NULL, description VARCHAR NOT NULL);
CREATE TABLE IF NOT EXISTS meta_column (
  table_name VARCHAR NOT NULL REFERENCES meta_table (table_name),
  column_name VARCHAR NOT NULL,
  unit VARCHAR,                                       -- NULL when the column is a code or free text
  description VARCHAR NOT NULL,
  PRIMARY KEY (table_name, column_name)
);
INSERT OR REPLACE INTO meta_table VALUES
  ('source', 'data branch', 'one row per JSON/CSV file ingested'),
  ('rejected', 'ingest.py', 'quarantine for staged rows that break a constraint of their target table'),
  ('checksum', 'ingest.py', 'row count and content hash of every table at build time'),
  ('station', 'static/renfe_estaciones.csv', 'Renfe station codes with name and position'),
  ('train', 'extra tr, gps o, schedule tr', 'long-distance train codes seen in this partition'),
  ('cercanias_vehicle', 'cercanias v', 'Cercanias vehicle id and line pairs seen in this partition'),
  ('cap_extra', 'extra file names', 'one row per extra capture (every minute)'),
  ('cap_cercanias', 'cercanias file names', 'one row per cercanias capture (every 5 min)'),
  ('cap_regional', 'regional file names', 'one row per regional capture (every 5 min)'),
  ('cap_env', 'env file names', 'one row per env capture (every 15 min)'),
  ('cap_schedule', 'schedule file names', 'one row per schedule capture (hourly)'),
  ('cap_weather', 'weather file names', 'one row per weather capture (hourly)'),
  ('cap_alerts', 'alerts file names', 'one row per alerts capture (hourly)'),
  ('cap_gps', 'gps p keys', 'one row per gps snapshot (every 5 min)'),
  ('cap_stats', 'stats snapshots keys', 'one row per stats snapshot (every 5 min)'),
  ('ld_position', 'extra tr', 'long-distance train positions from the Renfe visor, every minute'),
  ('ld_vehicle', 'extra v', 'GTFS-RT vehicle_positions_LD entities, every minute'),
  ('ld_trip_update', 'extra u', 'GTFS-RT trip_updates_LD, SCHEDULED trips, every 5 min'),
  ('weather_point', 'extra w', 'Open-Meteo current weather at 11 network points, every 15 min'),
  ('weather_grid', 'weather', 'Open-Meteo current weather on the 0.5 degree grid, hourly'),
  ('cercanias_position', 'cercanias v', 'Cercanias and conventional-line vehicles from the Renfe GTFS-RT, every 5 min'),
  ('fgc_position', 'regional fgc', 'FGC Geotren positions, every 5 min'),
  ('regional_pb', 'regional mb, et', 'Metro Bilbao and Euskotren GTFS-RT protobuf, gzipped'),
  ('aemet_warning', 'env aemet', 'active AEMET weather warnings, every 15 min'),
  ('earthquake', 'env ign', 'IGN earthquakes with origin time in the last 30 min'),
  ('kp', 'env kp.k', 'NOAA planetary K index, last 1-min point'),
  ('swpc_alert', 'env kp.a', 'NOAA SWPC alerts issued in the last 30 min'),
  ('ems_activation', 'env ems', 'last 5 Copernicus EMS rapid mapping activations, hourly'),
  ('ems_country', 'env ems', 'countries of each EMS activation'),
  ('schedule_stop', 'schedule tr', 'planned timetable of the trains running now, hourly'),
  ('alert', 'alerts a', 'Renfe GTFS-RT service alerts, hourly'),
  ('cancellation', 'alerts c, cl', 'cancelled trip ids, hourly'),
  ('gps_position', 'gps p', 'long-distance positions, every 5 min'),
  ('gps_route', 'gps o, r, s', 'origin and destination station of each train seen that day'),
  ('stats_snapshot', 'stats snapshots', 'fleet delay summary, every 5 min'),
  ('stats_route', 'stats routes', 'delay summary per origin-destination, hourly'),
  ('meta_table', 'schema.sql', 'this catalog: one row per table'),
  ('meta_column', 'schema.sql', 'this catalog: one row per column');
INSERT OR REPLACE INTO meta_column VALUES
  ('source', 'path', NULL, 'path relative to the root of the data branch'),
  ('source', 'kind', NULL, 'top-level directory of the file'),
  ('source', 'day', 'UTC date', 'day in the file name; NULL for static files'),
  ('source', 'bytes', 'bytes', 'size of the file'),
  ('source', 'ingested_at', 'UTC', 'when ingest.py registered the file'),
  ('rejected', 'source_path', NULL, 'file the row came from'),
  ('rejected', 'table_name', NULL, 'table the row was meant for'),
  ('rejected', 'reason', NULL, 'constraint that failed, or invalid JSON / duplicate key'),
  ('rejected', 'raw', 'JSON', 'the staged row'),
  ('checksum', 'table_name', NULL, 'table'),
  ('checksum', 'rows', 'rows', 'row count at build time'),
  ('checksum', 'hash', NULL, 'xor of the hash of every row (source.ingested_at excluded)'),
  ('station', 'code', NULL, 'Renfe station code'),
  ('station', 'name', NULL, 'station name'),
  ('station', 'lat', 'degrees', 'latitude'),
  ('station', 'lon', 'degrees', 'longitude'),
  ('station', 'city', NULL, 'municipality'),
  ('station', 'province', NULL, 'province'),
  ('train', 'id', NULL, 'surrogate key, valid inside this partition only'),
  ('train', 'code', NULL, 'commercial code (codComercial) or circulation code'),
  ('cercanias_vehicle', 'id', NULL, 'surrogate key, valid inside this partition only'),
  ('cercanias_vehicle', 'code', NULL, 'GTFS-RT vehicle id'),
  ('cercanias_vehicle', 'line', NULL, 'line (label before the first dash)'),
  ('cap_extra', 'ts', 'UTC', 'capture minute from the file name'),
  ('cap_extra', 'source_path', NULL, 'file the capture was read from'),
  ('cap_extra', 'feed_ts', 'UTC', 'fechaActualizacion of the visor feed'),
  ('cap_extra', 'not_positioned', 'trains', 'trains in the feed without coordinates'),
  ('cap_cercanias', 'ts', 'UTC', 'capture minute from the file name'),
  ('cap_cercanias', 'source_path', NULL, 'file the capture was read from'),
  ('cap_cercanias', 'feed_ts', 'UTC', 'GTFS-RT header timestamp'),
  ('cap_regional', 'ts', 'UTC', 'capture minute from the file name'),
  ('cap_regional', 'source_path', NULL, 'file the capture was read from'),
  ('cap_env', 'ts', 'UTC', 'capture minute from the file name'),
  ('cap_env', 'source_path', NULL, 'file the capture was read from'),
  ('cap_schedule', 'ts', 'UTC', 'capture hour from the file name'),
  ('cap_schedule', 'source_path', NULL, 'file the capture was read from'),
  ('cap_schedule', 'feed_ts', 'UTC', 'fechaActualizacion of the visor feed'),
  ('cap_weather', 'ts', 'UTC', 'capture hour from the file name'),
  ('cap_weather', 'source_path', NULL, 'file the capture was read from'),
  ('cap_weather', 'feed_ts', 'UTC', 'Open-Meteo current time'),
  ('cap_alerts', 'ts', 'UTC', 'capture hour from the file name'),
  ('cap_alerts', 'source_path', NULL, 'file the capture was read from'),
  ('cap_alerts', 'feed_ts', 'UTC', 'GTFS-RT header timestamp'),
  ('cap_gps', 'ts', 'UTC', 'snapshot minute (key of p in the daily file)'),
  ('cap_gps', 'source_path', NULL, 'daily file (gps or gps-night)'),
  ('cap_stats', 'ts', 'UTC', 'snapshot minute (key of snapshots in the daily file)'),
  ('cap_stats', 'source_path', NULL, 'daily file'),
  ('ld_position', 'ts', 'UTC', 'capture'),
  ('ld_position', 'train', NULL, 'train.id'),
  ('ld_position', 'lat', 'degrees', 'latitude'),
  ('ld_position', 'lon', 'degrees', 'longitude'),
  ('ld_position', 'delay_min', 'minutes', 'last reported delay (ultRetraso); 0 when unparseable'),
  ('ld_position', 'prev_station', NULL, 'code of the previous station'),
  ('ld_position', 'next_station', NULL, 'code of the next station'),
  ('ld_position', 'next_arrival', 'UTC', 'expected arrival at the next station'),
  ('ld_position', 'pos_ts', 'UTC', 'time of the position fix'),
  ('ld_position', 'stock', NULL, 'rolling stock identifier (mat)'),
  ('ld_position', 'product', NULL, 'product code (codProduct)'),
  ('ld_vehicle', 'ts', 'UTC', 'capture'),
  ('ld_vehicle', 'seq', NULL, 'position of the entity in the feed (1-based)'),
  ('ld_vehicle', 'vehicle_id', NULL, 'GTFS-RT vehicle id'),
  ('ld_vehicle', 'status', NULL, '0 STOPPED_AT, 1 INCOMING_AT, 2 IN_TRANSIT_TO'),
  ('ld_vehicle', 'stop_id', NULL, 'GTFS stop id'),
  ('ld_trip_update', 'ts', 'UTC', 'capture'),
  ('ld_trip_update', 'seq', NULL, 'position of the entity in the feed (1-based)'),
  ('ld_trip_update', 'trip_id', NULL, 'GTFS trip id'),
  ('ld_trip_update', 'stop_id', NULL, 'stop of the first stop time update'),
  ('ld_trip_update', 'delay_s', 'seconds', 'trip delay'),
  ('ld_trip_update', 'arrival_ts', 'UTC', 'predicted arrival at that stop'),
  ('weather_point', 'ts', 'UTC', 'capture'),
  ('weather_point', 'lat', 'degrees', 'latitude of the point'),
  ('weather_point', 'lon', 'degrees', 'longitude of the point'),
  ('weather_point', 'temperature_2m', 'C', 'air temperature at 2 m'),
  ('weather_point', 'precipitation', 'mm', 'precipitation in the current hour'),
  ('weather_point', 'wind_speed_10m', 'km/h', 'wind speed at 10 m'),
  ('weather_point', 'wind_gusts_10m', 'km/h', 'wind gusts at 10 m'),
  ('weather_point', 'visibility', 'm', 'visibility'),
  ('weather_point', 'weather_code', 'WMO code', 'weather condition'),
  ('weather_grid', 'ts', 'UTC', 'capture'),
  ('weather_grid', 'lat', 'degrees', 'latitude of the cell'),
  ('weather_grid', 'lon', 'degrees', 'longitude of the cell'),
  ('weather_grid', 'temperature_2m', 'C', 'air temperature at 2 m'),
  ('weather_grid', 'precipitation', 'mm', 'precipitation in the current hour'),
  ('weather_grid', 'snowfall', 'cm', 'snowfall in the current hour'),
  ('weather_grid', 'wind_speed_10m', 'km/h', 'wind speed at 10 m'),
  ('weather_grid', 'wind_gusts_10m', 'km/h', 'wind gusts at 10 m'),
  ('weather_grid', 'visibility', 'm', 'visibility'),
  ('weather_grid', 'weather_code', 'WMO code', 'weather condition'),
  ('weather_grid', 'cloud_cover', '%', 'cloud cover'),
  ('weather_grid', 'pressure_msl', 'hPa', 'pressure at mean sea level'),
  ('weather_grid', 'relative_humidity_2m', '%', 'relative humidity at 2 m'),
  ('weather_grid', 'soil_moisture_0_to_1cm', 'm3/m3', 'soil moisture 0-1 cm'),
  ('weather_grid', 'is_day', NULL, 'daylight at the cell'),
  ('cercanias_position', 'ts', 'UTC', 'capture'),
  ('cercanias_position', 'vehicle', NULL, 'cercanias_vehicle.id'),
  ('cercanias_position', 'lat', 'degrees', 'latitude'),
  ('cercanias_position', 'lon', 'degrees', 'longitude'),
  ('cercanias_position', 'status', NULL, '0 STOPPED_AT, 1 INCOMING_AT, 2 IN_TRANSIT_TO'),
  ('cercanias_position', 'stop_id', NULL, 'GTFS stop id'),
  ('cercanias_position', 'delay_s', 'seconds', 'trip delay, unwrapped from the mod 86400 wrap; NULL without a trip update'),
  ('fgc_position', 'ts', 'UTC', 'capture'),
  ('fgc_position', 'seq', NULL, 'position of the record in the feed (1-based)'),
  ('fgc_position', 'unit', NULL, 'train unit id (ut); NULL when the feed gives none'),
  ('fgc_position', 'line', NULL, 'line'),
  ('fgc_position', 'lat', 'degrees', 'latitude'),
  ('fgc_position', 'lon', 'degrees', 'longitude'),
  ('fgc_position', 'direction', NULL, 'A ascending, D descending'),
  ('fgc_position', 'origin', NULL, 'origin station code'),
  ('fgc_position', 'destination', NULL, 'destination station code'),
  ('fgc_position', 'on_time', NULL, 'en_hora flag'),
  ('fgc_position', 'occupancy', '%', 'occupancy of the first car; NULL when the feed gives no number'),
  ('regional_pb', 'ts', 'UTC', 'capture'),
  ('regional_pb', 'feed', NULL, 'mb_vp Metro Bilbao positions, mb_tu Metro Bilbao trip updates, et_tu Euskotren trip updates'),
  ('regional_pb', 'gz', 'gzip bytes', 'raw GTFS-RT protobuf, gzipped'),
  ('aemet_warning', 'ts', 'UTC', 'capture'),
  ('aemet_warning', 'cap_file', NULL, 'CAP file name of the warning'),
  ('aemet_warning', 'level', NULL, 'amarillo, naranja or rojo'),
  ('aemet_warning', 'phenomenon', NULL, 'phenomenon'),
  ('aemet_warning', 'zone', NULL, 'zone'),
  ('aemet_warning', 'validity', NULL, 'validity text as published (CET/CEST)'),
  ('earthquake', 'ts', 'UTC', 'capture'),
  ('earthquake', 'evid', NULL, 'IGN event id'),
  ('earthquake', 'magnitude', 'magnitude', 'magnitude'),
  ('earthquake', 'place', NULL, 'place text'),
  ('earthquake', 'lat', 'degrees', 'latitude'),
  ('earthquake', 'lon', 'degrees', 'longitude'),
  ('earthquake', 'origin_ts', 'UTC', 'origin time'),
  ('kp', 'ts', 'UTC', 'capture'),
  ('kp', 'time_tag', 'UTC', 'time of the K index point'),
  ('kp', 'kp_index', 'Kp', 'planetary K index'),
  ('kp', 'estimated_kp', 'Kp', 'estimated K index'),
  ('swpc_alert', 'ts', 'UTC', 'capture'),
  ('swpc_alert', 'product_id', NULL, 'SWPC product id'),
  ('swpc_alert', 'issue_ts', 'UTC', 'issue time'),
  ('swpc_alert', 'message', NULL, 'message text'),
  ('ems_activation', 'ts', 'UTC', 'capture'),
  ('ems_activation', 'code', NULL, 'EMS activation code'),
  ('ems_activation', 'name', NULL, 'activation name'),
  ('ems_activation', 'event_ts', 'UTC', 'event time'),
  ('ems_activation', 'last_update', 'UTC', 'last update'),
  ('ems_country', 'ts', 'UTC', 'capture'),
  ('ems_country', 'code', NULL, 'EMS activation code'),
  ('ems_country', 'country', NULL, 'country name'),
  ('schedule_stop', 'ts', 'UTC', 'capture'),
  ('schedule_stop', 'train', NULL, 'train.id (idTren)'),
  ('schedule_stop', 'seq', NULL, 'stop order (1-based)'),
  ('schedule_stop', 'station', NULL, 'station code'),
  ('schedule_stop', 'arrival', 'Europe/Madrid time of day', 'planned arrival'),
  ('schedule_stop', 'departure', 'Europe/Madrid time of day', 'planned departure'),
  ('alert', 'ts', 'UTC', 'capture'),
  ('alert', 'alert_id', NULL, 'GTFS-RT alert id'),
  ('alert', 'n_entities', 'entities', 'number of informed entities'),
  ('alert', 'start_ts', 'UTC', 'start of the first active period'),
  ('alert', 'end_ts', 'UTC', 'end of the first active period'),
  ('alert', 'text', NULL, 'description text'),
  ('cancellation', 'ts', 'UTC', 'capture'),
  ('cancellation', 'trip_id', NULL, 'cancelled GTFS trip id'),
  ('cancellation', 'feed', NULL, 'all (every operator) or ld (long distance)'),
  ('gps_position', 'ts', 'UTC', 'snapshot'),
  ('gps_position', 'train', NULL, 'train.id'),
  ('gps_position', 'lat', 'degrees', 'latitude'),
  ('gps_position', 'lon', 'degrees', 'longitude'),
  ('gps_position', 'delay_min', 'minutes', 'last reported delay; 0 when unparseable'),
  ('gps_route', 'source_path', NULL, 'daily file'),
  ('gps_route', 'train', NULL, 'train.id'),
  ('gps_route', 'origin', NULL, 'origin station code'),
  ('gps_route', 'destination', NULL, 'destination station code'),
  ('stats_snapshot', 'ts', 'UTC', 'snapshot'),
  ('stats_snapshot', 'total', 'trains', 'trains with a parseable delay'),
  ('stats_snapshot', 'delayed', 'trains', 'trains with delay >= 1 min'),
  ('stats_snapshot', 'avg_delay_min', 'minutes', 'mean delay of the delayed trains'),
  ('stats_snapshot', 'max_delay_min', 'minutes', 'largest delay'),
  ('stats_snapshot', 'pct_delayed', '%', 'share of delayed trains'),
  ('stats_route', 'ts', 'UTC', 'snapshot'),
  ('stats_route', 'origin', NULL, 'origin station code'),
  ('stats_route', 'destination', NULL, 'destination station code'),
  ('stats_route', 'n', 'trains', 'trains on the route'),
  ('stats_route', 'avg_delay_min', 'minutes', 'mean delay of the delayed trains'),
  ('stats_route', 'max_delay_min', 'minutes', 'largest delay'),
  ('meta_table', 'table_name', NULL, 'table'),
  ('meta_table', 'source', NULL, 'file or JSON key the table is built from'),
  ('meta_table', 'description', NULL, 'what one row means'),
  ('meta_column', 'table_name', NULL, 'table'),
  ('meta_column', 'column_name', NULL, 'column'),
  ('meta_column', 'unit', NULL, 'unit or time zone; NULL for codes and free text'),
  ('meta_column', 'description', NULL, 'meaning of the column');

-- Public API (rules 6, 9): explicit column lists, surrogate ids resolved to codes. federate.py unions these views across partitions.
-- DuckDB views are read-only (no INSTEAD OF triggers, no updatable views); writes go through ingest.py to the base tables.
CREATE OR REPLACE VIEW v_ld_position AS SELECT t.ts, r.code AS train_id, t.lat, t.lon, t.delay_min, t.prev_station, t.next_station, t.next_arrival, t.pos_ts, t.stock, t.product FROM ld_position t JOIN train r ON r.id = t.train;
CREATE OR REPLACE VIEW v_ld_vehicle AS SELECT ts, seq, vehicle_id, status, stop_id FROM ld_vehicle;
CREATE OR REPLACE VIEW v_ld_trip_update AS SELECT ts, seq, trip_id, stop_id, delay_s, arrival_ts FROM ld_trip_update;
CREATE OR REPLACE VIEW v_weather_point AS SELECT ts, lat, lon, temperature_2m, precipitation, wind_speed_10m, wind_gusts_10m, visibility, weather_code FROM weather_point;
CREATE OR REPLACE VIEW v_weather_grid AS SELECT ts, lat, lon, temperature_2m, precipitation, snowfall, wind_speed_10m, wind_gusts_10m, visibility, weather_code, cloud_cover, pressure_msl, relative_humidity_2m, soil_moisture_0_to_1cm, is_day FROM weather_grid;
CREATE OR REPLACE VIEW v_cercanias_position AS SELECT t.ts, v.code AS vehicle_id, v.line, t.lat, t.lon, t.status, t.stop_id, t.delay_s FROM cercanias_position t JOIN cercanias_vehicle v ON v.id = t.vehicle;
CREATE OR REPLACE VIEW v_fgc_position AS SELECT ts, seq, unit, line, lat, lon, direction, origin, destination, on_time, occupancy FROM fgc_position;
CREATE OR REPLACE VIEW v_regional_pb AS SELECT ts, feed, gz FROM regional_pb;
CREATE OR REPLACE VIEW v_aemet_warning AS SELECT ts, cap_file, level, phenomenon, zone, validity FROM aemet_warning;
CREATE OR REPLACE VIEW v_earthquake AS SELECT ts, evid, magnitude, place, lat, lon, origin_ts FROM earthquake;
CREATE OR REPLACE VIEW v_kp AS SELECT ts, time_tag, kp_index, estimated_kp FROM kp;
CREATE OR REPLACE VIEW v_swpc_alert AS SELECT ts, product_id, issue_ts, message FROM swpc_alert;
CREATE OR REPLACE VIEW v_ems_activation AS SELECT ts, code, name, event_ts, last_update FROM ems_activation;
CREATE OR REPLACE VIEW v_ems_country AS SELECT ts, code, country FROM ems_country;
CREATE OR REPLACE VIEW v_schedule_stop AS SELECT t.ts, r.code AS train_id, t.seq, t.station, t.arrival, t.departure FROM schedule_stop t JOIN train r ON r.id = t.train;
CREATE OR REPLACE VIEW v_alert AS SELECT ts, alert_id, n_entities, start_ts, end_ts, text FROM alert;
CREATE OR REPLACE VIEW v_cancellation AS SELECT ts, trip_id, feed FROM cancellation;
CREATE OR REPLACE VIEW v_gps_position AS SELECT t.ts, r.code AS train_id, t.lat, t.lon, t.delay_min, g.origin, g.destination FROM gps_position t JOIN train r ON r.id = t.train JOIN cap_gps c ON c.ts = t.ts LEFT JOIN gps_route g ON g.source_path = c.source_path AND g.train = t.train;
CREATE OR REPLACE VIEW v_stats_snapshot AS SELECT ts, total, delayed, avg_delay_min, max_delay_min, pct_delayed FROM stats_snapshot;
CREATE OR REPLACE VIEW v_stats_route AS SELECT ts, origin, destination, n, avg_delay_min, max_delay_min FROM stats_route;
CREATE OR REPLACE VIEW v_capture AS SELECT s.kind, c.ts, c.path FROM (
  SELECT ts, source_path AS path FROM cap_extra UNION ALL SELECT ts, source_path FROM cap_cercanias UNION ALL SELECT ts, source_path FROM cap_regional
  UNION ALL SELECT ts, source_path FROM cap_env UNION ALL SELECT ts, source_path FROM cap_schedule UNION ALL SELECT ts, source_path FROM cap_weather
  UNION ALL SELECT ts, source_path FROM cap_alerts UNION ALL SELECT ts, source_path FROM cap_gps UNION ALL SELECT ts, source_path FROM cap_stats) c JOIN source s ON s.path = c.path;
CREATE OR REPLACE VIEW v_rejected AS SELECT source_path, table_name, reason, raw FROM rejected;
