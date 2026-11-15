"""Install DuckDB's httpfs into analytics/.duckdb-extensions for local S3 reads."""

import duckdb

TARGET = ".duckdb-extensions"

connection = duckdb.connect()
connection.execute(f"SET extension_directory = '{TARGET}'")
connection.execute("INSTALL httpfs")
connection.execute("LOAD httpfs")
print(f"httpfs installed into {TARGET}")
