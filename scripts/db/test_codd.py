"""Codd's rules 0..12 against daily partitions built by ingest.py. usage: test_codd.py DAY.duckdb [DAY2.duckdb ...]   (exit 1 on any FAIL)
The first partition takes the writes (every one inside a transaction that is rolled back, the file is left as it was);
all of them are attached and federated, and rules 8, 9 and 11 run over the whole set. A last line checks that the
checksums stored in every partition match its content (lossless build, no tampering since).
Honest limits (what no test here can guarantee):
  rule 6   DuckDB has no updatable views and no INSTEAD OF triggers: the check is the nearest equivalent, writes to a
           view fail loudly and the same write on the base table shows up in the view, partition and federated.
  rule 11  The data is distributed over one file per day and queried as one through federate.py, on one machine.
           DuckDB is not a distributed DBMS: there is no remote node, no replication, no distributed transaction.
  rule 12  Constraints cannot be bypassed through SQL (bulk COPY and set INSERTs included), but the raw JSON on the data
           branch can be altered by anyone with write access to it. Mitigation: the branch ruleset (no deletion, no
           force push), the checksums stored in each partition and the weekly rebuild of random days by build-db.yml
           that compares them. The JSON is the source of truth, not these files."""
import os, sys, tempfile
import duckdb
from federate import attach
from ingest import checksums

con = None
q = lambda s, *p: con.execute(s, *p).fetchall()
ROOTS = ("source", "station", "train", "cercanias_vehicle", "checksum", "meta_table")  # tables with nothing to reference
NESTED = ("LIST", "STRUCT", "MAP", "JSON", "UNION", "ARRAY")
FED = "memory.main.v_ld_position"

def tables(): return [r[0] for r in q("SELECT table_name FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal ORDER BY 1")]
def columns(): return q("SELECT table_name, column_name, data_type, is_nullable FROM duckdb_columns() WHERE database_name = current_database() AND NOT internal "
                        "AND table_name IN (SELECT table_name FROM duckdb_tables() WHERE database_name = current_database())")
def constraints(t, typ): return q("SELECT constraint_column_names, expression FROM duckdb_constraints() WHERE database_name = current_database() AND table_name = ? AND constraint_type = ?", [t, typ])
def pk(t): return constraints(t, "PRIMARY KEY")[0][0]
def parts(): return [p for (p,) in q("SELECT DISTINCT split_part(partition, '.', 1) FROM memory.main.partition ORDER BY 1")]
def raises(sql, exc=duckdb.Error):
    try: con.execute(sql)
    except exc: return True
    raise AssertionError("accepted: " + sql[:80])

def rule0():  # only tables and views, reading nothing outside the file
    assert len(tables()) >= 30
    for v, sql in q("SELECT view_name, sql FROM duckdb_views() WHERE database_name = current_database() AND NOT internal"):
        assert "read_" not in sql.lower() and "'" not in sql, f"view {v} reads outside the database"
    return f"{len(tables())} tables, {len(q('SELECT 1 FROM duckdb_views() WHERE database_name = current_database() AND NOT internal'))} views"

def rule1():  # every column is scalar
    bad = [(t, c, ty) for t, c, ty, _ in columns() if any(n in ty for n in NESTED)]
    assert not bad, bad
    return f"{len(columns())} scalar columns"

def rule2():  # table + primary key + column reaches exactly one value
    for t in tables():
        keys = pk(t)
        if not q(f"SELECT 1 FROM {t} LIMIT 1"): continue
        row = q(f"SELECT {', '.join(keys)} FROM {t} LIMIT 1")[0]
        n = q(f"SELECT count(*) FROM {t} WHERE {' AND '.join(k + ' = ?' for k in keys)}", list(row))[0][0]
        assert n == 1, f"{t}: {n} rows for key {row}"

def rule3():  # missing is NULL, never a sentinel
    for t, c, ty, _ in columns():
        if ty == "VARCHAR": assert q(f"SELECT count(*) FROM {t} WHERE {c} = ''")[0][0] == 0, f"{t}.{c} holds ''"
    assert q("SELECT count(*) FROM ld_position WHERE product = 0 OR pos_ts = '1970-01-01'")[0][0] == 0, "recorder sentinels 0 kept"
    assert q("SELECT NULL = NULL, NULL IS NULL, count(delay_s) <= count(*) FROM cercanias_position")[0] == (None, True, True)  # <=: a sparse day may have no missing delay
    nulls = sum(q(f"SELECT count(*) - count({c}) FROM {t}")[0][0] for t, c, ty, nullable in columns() if nullable)
    assert nulls > 0, "no NULL anywhere: missing values are hiding behind sentinels"
    return f"{nulls} NULL values"

def rule4():  # meta_* describe every table and column
    assert set(tables()) == {r[0] for r in q("SELECT table_name FROM meta_table")}, "meta_table out of sync"
    cols = {(t, c) for t, c, _, _ in columns()}
    meta = {(t, c) for t, c in q("SELECT table_name, column_name FROM meta_column")}
    assert cols == meta, f"meta_column out of sync: {sorted(cols ^ meta)[:5]}"
    return f"{len(meta)} columns documented"

def rule5():  # one language: DDL, DML, constraints, views, transactions
    con.execute("BEGIN")
    con.execute("CREATE TABLE r5 (x INTEGER PRIMARY KEY CHECK (x > 0))")
    con.execute("INSERT INTO r5 VALUES (1), (2)"); con.execute("UPDATE r5 SET x = 3 WHERE x = 2"); con.execute("DELETE FROM r5 WHERE x = 1")
    con.execute("CREATE VIEW r5v AS SELECT x FROM r5")
    assert q("SELECT * FROM r5v") == [(3,)]
    raises("INSERT INTO r5 VALUES (-1)", duckdb.ConstraintException)
    con.execute("ROLLBACK")
    assert not q("SELECT 1 FROM duckdb_tables() WHERE table_name = 'r5'"), "rollback did not undo the DDL"

def rule6():  # view write fails loudly; base-table write shows in both views
    raises("INSERT INTO v_ld_position (ts, train_id, lat, lon, delay_min) VALUES (now(), 'y', 40, -3, 0)")
    con.execute("BEGIN")
    ts, train = q("SELECT ts, train FROM ld_position LIMIT 1")[0]
    seen = f"SELECT count(*) FROM {FED} WHERE ts = ? AND train_id = (SELECT code FROM train WHERE id = ?)"
    con.execute("DELETE FROM ld_position WHERE ts = ? AND train = ?", [ts, train])
    assert q(seen, [ts, train])[0][0] == 0
    con.execute("INSERT INTO ld_position (ts, train, lat, lon, delay_min) VALUES (?, ?, 40, -3, 0)", [ts, train])
    assert q(seen, [ts, train])[0][0] == 1
    con.execute("ROLLBACK")
    return "partial: DuckDB views are read-only, writes go to the base table"

def rule7():  # insert, update, delete on sets
    con.execute("BEGIN")
    n0 = q("SELECT count(*) FROM ld_vehicle")[0][0]; k = min(100, n0)  # a sparse early day may have fewer than 100 rows
    assert k > 0, "ld_vehicle is empty: nothing to copy"
    con.execute(f"INSERT INTO ld_vehicle SELECT ts, seq + 100000, vehicle_id, status, stop_id FROM ld_vehicle LIMIT {k}")
    assert q("SELECT count(*) FROM ld_vehicle")[0][0] == n0 + k
    con.execute("UPDATE ld_vehicle SET stop_id = 'r7' WHERE seq > 100000")
    assert q("SELECT count(*) FROM ld_vehicle WHERE stop_id = 'r7'")[0][0] == k
    con.execute("DELETE FROM ld_vehicle WHERE seq > 100000")
    assert q("SELECT count(*) FROM ld_vehicle")[0][0] == n0
    con.execute("ROLLBACK")

def rule8():  # same answer from Parquet and from the set of partition files
    agg = "count(*), sum(delay_min), min(lat), max(lon), count(DISTINCT train_id)"
    with tempfile.TemporaryDirectory() as d:
        con.execute(f"COPY v_ld_position TO '{d}/p.parquet' (FORMAT PARQUET)")
        assert q(f"SELECT {agg} FROM v_ld_position") == q(f"SELECT {agg} FROM read_parquet('{d}/p.parquet')")
    per = [q(f"SELECT {agg} FROM {p}.v_ld_position")[0] for p in parts()]
    fed = q(f"SELECT {agg} FROM {FED}")[0]
    assert fed[0] == sum(r[0] for r in per) and fed[1] == sum(r[1] for r in per) and fed[2] == min(r[2] for r in per), (fed, per)
    return f"{len(per)} partitions"

def rule9():  # a new base column changes neither shape nor answer of the views
    before = q("DESCRIBE v_ld_position"), q(f"DESCRIBE {FED}"), q(f"SELECT count(*), sum(delay_min) FROM {FED}")
    con.execute("BEGIN"); con.execute("ALTER TABLE ld_position ADD COLUMN r9 INTEGER")
    assert (q("DESCRIBE v_ld_position"), q(f"DESCRIBE {FED}"), q(f"SELECT count(*), sum(delay_min) FROM {FED}")) == before
    con.execute("ROLLBACK")

def rule10():  # integrity lives in the catalog and the engine enforces it
    for t in tables():
        assert constraints(t, "PRIMARY KEY"), f"{t} has no primary key"
        if t not in ROOTS: assert constraints(t, "FOREIGN KEY"), f"{t} has no foreign key"
    for t in ("ld_position", "cercanias_position", "gps_position", "fgc_position", "weather_point", "weather_grid"):
        assert {c for cols, _ in constraints(t, "CHECK") for c in cols} >= {"lat", "lon"}, f"{t} has no lat/lon bounds"
    ts = q("SELECT ts FROM ld_position LIMIT 1")[0][0]
    raises(f"INSERT INTO ld_position (ts, train, lat, lon, delay_min) VALUES ('{ts}', 1, 90, -3, 0)", duckdb.ConstraintException)
    raises("INSERT INTO ld_position (ts, train, lat, lon, delay_min) VALUES ('2099-01-01', 1, 40, -3, 0)", duckdb.ConstraintException)
    raises(f"INSERT INTO ld_position (ts, train, lat, lon, delay_min) VALUES ('{ts}', 999999999, 40, -3, 0)", duckdb.ConstraintException)
    raises(f"INSERT INTO ld_position (ts, train, lat, lon, delay_min) VALUES ('{ts}', NULL, 40, -3, 0)", duckdb.ConstraintException)
    return f"{q('SELECT count(*) FROM duckdb_constraints() WHERE database_name = current_database()')[0][0]} constraints in the catalog"

def rule11():  # one file per day, one query over all, one query across two
    ps = parts()
    assert q(f"SELECT count(*) FROM {FED}")[0][0] == sum(q(f"SELECT count(*) FROM {p}.ld_position")[0][0] for p in ps)
    days = q(f"SELECT count(DISTINCT ts::DATE) FROM {FED}")[0][0]
    assert days == len(ps), f"{days} days in the federated view, {len(ps)} partitions"
    if len(ps) > 1:
        assert q(f"SELECT count(*) FROM {ps[0]}.train a JOIN {ps[1]}.train b ON a.code = b.code")[0][0] > 0, "no train code shared between two partitions"
    return f"partial: {len(ps)} partitions on one machine, not a distributed DBMS"

def rule12():  # bulk paths enforce the same constraints; a bad set inserts nothing
    ts = q("SELECT ts FROM ld_position LIMIT 1")[0][0]
    n0 = q("SELECT count(*) FROM ld_position")[0][0]
    with tempfile.TemporaryDirectory() as d:
        open(f"{d}/bad.csv", "w").write(f"{ts},999999998,40,-3,0,,,,,,\n{ts},999999997,99,-3,0,,,,,,\n")
        raises(f"COPY ld_position FROM '{d}/bad.csv'", duckdb.ConstraintException)
    raises(f"INSERT INTO ld_position (ts, train, lat, lon, delay_min) VALUES ('{ts}', 1, 40, -3, 0), ('{ts}', 2, 40, -3, 9999)", duckdb.ConstraintException)
    assert q("SELECT count(*) FROM ld_position")[0][0] == n0, "a failed set insert left rows behind"
    raises("DELETE FROM cap_extra WHERE ts IN (SELECT ts FROM ld_position LIMIT 1)", duckdb.ConstraintException)
    raises("DELETE FROM train WHERE id IN (SELECT train FROM ld_position LIMIT 1)", duckdb.ConstraintException)

def checksum():  # every partition still holds the content its checksums describe
    ps = parts()
    for p in ps:
        con.execute(f"USE {p}")
        stored = {t: (n, h) for t, n, h in q("SELECT table_name, rows, hash FROM checksum")}
        assert stored == checksums(con), f"{p}: stored checksums differ from the content"
    con.execute(f"USE {ps[0]}")
    return f"{len(ps)} partitions, {len(stored)} tables each"

RULES = [(0, "foundation", rule0), (1, "information", rule1), (2, "guaranteed access", rule2), (3, "systematic nulls", rule3),
         (4, "dynamic catalog", rule4), (5, "comprehensive language", rule5), (6, "view updating", rule6), (7, "set-level operations", rule7),
         (8, "physical independence", rule8), (9, "logical independence", rule9), (10, "integrity independence", rule10),
         (11, "distribution independence", rule11), (12, "non-subversion", rule12), ("", "checksums", checksum)]

if __name__ == "__main__":
    con = attach(duckdb.connect(), sys.argv[1:], read_only=False)
    con.execute("USE " + parts()[0])
    fails = 0
    for n, name, fn in RULES:
        try:
            note = fn(); print(f"rule {n!s:2} {name:26} PASS" + (f"  ({note})" if note else ""))
        except Exception as e:
            fails += 1; print(f"rule {n!s:2} {name:26} FAIL  {type(e).__name__}: {(str(e).splitlines() or [""])[0][:150]}")
            try: con.execute("ROLLBACK")
            except duckdb.Error: pass
    con.close()
    print(f"{len(RULES) - fails}/{len(RULES)} checks pass on {len(sys.argv) - 1} partition(s), {sum(os.path.getsize(f) for f in sys.argv[1:]) / 1e6:.1f} MB")
    sys.exit(1 if fails else 0)
