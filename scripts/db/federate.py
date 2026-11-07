"""Query several daily partitions as one database.
usage: federate.py 'parts/*.duckdb' "SELECT count(*) FROM v_ld_position"
   or: from federate import attach; con = attach(duckdb.connect(), glob.glob("parts/*.duckdb"))
Every partition is attached as p_YYYY_MM_DD (read-only by default). The v_* views are unioned across partitions in the
in-memory catalog, the dimension and catalog tables come from the first partition, and `partition` lists every
partition with its checksums."""
import glob, os, re, sys
import duckdb

def attach(con, files, read_only=True):
    names = []
    for f in sorted(files):
        n = "p_" + re.sub(r"\W", "_", os.path.basename(f).removesuffix(".duckdb"))
        con.execute(f"ATTACH '{f}' AS {n}" + (" (READ_ONLY)" if read_only else "")); names.append(n)
    for (v,) in con.execute("SELECT view_name FROM duckdb_views() WHERE database_name = ? AND NOT internal", [names[0]]).fetchall():
        con.execute(f"CREATE OR REPLACE VIEW memory.main.{v} AS " + " UNION ALL ".join(f"SELECT * FROM {n}.{v}" for n in names))
    for t in ("station", "meta_table", "meta_column"):
        con.execute(f"CREATE OR REPLACE VIEW memory.main.{t} AS SELECT * FROM {names[0]}.{t}")
    con.execute("CREATE OR REPLACE VIEW memory.main.partition AS " + " UNION ALL ".join(f"SELECT '{n}' AS partition, * FROM {n}.checksum" for n in names))
    return con

if __name__ == "__main__":
    con = attach(duckdb.connect(), glob.glob(sys.argv[1]))
    rows = con.execute(sys.argv[2]).fetchall()
    print(*(d[0] for d in con.description), sep="\t")
    for r in rows: print(*r, sep="\t")
