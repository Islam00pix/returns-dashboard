"""Aggregates for the returns dashboard.

Money and return rules follow sql/control_returns.sql:
date and status come from prod.order_items, a missing price stays NULL,
and rates divide by all statuses. Seller is order_items.seller_id.
Level-1 category is resolved by walking categories.parent_id.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import date, datetime, time as clock, timedelta
from decimal import Decimal, ROUND_HALF_UP

from app.db import session

logger = logging.getLogger("returns_dashboard")

MIN_PRODUCT_POSITIONS = 20
RETURN_STATUSES = ("returned", "not_redeemed", "lost")

L1_ID_SQL = """
CASE
    WHEN leaf.level = 1 THEN leaf.category_id
    WHEN parent1.level = 1 THEN parent1.category_id
    WHEN parent2.level = 1 THEN parent2.category_id
    WHEN parent3.level = 1 THEN parent3.category_id
END
"""

L1_NAME_SQL = """
CASE
    WHEN leaf.level = 1 THEN leaf.name
    WHEN parent1.level = 1 THEN parent1.name
    WHEN parent2.level = 1 THEN parent2.name
    WHEN parent3.level = 1 THEN parent3.name
END
"""

INSERT_SQL = f"""
INSERT INTO filtered_items (
    order_item_id,
    seller_id,
    seller_name,
    product_id,
    product_name,
    l1_category_id,
    l1_category_name,
    qty,
    status,
    created_at,
    unit_price_after_discount,
    line_amount,
    is_return,
    price_missing
)
SELECT
    order_item_id,
    seller_id,
    seller_name,
    product_id,
    product_name,
    l1_category_id,
    l1_category_name,
    qty,
    status,
    created_at,
    unit_price_after_discount,
    line_amount,
    is_return,
    price_missing
FROM (
    SELECT
        oi.order_item_id,
        oi.seller_id,
        sel.seller_name,
        product.product_id,
        product.product_name,
        {L1_ID_SQL} AS l1_category_id,
        {L1_NAME_SQL} AS l1_category_name,
        oi.qty,
        oi.status,
        oi.created_at,
        CASE
            WHEN oi.price_at_purchase IS NULL THEN NULL
            ELSE oi.price_at_purchase - COALESCE(oi.discount_amount, 0)
        END AS unit_price_after_discount,
        CASE
            WHEN oi.price_at_purchase IS NULL THEN NULL
            ELSE oi.qty * (oi.price_at_purchase - COALESCE(oi.discount_amount, 0))
        END AS line_amount,
        oi.status IN ('returned', 'not_redeemed', 'lost') AS is_return,
        oi.price_at_purchase IS NULL AS price_missing
    FROM src.prod.order_items oi
    LEFT JOIN src.prod.sellers sel ON oi.seller_id = sel.seller_id
    LEFT JOIN src.prod.skus sku ON oi.sku_id = sku.sku_id
    LEFT JOIN src.prod.products product ON sku.product_id = product.product_id
    LEFT JOIN src.prod.categories leaf ON product.category_id = leaf.category_id
    LEFT JOIN src.prod.categories parent1 ON leaf.parent_id = parent1.category_id
    LEFT JOIN src.prod.categories parent2 ON parent1.parent_id = parent2.category_id
    LEFT JOIN src.prod.categories parent3 ON parent2.parent_id = parent3.category_id
    WHERE oi.created_at >= ?
      AND oi.created_at < ?
      AND (? = 1 OR oi.seller_id IN (SELECT UNNEST(?)))
) scoped
WHERE (? = 1 OR l1_category_id IN (SELECT UNNEST(?)))
"""

CREATE_SQL = """
CREATE TEMP TABLE filtered_items (
    order_item_id BIGINT,
    seller_id BIGINT,
    seller_name VARCHAR,
    product_id BIGINT,
    product_name VARCHAR,
    l1_category_id BIGINT,
    l1_category_name VARCHAR,
    qty BIGINT,
    status VARCHAR,
    created_at TIMESTAMP,
    unit_price_after_discount DOUBLE,
    line_amount DOUBLE,
    is_return BOOLEAN,
    price_missing BOOLEAN
)
"""

BASE_COUNT_SQL = """
SELECT COUNT(*)
FROM src.prod.order_items
WHERE created_at >= ?
  AND created_at < ?
  AND (? = 1 OR seller_id IN (SELECT UNNEST(?)))
"""

_cache_key: tuple | None = None
_cache_bundle: dict | None = None


class QueryError(RuntimeError):
    pass


@dataclass(frozen=True)
class Filters:
    date_from: date
    date_to: date
    category_ids: tuple[int, ...]
    seller_ids: tuple[int, ...]


def money_text(value: object) -> str | None:
    if value is None:
        return None
    quantized = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return f"{quantized:.2f}"


def known_amount(raw: object, matched_rows: int) -> str | None:
    if matched_rows == 0:
        return "0.00"
    if raw is None:
        return None
    return money_text(raw)


def percent_points(numerator: object, denominator: object) -> float | None:
    if numerator is None or denominator is None:
        return None
    den = Decimal(str(denominator))
    if den == 0:
        return None
    ratio = (Decimal(str(numerator)) / den).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    return float(ratio * Decimal("100"))


def money_rate(return_raw: object, return_rows: int, total_raw: object) -> float | None:
    if total_raw is None or Decimal(str(total_raw)) == 0:
        return None
    if return_rows > 0 and return_raw is None:
        return None
    return percent_points(0 if return_raw is None else return_raw, total_raw)


def _rows(con, sql: str, params: list | None = None) -> list[dict]:
    cursor = con.execute(sql, params or [])
    columns = [item[0] for item in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _one(con, sql: str, params: list | None = None) -> dict:
    rows = _rows(con, sql, params)
    if not rows:
        raise QueryError("Запрос не вернул строку.")
    return rows[0]


def _label(value: object, fallback: str) -> str:
    if value is None or str(value).strip() == "":
        return fallback
    return str(value)


def _period(filters: Filters) -> tuple[datetime, datetime]:
    start = datetime.combine(filters.date_from, clock.min)
    end = datetime.combine(filters.date_to + timedelta(days=1), clock.min)
    return start, end


def _insert_params(filters: Filters) -> list:
    start, end = _period(filters)
    sellers = list(filters.seller_ids)
    categories = list(filters.category_ids)
    return [
        start,
        end,
        1 if not sellers else 0,
        sellers or [-1],
        1 if not categories else 0,
        categories or [-1],
    ]


def _prepare(con, filters: Filters) -> None:
    con.execute("DROP TABLE IF EXISTS filtered_items")
    con.execute(CREATE_SQL)
    con.execute(INSERT_SQL, _insert_params(filters))
    counts = _one(
        con,
        """
        SELECT COUNT(*) AS n, COUNT(DISTINCT order_item_id) AS distinct_n
        FROM filtered_items
        """,
    )
    if counts["n"] != counts["distinct_n"]:
        raise QueryError("Соединения размножили позиции заказа. Расчёт остановлен.")
    if not filters.category_ids:
        start, end = _period(filters)
        sellers = list(filters.seller_ids)
        base = _one(
            con,
            BASE_COUNT_SQL,
            [start, end, 1 if not sellers else 0, sellers or [-1]],
        )
        if base["count_star()"] != counts["n"] and "count_star()" in base:
            raise QueryError("Соединения исключили позиции заказа. Расчёт остановлен.")
        base_count = next(iter(base.values()))
        if base_count != counts["n"]:
            raise QueryError("Соединения исключили позиции заказа. Расчёт остановлен.")


def _kpi(con) -> tuple[dict, bool]:
    row = _one(
        con,
        """
        SELECT
            COUNT(*) AS total_positions,
            SUM(qty) AS total_qty,
            SUM(line_amount) AS total_amount,
            COUNT(*) FILTER (WHERE is_return) AS return_positions,
            SUM(qty) FILTER (WHERE is_return) AS return_qty,
            SUM(line_amount) FILTER (WHERE is_return) AS return_amount,
            COUNT(*) FILTER (WHERE price_missing) AS missing_price_positions
        FROM filtered_items
        """,
    )
    total_positions = int(row["total_positions"] or 0)
    missing = int(row["missing_price_positions"] or 0)
    if total_positions == 0:
        return {
            "return_amount": None,
            "return_rate_money_pct": None,
            "return_positions": None,
            "return_rate_qty_pct": None,
            "total_positions": 0,
            "total_qty": 0,
            "total_amount": None,
            "missing_price_positions": 0,
        }, True

    return_positions = int(row["return_positions"] or 0)
    return {
        "return_amount": known_amount(row["return_amount"], return_positions),
        "return_rate_money_pct": money_rate(
            row["return_amount"], return_positions, row["total_amount"]
        ),
        "return_positions": return_positions,
        "return_rate_qty_pct": percent_points(row["return_qty"], row["total_qty"]),
        "total_positions": total_positions,
        "total_qty": int(row["total_qty"] or 0),
        "total_amount": money_text(row["total_amount"]),
        "missing_price_positions": missing,
    }, False


def _monthly(con) -> list[dict]:
    rows = _rows(
        con,
        """
        SELECT
            strftime(created_at, '%Y-%m') AS month,
            SUM(line_amount) AS total_amount,
            SUM(line_amount) FILTER (WHERE is_return) AS return_amount,
            COUNT(*) FILTER (WHERE is_return) AS return_rows,
            SUM(line_amount) FILTER (WHERE status = 'returned') AS returned_amount,
            COUNT(*) FILTER (WHERE status = 'returned') AS returned_rows,
            SUM(line_amount) FILTER (WHERE status = 'not_redeemed') AS not_redeemed_amount,
            COUNT(*) FILTER (WHERE status = 'not_redeemed') AS not_redeemed_rows,
            SUM(line_amount) FILTER (WHERE status = 'lost') AS lost_amount,
            COUNT(*) FILTER (WHERE status = 'lost') AS lost_rows
        FROM filtered_items
        GROUP BY 1
        ORDER BY 1
        """,
    )
    result = []
    for row in rows:
        return_rows = int(row["return_rows"] or 0)
        result.append(
            {
                "month": row["month"],
                "return_amount": known_amount(row["return_amount"], return_rows),
                "return_rate_money_pct": money_rate(
                    row["return_amount"], return_rows, row["total_amount"]
                ),
                "returned_amount": known_amount(row["returned_amount"], int(row["returned_rows"] or 0)),
                "not_redeemed_amount": known_amount(
                    row["not_redeemed_amount"], int(row["not_redeemed_rows"] or 0)
                ),
                "lost_amount": known_amount(row["lost_amount"], int(row["lost_rows"] or 0)),
            }
        )
    return result


def _categories(con) -> list[dict]:
    rows = _rows(
        con,
        """
        SELECT
            l1_category_id AS category_id,
            MIN(l1_category_name) AS category_name,
            SUM(line_amount) AS total_amount,
            SUM(line_amount) FILTER (WHERE is_return) AS return_amount,
            COUNT(*) FILTER (WHERE is_return) AS return_rows,
            COUNT(*) AS total_positions
        FROM filtered_items
        GROUP BY l1_category_id
        """,
    )
    result = []
    for row in rows:
        return_rows = int(row["return_rows"] or 0)
        result.append(
            {
                "category_id": None if row["category_id"] is None else int(row["category_id"]),
                "category_name": _label(row["category_name"], "Без категории"),
                "return_amount": known_amount(row["return_amount"], return_rows),
                "return_rate_money_pct": money_rate(
                    row["return_amount"], return_rows, row["total_amount"]
                ),
                "total_positions": int(row["total_positions"] or 0),
            }
        )
    result.sort(
        key=lambda item: (
            item["return_rate_money_pct"] is None,
            -(item["return_rate_money_pct"] or 0),
            item["category_name"],
        )
    )
    return result


def _price_groups(con) -> list[dict]:
    rows = _rows(
        con,
        """
        WITH classified AS (
            SELECT
                CASE
                    WHEN unit_price_after_discount IS NULL THEN 'missing'
                    WHEN unit_price_after_discount < 0 THEN 'invalid'
                    WHEN unit_price_after_discount < 1000 THEN 'under_1000'
                    WHEN unit_price_after_discount < 5000 THEN '1000_4999'
                    WHEN unit_price_after_discount < 15000 THEN '5000_14999'
                    ELSE '15000_plus'
                END AS group_key,
                is_return,
                line_amount
            FROM filtered_items
        ),
        aggregated AS (
            SELECT
                group_key,
                COUNT(*) AS total_positions,
                COUNT(*) FILTER (WHERE is_return) AS return_positions,
                SUM(line_amount) FILTER (WHERE is_return) AS return_amount
            FROM classified
            GROUP BY group_key
        )
        SELECT
            groups.group_key,
            groups.group_name,
            groups.sort_order,
            COALESCE(aggregated.total_positions, 0) AS total_positions,
            COALESCE(aggregated.return_positions, 0) AS return_positions,
            aggregated.return_amount
        FROM (
            VALUES
                ('invalid', 'Некорректная цена', 0),
                ('under_1000', 'До 1 000 ₽', 1),
                ('1000_4999', '1 000–4 999 ₽', 2),
                ('5000_14999', '5 000–14 999 ₽', 3),
                ('15000_plus', 'От 15 000 ₽', 4),
                ('missing', 'Цена не указана', 5)
        ) AS groups(group_key, group_name, sort_order)
        LEFT JOIN aggregated USING (group_key)
        WHERE groups.group_key <> 'invalid'
           OR COALESCE(aggregated.total_positions, 0) > 0
        ORDER BY groups.sort_order
        """,
    )
    result = []
    for row in rows:
        total_positions = int(row["total_positions"] or 0)
        return_positions = int(row["return_positions"] or 0)
        result.append(
            {
                "group_key": row["group_key"],
                "group_name": row["group_name"],
                "total_positions": total_positions,
                "return_positions": return_positions,
                "return_rate_positions_pct": percent_points(return_positions, total_positions),
                "return_amount": None
                if row["group_key"] == "missing"
                else known_amount(row["return_amount"], return_positions),
            }
        )
    return result


def _validate_price_groups(kpi: dict, groups: list[dict]) -> None:
    if sum(item["total_positions"] for item in groups) != kpi["total_positions"]:
        raise QueryError("Ценовые группы не покрывают все позиции выбранного среза.")
    if sum(item["return_positions"] for item in groups) != kpi["return_positions"]:
        raise QueryError("Возвратные позиции не сходятся по ценовым группам.")
    if kpi["return_amount"] is None:
        return
    grouped_amount = sum(
        (Decimal(item["return_amount"]) for item in groups if item["return_amount"] is not None),
        Decimal("0"),
    )
    if abs(grouped_amount - Decimal(kpi["return_amount"])) > Decimal("0.01"):
        raise QueryError("Сумма возвратов не сходится по ценовым группам.")


def _sellers(con) -> list[dict]:
    rows = _rows(
        con,
        """
        SELECT
            seller_id,
            MIN(seller_name) AS seller_name,
            COUNT(*) AS total_positions,
            COUNT(*) FILTER (WHERE is_return) AS return_positions,
            SUM(line_amount) AS total_amount,
            SUM(line_amount) FILTER (WHERE is_return) AS return_amount
        FROM filtered_items
        GROUP BY seller_id
        ORDER BY
            CASE
                WHEN COUNT(*) FILTER (WHERE is_return) = 0 THEN 0
                ELSE SUM(line_amount) FILTER (WHERE is_return)
            END DESC NULLS LAST,
            seller_id
        """,
    )
    result = []
    for row in rows:
        return_positions = int(row["return_positions"] or 0)
        result.append(
            {
                "seller_id": None if row["seller_id"] is None else int(row["seller_id"]),
                "seller_name": _label(row["seller_name"], "Без названия"),
                "return_amount": known_amount(row["return_amount"], return_positions),
                "return_rate_money_pct": money_rate(
                    row["return_amount"], return_positions, row["total_amount"]
                ),
                "return_positions": return_positions,
                "total_positions": int(row["total_positions"] or 0),
            }
        )
    return result


def _products(con) -> list[dict]:
    rows = _rows(
        con,
        """
        SELECT
            product_id,
            seller_id,
            MIN(product_name) AS product_name,
            MIN(seller_name) AS seller_name,
            MIN(l1_category_id) AS category_id,
            MIN(l1_category_name) AS category_name,
            COUNT(*) AS total_positions,
            COUNT(*) FILTER (WHERE is_return) AS return_positions,
            SUM(line_amount) FILTER (WHERE is_return) AS return_amount
        FROM filtered_items
        GROUP BY product_id, seller_id
        HAVING COUNT(*) >= ?
        ORDER BY
            COUNT(*) FILTER (WHERE is_return) * 1.0 / NULLIF(COUNT(*), 0) DESC,
            CASE
                WHEN COUNT(*) FILTER (WHERE is_return) = 0 THEN 0
                ELSE SUM(line_amount) FILTER (WHERE is_return)
            END DESC NULLS LAST,
            product_id,
            seller_id
        """,
        [MIN_PRODUCT_POSITIONS],
    )
    result = []
    for row in rows:
        total_positions = int(row["total_positions"] or 0)
        return_positions = int(row["return_positions"] or 0)
        result.append(
            {
                "product_id": None if row["product_id"] is None else int(row["product_id"]),
                "product_name": _label(row["product_name"], "Без названия"),
                "category_id": None if row["category_id"] is None else int(row["category_id"]),
                "category_name": _label(row["category_name"], "Без категории"),
                "seller_id": None if row["seller_id"] is None else int(row["seller_id"]),
                "seller_name": _label(row["seller_name"], "Без названия"),
                "total_positions": total_positions,
                "return_positions": return_positions,
                "return_rate_positions_pct": percent_points(return_positions, total_positions),
                "return_amount": known_amount(row["return_amount"], return_positions),
            }
        )
    return result


def load_bundle(filters: Filters) -> dict:
    global _cache_key, _cache_bundle
    key = (filters.date_from, filters.date_to, filters.category_ids, filters.seller_ids)
    started = time.perf_counter()
    with session() as con:
        if _cache_key == key and _cache_bundle is not None:
            return _cache_bundle
        try:
            _prepare(con, filters)
            kpi, empty = _kpi(con)
            price_groups = [] if empty else _price_groups(con)
            if not empty:
                _validate_price_groups(kpi, price_groups)
            bundle = {
                "empty": empty,
                "kpi": kpi,
                "monthly": [] if empty else _monthly(con),
                "categories": [] if empty else _categories(con),
                "price_groups": price_groups,
                "sellers": [] if empty else _sellers(con),
                "products": [] if empty else _products(con),
            }
        finally:
            con.execute("DROP TABLE IF EXISTS filtered_items")
        _cache_key = key
        _cache_bundle = bundle
    logger.info(
        "aggregate %s..%s categories=%s sellers=%s positions=%s seconds=%.2f",
        filters.date_from.isoformat(),
        filters.date_to.isoformat(),
        len(filters.category_ids),
        len(filters.seller_ids),
        bundle["kpi"]["total_positions"],
        time.perf_counter() - started,
    )
    return bundle


def filter_options() -> dict:
    with session() as con:
        categories = _rows(
            con,
            """
            SELECT category_id, name
            FROM src.prod.categories
            WHERE level = 1
            ORDER BY name, category_id
            """,
        )
        sellers = _rows(
            con,
            """
            SELECT sel.seller_id, sel.seller_name
            FROM src.prod.sellers sel
            WHERE EXISTS (
                SELECT 1
                FROM src.prod.order_items oi
                WHERE oi.seller_id = sel.seller_id
            )
            ORDER BY sel.seller_name, sel.seller_id
            """,
        )
        bounds = _one(
            con,
            """
            SELECT
                MIN(created_at)::DATE AS date_min,
                MAX(created_at)::DATE AS date_max
            FROM src.prod.order_items
            """,
        )
    return {
        "categories": [
            {"id": int(row["category_id"]), "name": _label(row["name"], "Без категории")}
            for row in categories
        ],
        "sellers": [
            {"id": int(row["seller_id"]), "name": _label(row["seller_name"], "Без названия")}
            for row in sellers
        ],
        "date_min": bounds["date_min"].isoformat(),
        "date_max": bounds["date_max"].isoformat(),
    }


def page_view(rows: list[dict], page: int, page_size: int) -> dict:
    total = len(rows)
    pages = max(1, (total + page_size - 1) // page_size) if total else 1
    current = min(page, pages) if total else 1
    start = (current - 1) * page_size
    return {
        "page": current,
        "page_size": page_size,
        "total": total,
        "pages": pages if total else 1,
        "rows": rows[start : start + page_size] if total else [],
    }
