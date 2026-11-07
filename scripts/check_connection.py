"""Read-only connection check and control-total comparison."""

from __future__ import annotations

import os
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

import duckdb
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
SQL_FILE = ROOT / "sql" / "control_returns.sql"

EXPECTED = {
    "total_positions": 731_479,
    "total_qty": 1_135_291,
    "total_amount": Decimal("4938031436.30"),
    "return_positions": 98_894,
    "return_qty": 152_683,
    "return_amount": Decimal("589413166.73"),
    "return_rate_money": Decimal("0.1194"),
    "return_rate_qty": Decimal("0.1345"),
    "missing_price_positions": 18_338,
}

COUNT_KEYS = (
    "total_positions",
    "total_qty",
    "return_positions",
    "return_qty",
    "missing_price_positions",
)
AMOUNT_KEYS = ("total_amount", "return_amount")
RATE_KEYS = ("return_rate_money", "return_rate_qty")


def as_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def rate(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


def matches(key: str, actual: object) -> tuple[str, bool]:
    expected = EXPECTED[key]
    if key in COUNT_KEYS:
        got = int(actual)
        return str(got), got == int(expected)
    number = as_decimal(actual)
    if number is None:
        return "NULL", False
    if key in AMOUNT_KEYS:
        got = money(number)
        return f"{got:.2f}", got == expected
    got = rate(number)
    return f"{got * 100:.2f}%", got == expected


def main() -> int:
    load_dotenv(ROOT / ".env")
    db_path = os.environ.get("DUCKDB_PATH", "").strip().strip('"')
    read_only_flag = os.environ.get("DUCKDB_READ_ONLY", "true").strip().lower()
    if read_only_flag not in {"1", "true", "yes"}:
        print("Подключение отклонено: нужен режим только чтения.")
        return 2
    if not db_path or not Path(db_path).is_file():
        print("Файл базы не найден. Проверьте DUCKDB_PATH в .env.")
        return 2

    sql = SQL_FILE.read_text(encoding="utf-8")
    con = duckdb.connect(db_path, read_only=True)
    try:
        mode = con.execute("SELECT current_setting('access_mode')").fetchone()[0]
        probe = con.execute("SELECT 1").fetchone()[0]
        row = con.execute(sql).fetchone()
        columns = [item[0] for item in con.description]
    finally:
        con.close()

    if probe != 1:
        print("Проверка SELECT 1 не прошла.")
        return 1

    actual = dict(zip(columns, row))
    print(f"access_mode={mode}")
    print(f"database={Path(db_path).name}")
    print(f"{'metric':<28}{'actual':>22}{'expected':>22}  ok")
    failed = False
    for key in EXPECTED:
        shown, ok = matches(key, actual.get(key))
        expected = EXPECTED[key]
        if key in RATE_KEYS:
            expected_shown = f"{Decimal(expected) * 100:.2f}%"
        elif key in AMOUNT_KEYS:
            expected_shown = f"{expected:.2f}"
        else:
            expected_shown = str(int(expected))
        mark = "yes" if ok else "NO"
        failed = failed or not ok
        print(f"{key:<28}{shown:>22}{expected_shown:>22}  {mark}")

    if failed:
        print("Контрольные значения не сошлись.")
        return 1
    print("Контрольные значения сошлись.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
