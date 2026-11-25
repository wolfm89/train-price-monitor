"""The next-day fare label shared by the SQL panel and the numpy model path.

A fare and a price are compared as integer cents, so the label is identical in DuckDB and in the
Python recomputation and a value exactly on the limit counts as reached:

``check_cents * 100 >= price_cents * (100 + headroom)``.

The SQL helpers return expressions; ``breach`` is the numpy equivalent. Keep the two in one module:
the dataset builder, the per-headroom recomputation and the tests all import this definition.
"""

from typing import Any

import numpy as np

NEXT_DAY_ESTIMAND = "next_day_fare"


def price_cents_sql(column: str) -> str:
    """Return an exact integer-cent expression for a euro fare column."""
    return f"CAST(round({column} * 100) AS BIGINT)"


def breach_sql(check_cents: str, price_cents: str, headroom: str) -> str:
    """Return the shared integer-cent breach predicate as a SQL expression."""
    return (
        f"({check_cents} IS NOT NULL AND {price_cents} IS NOT NULL "
        f"AND {check_cents} * 100 >= {price_cents} * (100 + {headroom}))"
    )


def breach(price_cents: Any, check_cents: Any, headroom: Any) -> np.ndarray:
    """Return the shared integer-cent breach label as int8, or -1 where a side is missing."""
    price = np.asarray(price_cents, dtype=np.int64)
    check = np.asarray(check_cents, dtype=np.int64)
    headroom_array = np.asarray(headroom, dtype=np.int64)
    missing = (price < 0) | (check < 0)
    numerator = check * 100
    denominator = price * (100 + headroom_array)
    labelled = np.where(missing, -1, np.where(numerator >= denominator, 1, 0))
    return labelled.astype(np.int8)


def cents(values: Any) -> np.ndarray:
    """Convert euro values to integer cents; missing values become ``-1`` for ``breach``."""
    array = np.asarray(values, dtype=np.float64)
    result = np.full(array.shape, -1, dtype=np.int64)
    present = np.isfinite(array)
    result[present] = np.rint(array[present] * 100.0).astype(np.int64)
    return result
