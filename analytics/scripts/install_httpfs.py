"""Install DuckDB's httpfs into DUCKDB_EXTENSION_DIR (default: analytics/.duckdb-extensions)."""

import os

import duckdb

TARGET = os.environ.get("DUCKDB_EXTENSION_DIR", ".duckdb-extensions")

connection = duckdb.connect()
connection.execute(f"SET extension_directory = '{TARGET}'")
connection.execute("INSTALL httpfs")
connection.execute("LOAD httpfs")
print(f"httpfs installed into {TARGET}")
