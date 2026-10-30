# Data branch

Written by the cron endpoints in `api/` (main branch). All times in file names and keys are UTC.
Read directories with `git` (`git ls-tree`), not the Contents API: it lists at most 1000 files per directory.

| Path | Writer | Format |
|---|---|---|
| `gps/YYYY-MM-DD.json` | record-gps, every 5 min | `{s:[stations], r:[[origIdx,destIdx]], o:[train ids], p:{"HH-MM":[null or [lat*1e5, lon*1e5, delay] per train in o order]}}` |
| `gps-night/YYYY-MM-DD.json` | record-gps | same, used when fewer than 20 trains are running |
| `stats/YYYY-MM-DD.json` | record-stats, every 5 min | `{snapshots:{"HH-MM":{total,delayed,avg,max,pct}}, routes:{...}}` (routes hourly) |
| `extra/YYYY-MM-DD/HH.json` | record-extra, old format (until the new code is deployed) | `{wp,wv,c:{"HH-MM":{f,np,tr:[[id,codEstAnt,codEstSig,horaLlegadaSigEst,time,mat,codProduct]], w}}}`, one file per hour |
| `extra/YYYY-MM-DD/HH-MM.json` | record-extra, new format | one capture per file: `{f,np,tr:[[id,lat*1e5,lon*1e5,delay,codEstAnt,codEstSig,horaLlegadaSigEst,time,mat,codProduct]], wp,wv,w}`; weather only when minute % 15 == 0 |
| `schedule/YYYY-MM-DD/HH.json` | record-schedule, hourly | `{f, tr:[[idTren,[[station,plannedArrival,plannedDeparture],...]],...]}` |

`wp` = weather points `[name,lat,lon]`, `wv` = variable names, `w` = values per point in `wv` order.
`f` = feed timestamp (Spanish local time), `np` = number of unpositioned trains.

## Static reference data (`static/`, downloaded once on 2026-10-30)

| File | Source | Content |
|---|---|---|
| `static/osm_ways_highspeed.json` | OpenStreetMap | 6644 ways `railway=rail highspeed=yes`: `id`, `maxspeed`, `electrified`, `railway:etcs`, `railway:lzb`, `railway:traffic_mode`, `usage`, `service`, `name`, `tunnel`, `bridge`, `geom` = `[[lat,lon],...]` (5 decimals). LZB tags are incomplete. |
| `static/osm_level_crossings.json` | OpenStreetMap | 5047 nodes `railway=level_crossing`: `id`, `lat`, `lon`, `crossing*` tags (barrier info on only about a quarter of them). |
| `static/renfe_estaciones.csv` | data.renfe.com | 646 stations with coordinates. `;` separated, UTF-8 with BOM, decimal comma. |
| `static/renfe_trenes.csv` | data.renfe.com | Technical sheets of 38 train series (max speed, signalling). `;` separated, ISO-8859-1. |

OpenStreetMap data: (c) OpenStreetMap contributors, licensed under the ODbL (https://www.openstreetmap.org/copyright). Renfe data: CC BY 4.0.
