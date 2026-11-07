# Relational layer (DuckDB)

The recorders write raw JSON to the `data` branch and never change. This directory derives from it one DuckDB file
per UTC day: normalized tables (one row per train per capture), a primary key on every table, foreign keys to the
capture and the source file, CHECK bounds, real NULLs, a quarantine table, a queryable catalog and a checksum of
every table. `build-db.yml` builds yesterday's partition every day at 08:15 UTC and publishes it as
`YYYY-MM-DD.duckdb.zst` in the release `db-YYYY-MM`; on Sundays it rebuilds three random published days from the
JSON and compares checksums. Partitions are immutable once published. The JSON stays the source of truth.

## Tables

| table | one row per | from |
|---|---|---|
| `source` | file read from the branch | path |
| `cap_extra`, `cap_cercanias`, `cap_regional`, `cap_env`, `cap_schedule`, `cap_weather`, `cap_alerts`, `cap_gps`, `cap_stats` | capture (ts from the file name) of that source kind | file names |
| `train`, `cercanias_vehicle` | train code / (vehicle id, line) seen that day, with a small integer id | `extra`, `gps`, `schedule`, `cercanias` |
| `ld_position` | long-distance train per minute | `extra` tr |
| `ld_vehicle`, `ld_trip_update` | GTFS-RT LD entity per capture | `extra` v, u |
| `weather_point`, `weather_grid` | Open-Meteo point every 15 min / 0.5 degree cell every hour | `extra` w, `weather` |
| `cercanias_position` | Cercanias vehicle per 5 min, delay unwrapped | `cercanias` v |
| `fgc_position`, `regional_pb` | FGC train per 5 min; Metro Bilbao and Euskotren protobuf (gzip BLOB) | `regional` |
| `aemet_warning`, `earthquake`, `kp`, `swpc_alert`, `ems_activation`, `ems_country` | environmental context per 15 min | `env` |
| `schedule_stop` | planned stop of a running train, hourly | `schedule` |
| `alert`, `cancellation` | Renfe service alert and cancelled trip, hourly | `alerts` |
| `gps_position`, `gps_route` | long-distance position per 5 min and the route of each train that day | `gps`, `gps-night` |
| `stats_snapshot`, `stats_route` | fleet delay summary per 5 min and per route per hour | `stats` |
| `station` | Renfe station code (replicated in every partition) | `static/renfe_estaciones.csv` |
| `rejected` | staged row that broke a constraint (source path, table, reason, raw JSON) | ingest |
| `checksum` | table with its row count and content hash at build time | ingest |
| `meta_table`, `meta_column` | table / column with source, unit and description | schema.sql |

Conventions (top of `schema.sql`): keys are `(ts, small integer)`, every TIMESTAMP is UTC, positions are DECIMAL
degrees, NULL means the feed gave no value (recorder sentinels like `''`, `0`, `-1` are mapped to NULL on ingest).
The public API is the `v_*` views: explicit column lists, surrogate ids resolved to codes (`train_id`,
`vehicle_id`), so a new base column changes no view.

## Query

```bash
pip install -r scripts/db/requirements.txt
gh release download db-2026-11 -p '*.duckdb.zst' -D parts && zstd -d --rm parts/*.zst
python3 scripts/db/federate.py 'parts/*.duckdb' "SELECT ts::DATE AS day, max(delay_min) FROM v_ld_position GROUP BY 1 ORDER BY 1"
```

`federate.py` attaches every partition (365 files attach in 0.1 s) and unions the `v_*` views; from Python,
`from federate import attach; con = attach(duckdb.connect(), files)`. A single partition also opens directly with
`duckdb parts/2026-11-05.duckdb`. The catalog answers questions about itself:

```sql
SELECT column_name, unit, description FROM meta_column WHERE table_name = 'cercanias_position';
SELECT * FROM partition;   -- federated: every partition with its checksums
```

## Rebuild and verify

```bash
git clone --depth 1 --branch data --filter=blob:none https://github.com/EdenRochmanSharabi/renfe-tracker.git data
python3 scripts/db/ingest.py data parts --days 4 [--parquet DIR] [--verify PUBLISHED_DIR]
python3 scripts/db/test_codd.py parts/*.duckdb
```

Ingest is idempotent (natural keys, `INSERT OR IGNORE`) and deterministic: a rebuild of the same day gives the same
checksums, which is what `--verify` and the Sunday job rely on. It reads each file set once with `read_text`,
unnests it in SQL and inserts in key order; the constraints it checks before inserting are read from
`duckdb_constraints()`, so `schema.sql` is the only place they are written. One day takes 3 to 4 s.

## Size: what was measured (real days 2026-11-03 to 2026-11-06)

| technique | MB/day | notes |
|---|---|---|
| text keys, one file, 256 KiB blocks | 56 | first design; PK over (VARCHAR, VARCHAR) costs 97 B/row |
| `(ts, integer)` keys, one capture table per kind | 54 | ld_position index 93 B/row with FK, 60 without |
| plus 16 KiB blocks (`BLOCK_SIZE`) | 35 | 33 tables, most tiny: each cost 1 to 2 MB in 256 KiB blocks |
| plus insert in key order | included | ld_position column data 17% smaller; ordering by entity is worse |
| change-only rows (validity intervals) | rejected | 1.0x on ld_position (pos_ts changes every minute), 1.6x cercanias, 1.1x gps; only aemet (43x) and ems (47x) gain, under 1 MB/day |
| narrower column types, more dimensions | rejected | no change: DuckDB already stores columns as DICT_FSST, RLE and BitPacking |
| `zstd -19 --long=27` on the file (published) | 7.8 | lossless, `zstd -d` restores the identical file in 0.0 s; `zstd -3` gives 9.6, `xz -9` 7.1 but 0.4 s to decompress |
| Parquet export, ZSTD 19 (`--parquet`) | 4.95 | `schema.sql` in the export keeps PK/FK/CHECK; `IMPORT DATABASE` restores the partition in 0.7 s |

A year is 365 assets of about 8 MB, 2.9 GB in all, each far below the 2 GB limit; decompressed on disk it is
13 GB, a month 1.1 GB. Column data alone is 20 B/row; the rest is the PK/FK indexes (DuckDB keeps an ART index per
constraint) that make the rules hold. The Parquet export is 38% smaller but is a serialization, not a database:
the constraints live in its `schema.sql` and only exist again after `IMPORT DATABASE`.

## Codd's rules

`test_codd.py` runs one check per rule over the attached partitions and exits 1 on any FAIL. Every write it
makes is rolled back; the first partition is byte-identical afterwards.

| rule | status | what is checked |
|---|---|---|
| 0 foundation | pass | only tables and views; no view reads outside the file |
| 1 information | pass | every column is a scalar (no LIST/STRUCT/JSON) |
| 2 guaranteed access | pass | table + primary key + column reaches exactly one value, every table |
| 3 systematic nulls | pass | no `''` in any VARCHAR, no `0`/epoch sentinels, NULLs really used |
| 4 dynamic catalog | pass | `meta_table`/`meta_column` match the real tables and columns |
| 5 comprehensive language | pass | DDL, DML, view, constraint and transaction in SQL, rolled back |
| 6 view updating | partial | DuckDB has no updatable views or INSTEAD OF triggers; a view write fails loudly and the base-table write shows through the partition view and the federated one |
| 7 set-level operations | pass | set INSERT/UPDATE/DELETE |
| 8 physical independence | pass | same answer from a Parquet copy and from the set of partition files behind the federated view |
| 9 logical independence | pass | adding a base column changes neither shape nor answer of the views, partition or federated |
| 10 integrity independence | pass | PK on every table, FK on every non-root table, lat/lon CHECKs, enforced by the engine |
| 11 distribution independence | partial | one file per day queried as one, and one query spanning two partitions; DuckDB is not a distributed DBMS |
| 12 non-subversion | partial | COPY and set INSERTs cannot bypass constraints, parents cannot be deleted under children; the raw JSON upstream can still be altered by anyone with write access to the `data` branch (mitigated by the branch ruleset, the stored checksums and the Sunday rebuild) |
| checksums | pass | every partition still holds the content its `checksum` table describes |

## Retention (`prune-data.yml`)

The raw JSON stays on the `data` branch for 30 days. Every Sunday (10:15 UTC) each day older than that is rebuilt from
its JSON, compared table by table with its published partition, and only if every checksum matches is its JSON removed
(at most 7 days per run, and a day without a published partition is never touched). A mismatch keeps the JSON and
opens an issue. Run it by hand with `dry_run=true` (default) to list what would go. Removing files does not shrink the
repository by itself: git keeps the old blobs until the history of `data` is squashed, which needs a one-off manual step
with the branch ruleset bypassed (see the project notes). The partitions in the `db-YYYY-MM` releases are the permanent
archive.
