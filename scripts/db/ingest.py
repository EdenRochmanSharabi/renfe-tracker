"""Build one DuckDB partition per UTC day from a checkout of the data branch (conventions in schema.sql).
usage: ingest.py DATA_DIR OUT_DIR [--days N] [--parquet DIR] [--verify DIR]
  OUT_DIR/YYYY-MM-DD.duckdb per day present in DATA_DIR. --verify compares the checksums of each rebuilt day with
  DIR/YYYY-MM-DD.duckdb (stored and recomputed) and exits 1 on any difference. --parquet exports each day (ZSTD).
Idempotent: every table has a natural key and rows go in with INSERT OR IGNORE, so re-running over the same files adds
nothing. A staged row that breaks a constraint of its table goes to `rejected`; the constraints are read from the
catalog (duckdb_constraints), not repeated here. Set-based: each file set is read once with read_text and unnested in SQL."""
import argparse, glob, os, re, sys, time
import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
PER_CAPTURE = ("extra", "cercanias", "regional", "env", "schedule", "weather", "alerts")
DAILY = ("gps", "gps-night", "stats")
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}")
TS = "(regexp_extract(path, '\\d{4}-\\d{2}-\\d{2}') || ' ' || regexp_extract(path, '/(\\d{2})(?:-\\d{2})?\\.json$', 1) || ':' || coalesce(nullif(regexp_extract(path, '-(\\d{2})\\.json$', 1), ''), '00'))::TIMESTAMP"
HM = "(regexp_extract(path, '\\d{4}-\\d{2}-\\d{2}') || ' ' || replace(hm, '-', ':'))::TIMESTAMP"
MAD = "timezone('Europe/Madrid', try_cast({} AS TIMESTAMP))::TIMESTAMP"   # Europe/Madrid local text -> UTC
EPOCH = "to_timestamp(try_cast({} AS BIGINT))::TIMESTAMP"
DEG = "(try_cast({} AS INTEGER) / 100000.0)::DECIMAL(8,5)"                # lat*1e5 integer -> degrees
F = "j->>'f'"                                                             # feed timestamp field
BLOCK = int(os.environ.get("DB_BLOCK_SIZE", 16384))                       # small blocks: 33 tables, most of them tiny
WVARS = {"weather_point": ["temperature_2m", "precipitation", "wind_speed_10m", "wind_gusts_10m", "visibility", "weather_code"],
         "weather_grid": ["temperature_2m", "precipitation", "snowfall", "wind_speed_10m", "wind_gusts_10m", "visibility", "weather_code",
                          "cloud_cover", "pressure_msl", "relative_humidity_2m", "soil_moisture_0_to_1cm"]}
wcols = lambda t: ", ".join(f"w[list_position(v, '{c}')] AS {c}" for c in WVARS[t])
ROWS = "SELECT path, {ts} AS ts, unnest(json_transform(j->'{key}', '[[\"VARCHAR\"]]')) AS r FROM j"          # one row per list element
SEQ = "SELECT path, {ts} AS ts, unnest(l) AS r, generate_subscripts(l, 1) AS i FROM (SELECT path, json_transform(j->'{key}', '[[\"VARCHAR\"]]') AS l FROM j)"
errors = []

def load(con, table, select):
    """Stage `select` (its columns plus `path`), quarantine what breaks a constraint of `table`, insert the rest in key order."""
    con.execute(f"CREATE OR REPLACE TEMP TABLE stg AS SELECT DISTINCT * FROM ({select})")
    cons = con.execute("SELECT constraint_type, expression, constraint_column_names, referenced_table, referenced_column_names "
                       "FROM duckdb_constraints() WHERE database_name = current_database() AND table_name = ?", [table]).fetchall()
    tests = []  # (condition that must hold, reason)
    for typ, expr, cols, rtab, rcols in cons:
        if typ == "CHECK": tests.append((f"coalesce({expr}, TRUE)", "check " + expr.replace("'", "''")))
        elif typ == "NOT NULL": tests.append((f"s.{cols[0]} IS NOT NULL", "null " + cols[0]))
        elif typ == "FOREIGN KEY":
            on = " AND ".join(f"r.{a} = s.{b}" for a, b in zip(rcols, cols))
            tests.append((f"({' OR '.join(f's.{c} IS NULL' for c in cols)} OR EXISTS (SELECT 1 FROM {rtab} r WHERE {on}))", "foreign key " + rtab))
    ok = " AND ".join(t for t, _ in tests)
    reason = "CASE " + " ".join(f"WHEN NOT ({t}) THEN '{r}'" for t, r in tests) + " END"
    pk = ", ".join(next(cols for typ, _, cols, _, _ in cons if typ == "PRIMARY KEY"))
    raw = "to_json(s)::VARCHAR"  # as JSON, the conflict check would cast the stored rows too
    con.execute(f"INSERT OR IGNORE INTO rejected SELECT s.path, '{table}', {reason}, {raw} FROM stg s WHERE NOT ({ok})")
    con.execute(f"INSERT OR IGNORE INTO rejected SELECT s.path, '{table}', 'duplicate key', {raw} FROM stg s WHERE {ok} QUALIFY count(*) OVER (PARTITION BY {pk}) > 1")
    con.execute(f"INSERT OR IGNORE INTO {table} BY NAME SELECT * EXCLUDE (path) FROM stg s WHERE {ok} QUALIFY count(*) OVER (PARTITION BY {pk}) = 1 ORDER BY {pk}")

def dim(con, table, cols, select):
    """Add the codes of `select` missing from dimension `table`, with deterministic ids (sorted, after the existing ones)."""
    con.execute(f"INSERT OR IGNORE INTO {table} SELECT (SELECT coalesce(max(id), 0) FROM {table}) + row_number() OVER (ORDER BY {cols}), {cols} "
                f"FROM (SELECT DISTINCT {cols} FROM ({select}) WHERE ({cols}) IS NOT NULL AND ({cols}) NOT IN (SELECT ({cols}) FROM {table}))")

def read(con, root, kind, day, files):
    """Register the files in `source`, quarantine the unparseable ones, leave the rest in temp table j(path, j)."""
    con.execute("CREATE OR REPLACE TEMP TABLE raw AS SELECT substr(filename, ?) AS path, content FROM read_text(?)", [len(root) + 2, files])
    con.execute("INSERT OR IGNORE INTO source SELECT path, ?, ?::DATE, strlen(content), now()::TIMESTAMP FROM raw", [kind, day])
    con.execute("INSERT OR IGNORE INTO rejected SELECT path, 'source', 'invalid JSON', left(content, 200) FROM raw WHERE path LIKE '%.json' AND NOT json_valid(content)")
    con.execute("CREATE OR REPLACE TEMP TABLE j AS SELECT path, content::JSON AS j FROM raw WHERE json_valid(content)")

def capture(con, table, extra=""):
    load(con, table, f"SELECT path, {TS} AS ts, path AS source_path{extra} FROM j")

def extra(con):
    capture(con, "cap_extra", f", {MAD.format(F)} AS feed_ts, try_cast(j->>'np' AS INTEGER) AS not_positioned")
    dim(con, "train", "code", f"SELECT nullif(r[1], '') AS code FROM ({ROWS.format(ts=TS, key='tr')})")
    load(con, "ld_position", f"""SELECT path, ts, d.id AS train, {DEG.format('r[2]')} AS lat, {DEG.format('r[3]')} AS lon, try_cast(r[4] AS INTEGER) AS delay_min,
        nullif(r[5], '') AS prev_station, nullif(r[6], '') AS next_station, {MAD.format("nullif(r[7], '')")} AS next_arrival, {EPOCH.format("nullif(r[8], '0')")} AS pos_ts,
        nullif(r[9], '') AS stock, try_cast(nullif(r[10], '0') AS INTEGER) AS product FROM ({ROWS.format(ts=TS, key='tr')}) LEFT JOIN train d ON d.code = nullif(r[1], '')""")
    load(con, "ld_vehicle", f"SELECT path, ts, i AS seq, nullif(r[1], '') AS vehicle_id, try_cast(r[2] AS SMALLINT) AS status, nullif(r[3], '') AS stop_id FROM ({SEQ.format(ts=TS, key='v')})")
    load(con, "ld_trip_update", f"""SELECT path, ts, i AS seq, nullif(r[1], '') AS trip_id, nullif(r[3], '') AS stop_id, try_cast(r[2] AS INTEGER) AS delay_s,
        {EPOCH.format("nullif(r[4], '')")} AS arrival_ts FROM ({SEQ.format(ts=TS, key='u')})""")
    load(con, "weather_point", f"""SELECT path, ts, try_cast(p[2] AS DECIMAL(8,5)) AS lat, try_cast(p[3] AS DECIMAL(8,5)) AS lon, {wcols('weather_point')}
        FROM (SELECT path, {TS} AS ts, unnest(ps) AS p, unnest(ws) AS w, v FROM (SELECT path, json_transform(j->'wp', '[["VARCHAR"]]') AS ps,
              json_transform(j->'w', '[["DOUBLE"]]') AS ws, json_transform(j->'wv', '["VARCHAR"]') AS v FROM j WHERE json_exists(j, '$.w')))""")

def cercanias(con):
    capture(con, "cap_cercanias", f", {EPOCH.format(F)} AS feed_ts")
    rows = ROWS.format(ts=TS, key="v")
    dim(con, "cercanias_vehicle", "code, line", f"SELECT nullif(r[1], '') AS code, nullif(r[2], '') AS line FROM ({rows})")
    load(con, "cercanias_position", f"""SELECT path, ts, d.id AS vehicle, {DEG.format('r[3]')} AS lat, {DEG.format('r[4]')} AS lon, try_cast(r[5] AS SMALLINT) AS status,
        nullif(r[6], '') AS stop_id, ((try_cast(r[7] AS INTEGER) + 43200) % 86400 + 86400) % 86400 - 43200 AS delay_s
        FROM ({rows}) LEFT JOIN cercanias_vehicle d ON d.code = nullif(r[1], '') AND d.line = nullif(r[2], '')""")  # positive modulo undoes the wrap

def regional(con):
    capture(con, "cap_regional")
    load(con, "fgc_position", f"""SELECT path, ts, i AS seq, nullif(r[1], '') AS unit, nullif(r[2], '') AS line, {DEG.format('r[3]')} AS lat, {DEG.format('r[4]')} AS lon,
        nullif(r[5], '') AS direction, nullif(r[6], '') AS origin, nullif(r[7], '') AS destination, try_cast(r[8] AS BOOLEAN) AS on_time, try_cast(r[9] AS SMALLINT) AS occupancy
        FROM ({SEQ.format(ts=TS, key='fgc')})""")
    load(con, "regional_pb", f"""SELECT path, {TS} AS ts, feed, from_base64(b) AS gz FROM (
        SELECT path, 'mb_vp' AS feed, j->'mb'->>'vp' AS b FROM j WHERE json_exists(j, '$.mb.vp')
        UNION ALL SELECT path, 'mb_tu', j->'mb'->>'tu' FROM j WHERE json_exists(j, '$.mb.tu')
        UNION ALL SELECT path, 'et_tu', j->>'et' FROM j WHERE json_exists(j, '$.et'))""")

def env(con):
    capture(con, "cap_env")
    load(con, "aemet_warning", f"SELECT path, ts, nullif(r[5], '') AS cap_file, nullif(r[1], '') AS level, nullif(r[2], '') AS phenomenon, nullif(r[3], '') AS zone, nullif(r[4], '') AS validity FROM ({ROWS.format(ts=TS, key='aemet')})")
    load(con, "earthquake", f"""SELECT path, ts, nullif(r[1], '') AS evid, try_cast(r[2] AS DOUBLE) AS magnitude, nullif(r[3], '') AS place, try_cast(r[4] AS DECIMAL(8,5)) AS lat,
        try_cast(r[5] AS DECIMAL(8,5)) AS lon, try_strptime(r[6], '%d/%m/%Y %H:%M:%S') AS origin_ts FROM ({ROWS.format(ts=TS, key='ign')})""")
    load(con, "kp", f"""SELECT path, {TS} AS ts, try_cast(j->'kp'->'k'->>'time_tag' AS TIMESTAMP) AS time_tag, try_cast(j->'kp'->'k'->>'kp_index' AS DOUBLE) AS kp_index,
        try_cast(j->'kp'->'k'->>'estimated_kp' AS DOUBLE) AS estimated_kp FROM j WHERE json_exists(j, '$.kp.k')""")
    load(con, "swpc_alert", f"""SELECT path, {TS} AS ts, a->>'product_id' AS product_id, try_cast(a->>'issue_datetime' AS TIMESTAMP) AS issue_ts, nullif(a->>'message', '') AS message
        FROM (SELECT path, unnest(json_transform(j->'kp'->'a', '["JSON"]')) AS a FROM j)""")
    load(con, "ems_activation", f"""SELECT path, {TS} AS ts, e->>'code' AS code, nullif(e->>'name', '') AS name, try_cast(e->>'eventTime' AS TIMESTAMP) AS event_ts,
        try_cast(e->>'lastUpdate' AS TIMESTAMP) AS last_update FROM (SELECT path, unnest(json_transform(j->'ems', '["JSON"]')) AS e FROM j)""")
    load(con, "ems_country", f"""SELECT path, {TS} AS ts, e->>'code' AS code, unnest(json_transform(e->'countries', '["VARCHAR"]')) AS country
        FROM (SELECT path, unnest(json_transform(j->'ems', '["JSON"]')) AS e FROM j)""")

def schedule(con):
    capture(con, "cap_schedule", f", {MAD.format(F)} AS feed_ts")
    stops = f"""SELECT path, {TS} AS ts, nullif(t->>0, '') AS code, i AS seq, nullif(s[1], '') AS station, try_cast(s[2] AS TIME) AS arrival, try_cast(s[3] AS TIME) AS departure
        FROM (SELECT path, t, unnest(st) AS s, generate_subscripts(st, 1) AS i FROM (SELECT path, t, json_transform(t->1, '[["VARCHAR"]]') AS st
              FROM (SELECT path, unnest(json_transform(j->'tr', '["JSON"]')) AS t FROM j)))"""
    dim(con, "train", "code", stops)
    load(con, "schedule_stop", f"SELECT x.path, x.ts, d.id AS train, x.seq, x.station, x.arrival, x.departure FROM ({stops}) x LEFT JOIN train d ON d.code = x.code")

def weather(con):
    capture(con, "cap_weather", ", try_cast(j->>'t' AS TIMESTAMP) AS feed_ts")
    load(con, "weather_grid", f"""SELECT path, ts, try_cast(g[1] AS DECIMAL(8,5)) AS lat, try_cast(g[2] AS DECIMAL(8,5)) AS lon, {wcols('weather_grid')}, w[list_position(v, 'is_day')]::BOOLEAN AS is_day
        FROM (SELECT path, {TS} AS ts, unnest(gs) AS g, unnest(ws) AS w, v FROM (SELECT path, json_transform(j->'g', '[["DOUBLE"]]') AS gs,
              json_transform(j->'w', '[["DOUBLE"]]') AS ws, json_transform(j->'v', '["VARCHAR"]') AS v FROM j))""")

def alerts(con):
    capture(con, "cap_alerts", f", {EPOCH.format(F.replace('f', 'ts'))} AS feed_ts")
    load(con, "alert", f"""SELECT path, ts, nullif(r[1], '') AS alert_id, try_cast(r[4] AS INTEGER) AS n_entities, {EPOCH.format('r[2]')} AS start_ts, {EPOCH.format('r[3]')} AS end_ts,
        nullif(r[5], '') AS text FROM ({ROWS.format(ts=TS, key='a')})""")
    load(con, "cancellation", f"""SELECT path, {TS} AS ts, c AS trip_id, 'all' AS feed FROM (SELECT path, unnest(json_transform(j->'c', '["VARCHAR"]')) AS c FROM j)
        UNION ALL SELECT path, {TS}, c, 'ld' FROM (SELECT path, unnest(json_transform(j->'cl', '["VARCHAR"]')) AS c FROM j)""")

def gps(con):
    load(con, "cap_gps", f"SELECT path, {HM} AS ts, path AS source_path FROM (SELECT path, unnest(json_keys(j->'p')) AS hm FROM j)")
    dim(con, "train", "code", """SELECT nullif(c, '') AS code FROM (SELECT unnest(json_transform(j->'o', '["VARCHAR"]')) AS c FROM j)""")
    load(con, "gps_position", f"""SELECT path, {HM} AS ts, d.id AS train, (p[1] / 100000.0)::DECIMAL(8,5) AS lat, (p[2] / 100000.0)::DECIMAL(8,5) AS lon, p[3] AS delay_min
        FROM (SELECT path, hm, o, unnest(row) AS p, generate_subscripts(row, 1) AS i FROM (SELECT path, hm, json_transform(j->'p'->hm, '[["INTEGER"]]') AS row,
              json_transform(j->'o', '["VARCHAR"]') AS o FROM (SELECT path, j, unnest(json_keys(j->'p')) AS hm FROM j))) x LEFT JOIN train d ON d.code = nullif(x.o[x.i], '')
        WHERE p IS NOT NULL""")
    load(con, "gps_route", """SELECT path, path AS source_path, d.id AS train, s[r[i][1] + 1] AS origin, s[r[i][2] + 1] AS destination
        FROM (SELECT path, o, r, s, generate_subscripts(o, 1) AS i FROM (SELECT path, json_transform(j->'o', '["VARCHAR"]') AS o, json_transform(j->'r', '[["INTEGER"]]') AS r,
              json_transform(j->'s', '["VARCHAR"]') AS s FROM j)) x LEFT JOIN train d ON d.code = nullif(x.o[x.i], '')""")  # index -1 lands on s[0], which is NULL

def stats(con):
    load(con, "cap_stats", f"SELECT path, {HM} AS ts, path AS source_path FROM (SELECT path, unnest(json_keys(j->'snapshots')) AS hm FROM j)")
    load(con, "stats_snapshot", f"""SELECT path, {HM} AS ts, try_cast(v->>'total' AS INTEGER) AS total, try_cast(v->>'delayed' AS INTEGER) AS delayed,
        try_cast(v->>'avg' AS DOUBLE) AS avg_delay_min, try_cast(v->>'max' AS INTEGER) AS max_delay_min, try_cast(v->>'pct' AS DOUBLE) AS pct_delayed
        FROM (SELECT path, hm, j->'snapshots'->hm AS v FROM (SELECT path, j, unnest(json_keys(j->'snapshots')) AS hm FROM j))""")
    load(con, "stats_route", f"""SELECT path, {HM} AS ts, nullif(split_part(k, '-', 1), '') AS origin, nullif(split_part(k, '-', 2), '') AS destination,
        try_cast(v->>'n' AS INTEGER) AS n, try_cast(v->>'avg' AS DOUBLE) AS avg_delay_min, try_cast(v->>'max' AS INTEGER) AS max_delay_min
        FROM (SELECT path, hm, k, j->'routes'->hm->k AS v FROM (SELECT path, j, hm, unnest(json_keys(j->'routes'->hm)) AS k FROM (SELECT path, j, unnest(json_keys(j->'routes')) AS hm FROM j)))""")

INGEST = dict(extra=extra, cercanias=cercanias, regional=regional, env=env, schedule=schedule, weather=weather, alerts=alerts, gps=gps, **{"gps-night": gps}, stats=stats)

def run(con, what, fn, *a):
    try: fn(con, *a)
    except duckdb.Error as e:
        errors.append(what); print(f"ERROR {what}: {str(e).splitlines()[0]}", file=sys.stderr)

def checksums(con):
    """{table: (rows, hash)} over every table but checksum itself; source.ingested_at is left out."""
    out = {}
    for (t,) in con.execute("SELECT table_name FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal AND table_name <> 'checksum' ORDER BY 1").fetchall():
        cols = ", ".join(c for (c,) in con.execute("SELECT column_name FROM duckdb_columns() WHERE database_name = current_database() AND table_name = ? AND column_name <> 'ingested_at'", [t]).fetchall())
        out[t] = con.execute(f"SELECT count(*), coalesce(bit_xor(hash({cols})), 0) FROM {t}").fetchone()
    return out

def build(root, day, out, csv):
    con = duckdb.connect(); con.execute("SET TimeZone = 'UTC'")
    con.execute(f"ATTACH '{out}' AS part (BLOCK_SIZE {BLOCK})"); con.execute("USE part")
    con.execute(open(f"{HERE}/schema.sql").read())
    if csv:
        read(con, root, "static", None, [csv])
        run(con, "station", load, "station", f"""SELECT 'static/renfe_estaciones.csv' AS path, nullif(trim(code), '') AS code, nullif(trim(name), '') AS name,
            try_cast(replace(lat, ',', '.') AS DECIMAL(8,5)) AS lat, try_cast(replace(lon, ',', '.') AS DECIMAL(8,5)) AS lon, nullif(trim(city), '') AS city, nullif(trim(province), '') AS province
            FROM read_csv('{csv.replace("'", "''")}', header = true, all_varchar = true, names = ['code', 'name', 'lat', 'lon', 'address', 'cp', 'city', 'province', 'country'])""")
    for kind in PER_CAPTURE + DAILY:
        files = sorted(glob.glob(f"{root}/{kind}/{day}/*.json" if kind in PER_CAPTURE else f"{root}/{kind}/{day}.json"))
        if files:
            read(con, root, kind, day, files); run(con, f"{kind}/{day}", INGEST[kind])
    con.execute("DELETE FROM checksum")
    con.executemany("INSERT INTO checksum VALUES (?, ?, ?)", [(t, n, h) for t, (n, h) in checksums(con).items()])
    return con

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("data_dir"); ap.add_argument("out_dir")
    ap.add_argument("--days", type=int, help="only the last N days present in DATA_DIR"); ap.add_argument("--parquet", help="also export each day here as Parquet (ZSTD)")
    ap.add_argument("--verify", help="compare each day with DIR/YYYY-MM-DD.duckdb instead of trusting it")
    a = ap.parse_args(); root = os.path.abspath(a.data_dir); os.makedirs(a.out_dir, exist_ok=True)
    csv = f"{root}/static/renfe_estaciones.csv"; csv = csv if os.path.exists(csv) else None
    days = sorted({n[:10] for k in PER_CAPTURE + DAILY if os.path.isdir(f"{root}/{k}") for n in os.listdir(f"{root}/{k}") if DAY.match(n)})
    for day in days[-a.days:] if a.days else days:
        t = time.time(); out = f"{a.out_dir}/{day}.duckdb"
        con = build(root, day, out, csv)
        for tb, (n, _) in checksums(con).items(): print(f"{day} {tb:20} {n:>10}")
        for tb, why, n in con.execute("SELECT table_name, reason, count(*) FROM rejected GROUP BY ALL ORDER BY 3 DESC LIMIT 12").fetchall(): print(f"{day} rejected {tb}: {why} x{n}")
        if a.parquet: con.execute(f"EXPORT DATABASE '{a.parquet}/{day}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        if a.verify:
            mine = checksums(con); con.execute(f"ATTACH '{a.verify}/{day}.duckdb' AS pub (READ_ONLY)")
            stored = dict((t, (n, h)) for t, n, h in con.execute("SELECT table_name, rows, hash FROM pub.checksum").fetchall())
            con.execute("USE pub"); recomputed = checksums(con); con.execute("USE part")
            for tb in mine:
                if not mine[tb] == stored.get(tb) == recomputed.get(tb):
                    errors.append(f"verify {day} {tb}"); print(f"MISMATCH {day} {tb}: rebuilt {mine[tb]} published {stored.get(tb)} recomputed {recomputed.get(tb)}", file=sys.stderr)
            print(f"{day} verify: {len(mine)} tables compared")
        con.close()
        print(f"{out}: {os.path.getsize(out) / 1e6:.1f} MB in {time.time() - t:.0f}s")
    sys.exit(1 if errors else 0)

if __name__ == "__main__":
    main()
