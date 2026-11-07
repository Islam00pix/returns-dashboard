-- Control totals for prod.order_items.
-- Date and status come from this table.
-- Missing price_at_purchase stays NULL and is not replaced with a placeholder price.
-- discount_amount NULL is treated as 0, per the control rule.
-- Return statuses: returned, not_redeemed, lost.
-- Rates use all statuses in the denominator.

WITH scoped AS (
    SELECT
        qty,
        status,
        price_at_purchase,
        CASE
            WHEN price_at_purchase IS NULL THEN NULL
            ELSE qty * (price_at_purchase - COALESCE(discount_amount, 0))
        END AS line_amount,
        status IN ('returned', 'not_redeemed', 'lost') AS is_return
    FROM prod.order_items
    WHERE created_at >= DATE '2024-01-01'
      AND created_at < DATE '2025-07-01'
)
SELECT
    COUNT(*) AS total_positions,
    SUM(qty) AS total_qty,
    SUM(line_amount) AS total_amount,
    COUNT(*) FILTER (WHERE is_return) AS return_positions,
    SUM(qty) FILTER (WHERE is_return) AS return_qty,
    SUM(line_amount) FILTER (WHERE is_return) AS return_amount,
    SUM(line_amount) FILTER (WHERE is_return)
        / NULLIF(SUM(line_amount), 0) AS return_rate_money,
    SUM(qty) FILTER (WHERE is_return)
        / NULLIF(SUM(qty), 0) AS return_rate_qty,
    COUNT(*) FILTER (WHERE price_at_purchase IS NULL) AS missing_price_positions
FROM scoped;
