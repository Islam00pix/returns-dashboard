"""Read-only access to the local DuckDB file.

The source file is attached with READ_ONLY. Aggregates use an in-memory
temporary table and never write back to the database.
"""

from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from pathlib import Path

import duckdb
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
_lock = threading.Lock()
_con: duckdb.DuckDBPyConnection | None = None


class DatabaseError(RuntimeError):
    pass


def _read_only_requested() -> bool:
    return os.environ.get("DUCKDB_READ_ONLY", "true").strip().lower() in {"1", "true", "yes"}


def connect() -> duckdb.DuckDBPyConnection:
    global _con
    if _con is not None:
        return _con

    load_dotenv(ROOT / ".env")
    if not _read_only_requested():
        raise DatabaseError("Подключение отклонено: нужен режим только чтения.")

    db_path = os.environ.get("DUCKDB_PATH", "").strip().strip('"')
    if not db_path or not Path(db_path).is_file():
        raise DatabaseError("Файл базы не найден. Проверьте DUCKDB_PATH в .env.")

    con = duckdb.connect(":memory:")
    con.execute("ATTACH ? AS src (READ_ONLY)", [db_path])
    readonly = con.execute(
        "SELECT readonly FROM duckdb_databases() WHERE database_name = 'src'"
    ).fetchone()
    if readonly is None or readonly[0] is not True:
        con.close()
        raise DatabaseError("База не открыта в режиме только чтения.")
    _con = con
    return con


@contextmanager
def session():
    con = connect()
    with _lock:
        yield con


def close() -> None:
    global _con
    with _lock:
        if _con is not None:
            _con.close()
            _con = None
