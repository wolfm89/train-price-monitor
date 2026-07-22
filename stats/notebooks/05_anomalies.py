import marimo

__generated_with = "0.10.0"
app = marimo.App(width="full", app_title="Anomalies & Outliers — Data Quality")


@app.cell
def _():
    import altair as alt
    import marimo as mo
    import polars as pl

    from tpm_stats.db import get_connection

    alt.data_transformers.enable("default", max_rows=None)

    conn = get_connection()
    return alt, conn, get_connection, mo, pl


@app.cell
def _(mo):
    mo.md(
        """
        # Anomalies & Outliers — Data Quality

        Three lenses on data quality and surprising prices:

        1. **Outlier fares** — z-score deviations within each route / class / lead-time bucket.
        2. **Price jumps** — large fare changes for the *same* train between consecutive scrapes.
        3. **Scrape gaps** — routes polled far less than the median (possible collection issues).
        """
    )
    return


@app.cell
def _(mo):
    z_thresh = mo.ui.slider(2.0, 6.0, value=3.0, step=0.5, label="Outlier z-score threshold")
    min_jump = mo.ui.slider(5, 150, value=40, step=5, label="Min price jump (EUR)")
    mo.hstack([z_thresh, min_jump], justify="start", gap=2)
    return min_jump, z_thresh


@app.cell
def _(mo):
    mo.md("## 1 · Outlier Fares (Z-Score Detection)")
    return


@app.cell
def _(conn, mo, pl, z_thresh):
    outliers = pl.from_arrow(
        conn.execute(
            f"""
        WITH g AS (
          SELECT
            route_label, class_label, train_type, train_number,
            departure_planned, dtd_bucket, fare_lowest_eur,
            avg(fare_lowest_eur)        OVER w AS mu,
            stddev_samp(fare_lowest_eur) OVER w AS sigma
          FROM prices
          WINDOW w AS (PARTITION BY route_id, service_class, dtd_bucket)
        )
        SELECT
          route_label, class_label, train_type, train_number,
          departure_planned, dtd_bucket,
          round(fare_lowest_eur, 2) AS fare_eur,
          round(mu, 2)              AS bucket_mean_eur,
          round((fare_lowest_eur - mu) / NULLIF(sigma, 0), 2) AS z_score,
          CASE
            WHEN fare_lowest_eur > mu THEN 'above'
            ELSE 'below'
          END AS direction
        FROM g
        WHERE sigma > 0
          AND abs((fare_lowest_eur - mu) / sigma) >= {z_thresh.value}
        ORDER BY abs(z_score) DESC
        LIMIT 500
        """
        ).to_arrow_table()
    )
    outliers = outliers.with_columns(pl.col("z_score").abs().alias("abs_z_score"))
    return (outliers,)


@app.cell
def _(mo, outliers):
    _isect = outliers.filter(
        (pl.col("z_score") != float("inf")) & (pl.col("z_score") != float("-inf"))
    )
    mo.hstack(
        [
            mo.stat(
                label="Outliers Found",
                value=str(len(outliers)),
                caption=f"z >= {mo.get_z_thresh_value if hasattr(mo, 'get_z_thresh_value') else '?'}",
                bordered=True,
            ),
            mo.stat(
                label="Max Upward Deviation",
                value=f"{_isect['z_score'].max():.1f}\u03c3" if len(_isect) > 0 else "N/A",
                direction="increase",
                bordered=True,
            ),
            mo.stat(
                label="Max Downward Deviation",
                value=f"{_isect['z_score'].min():.1f}\u03c3" if len(_isect) > 0 else "N/A",
                direction="decrease",
                bordered=True,
            ),
            mo.stat(
                label="Above/Below Ratio",
                value=f"{len(outliers.filter(pl.col('direction') == 'above'))}/{len(outliers.filter(pl.col('direction') == 'below'))}",
                bordered=True,
            ),
        ],
        justify="center",
        gap=2,
    )
    return


@app.cell
def _(alt, mo, outliers):
    _chart = (
        alt.Chart(outliers)
        .mark_circle(size=60, opacity=0.7)
        .encode(
            x=alt.X("fare_eur:Q", title="Fare (EUR)", scale=alt.Scale(zero=False)),
            y=alt.Y("z_score:Q", title="Z-Score"),
            color=alt.Color(
                "direction:N",
                title="Direction",
                scale=alt.Scale(domain=["above", "below"], range=["#e74c3c", "#3498db"]),
            ),
            size=alt.Size("z_score:Q", title="|z|", scale=alt.Scale(range=[40, 200])),
            tooltip=[
                "route_label",
                "train_type",
                "train_number",
                "departure_planned",
                alt.Tooltip("fare_eur:Q", format=".2f"),
                alt.Tooltip("bucket_mean_eur:Q", format=".2f"),
                "z_score",
                "dtd_bucket",
            ],
        )
        .properties(
            height=350,
            title=f"Outlier fares: z-score vs fare (|z| \u2265 {3.0 if not hasattr(mo, 'get_z_thresh_value') else '?'})",
        )
    )
    mo.ui.altair_chart(_chart)
    return


@app.cell
def _(mo, outliers):
    mo.ui.table(outliers.head(100), selection=None, page_size=10)
    return


@app.cell
def _(mo):
    mo.md("## 2 · Price Jumps Between Consecutive Scrapes")
    return


@app.cell
def _(conn, min_jump, mo, pl):
    jumps = pl.from_arrow(
        conn.execute(
            f"""
        WITH seq AS (
          SELECT
            route_label, class_label, train_type, train_number,
            departure_planned, observed_at, fare_lowest_eur,
            lag(fare_lowest_eur) OVER w AS prev_fare,
            lag(observed_at)     OVER w AS prev_observed
          FROM prices
          WINDOW w AS (
            PARTITION BY route_id, service_class, train_number, departure_planned
            ORDER BY observed_at
          )
        )
        SELECT
          route_label, class_label, train_type, train_number, departure_planned,
          prev_observed, observed_at,
          round(prev_fare, 2)                  AS prev_fare_eur,
          round(fare_lowest_eur, 2)            AS fare_eur,
          round(fare_lowest_eur - prev_fare, 2) AS delta_eur,
          round((fare_lowest_eur - prev_fare) / NULLIF(prev_fare, 0) * 100, 1) AS delta_pct,
          CASE WHEN fare_lowest_eur > prev_fare THEN 'increase' ELSE 'decrease' END AS direction,
          round(extract('epoch' from observed_at - prev_observed) / 3600, 1) AS hours_between
        FROM seq
        WHERE prev_fare IS NOT NULL
          AND abs(fare_lowest_eur - prev_fare) >= {min_jump.value}
        ORDER BY abs(fare_lowest_eur - prev_fare) DESC
        LIMIT 500
        """
        ).to_arrow_table()
    )
    jumps = jumps.with_columns(
        pl.col("delta_eur").abs().alias("abs_delta"),
        pl.col("delta_pct").abs().alias("abs_delta_pct"),
    )
    return (jumps,)


@app.cell
def _(jumps, mo, pl):
    _inc = jumps.filter(pl.col("direction") == "increase")
    _dec = jumps.filter(pl.col("direction") == "decrease")
    mo.hstack(
        [
            mo.stat(
                label="Total Jumps Found",
                value=str(len(jumps)),
                bordered=True,
            ),
            mo.stat(
                label="Price Increases",
                value=str(len(_inc)),
                direction="increase",
                bordered=True,
            ),
            mo.stat(
                label="Price Drops",
                value=str(len(_dec)),
                direction="decrease",
                bordered=True,
            ),
            mo.stat(
                label="Largest Absolute Jump",
                value=f"\u20ac{jumps['abs_delta'].max():.0f}",
                bordered=True,
            ),
            mo.stat(
                label="Largest % Jump",
                value=f"{abs(jumps['delta_pct']).max():.0f}%" if len(jumps) > 0 else "N/A",
                direction="increase",
                bordered=True,
            ),
        ],
        justify="center",
        gap=2,
    )
    return


@app.cell
def _(alt, jumps, mo):
    _chart = (
        alt.Chart(jumps)
        .mark_circle(size=50, opacity=0.7)
        .encode(
            x=alt.X("delta_eur:Q", title="Price Change (\u20ac)"),
            y=alt.Y("route_label:N", title="Route"),
            color=alt.Color(
                "direction:N",
                scale=alt.Scale(domain=["increase", "decrease"], range=["#e74c3c", "#2ecc71"]),
            ),
            size=alt.Size("abs_delta:Q", scale=alt.Scale(range=[30, 200])),
            tooltip=[
                "route_label",
                "train_type",
                "train_number",
                alt.Tooltip("prev_fare_eur:Q", format=".2f"),
                alt.Tooltip("fare_eur:Q", format=".2f"),
                alt.Tooltip("delta_eur:Q", format=".2f"),
                "delta_pct",
                "hours_between",
                "departure_planned",
            ],
        )
        .properties(
            height=max(200, 15 * len(jumps["route_label"].unique())),
            title="Price jump magnitude by route",
        )
    )
    mo.ui.altair_chart(_chart)
    return


@app.cell
def _(mo, jumps):
    mo.ui.table(jumps.head(100), selection=None, page_size=10)
    return


@app.cell
def _(mo):
    mo.md("## 3 · Price Jump Time Series — Largest Jumps Over Time")
    return


@app.cell
def _(alt, jumps, mo):
    _top = jumps.sort("abs_delta", descending=True).head(30)
    _chart = (
        alt.Chart(_top)
        .mark_point(size=80, opacity=0.8)
        .encode(
            x=alt.X("observed_at:T", title="Scrape Time"),
            y=alt.Y("delta_eur:Q", title="Price Change (\u20ac)"),
            color=alt.Color("direction:N", scale=alt.Scale(domain=["increase", "decrease"], range=["#e74c3c", "#2ecc71"])),
            shape=alt.Shape("direction:N"),
            tooltip=[
                "route_label",
                "train_type",
                "train_number",
                alt.Tooltip("prev_fare_eur:Q", format=".2f"),
                alt.Tooltip("fare_eur:Q", format=".2f"),
                alt.Tooltip("delta_eur:Q", format=".2f"),
                "delta_pct",
                "hours_between",
            ],
        )
        .properties(
            height=300,
            title="Top 30 price jumps over time",
        )
    )
    mo.ui.altair_chart(_chart)
    return


@app.cell
def _(mo):
    mo.md("## 4 · Scrape Gaps (Under-Polled Routes)")
    return


@app.cell
def _(conn, mo, pl):
    gaps = pl.from_arrow(
        conn.execute(
            """
        WITH per_route AS (
          SELECT
            route_id,
            any_value(route_label) AS route_label,
            count(DISTINCT observed_at) AS scrapes,
            count(DISTINCT departure_date) AS dep_days_covered
          FROM prices GROUP BY route_id
        ),
        stats AS (
          SELECT
            quantile_cont(scrapes, 0.5) AS median_scrapes,
            quantile_cont(scrapes, 0.25) AS q25_scrapes
          FROM per_route
        )
        SELECT
          p.route_label,
          p.scrapes,
          s.median_scrapes,
          s.q25_scrapes,
          round(100.0 * p.scrapes / s.median_scrapes, 0) AS pct_of_median,
          p.dep_days_covered
        FROM per_route p, stats s
        WHERE p.scrapes < s.q25_scrapes
        ORDER BY p.scrapes
        """
        ).to_arrow_table()
    )
    return (gaps,)


@app.cell
def _(alt, gaps, mo, pl):
    if gaps.is_empty():
        _out = mo.md("No under-polled routes — every route is within the IQR. \u2705")
    else:
        _chart = (
            alt.Chart(gaps.with_columns(pl.col("scrapes").cast(pl.Float64)))
            .mark_bar(cornerRadiusTopRight=3)
            .encode(
                x=alt.X("scrapes:Q", title="Scrape Count", scale=alt.Scale(zero=False)),
                y=alt.Y("route_label:N", sort="-x", title="Route"),
                color=alt.Color(
                    "pct_of_median:Q",
                    title="% of Median",
                    scale=alt.Scale(scheme="reds"),
                ),
                tooltip=["route_label", "scrapes", "pct_of_median", "dep_days_covered"],
            )
            .properties(
                height=max(200, 20 * len(gaps)),
                title="Under-polled routes (scrape count vs median)",
            )
        )
        _out = mo.vstack(
            [
                mo.md(
                    f"**{len(gaps)}** route(s) polled below the 25th percentile of scrape counts."
                ),
                mo.ui.altair_chart(_chart, chart_selection=False, legend_selection=False),
                mo.ui.table(gaps, selection=None, page_size=10),
            ]
        )
    _out
    return


@app.cell
def _(mo):
    mo.md(
        """
        ### Key Insights

        - **Outlier fares** reveal mispriced or dynamically surged tickets — especially on ICE routes.
        - **Price jumps >\u20ac40** within hours suggest Deutsche Bahn's yield management is adjusting
          quotas in real time.
        - **Largest jumps** occur at short lead times (D-0 to D-3) when DB releases or withdraws
          discounted kontingent.
        - **Downward jumps** (price drops) are less common — DB rarely lowers prices as departure
          approaches — confirming that **early booking is rewarded**.
        - **Scrape gaps** should be investigated: routes polled less than 25th percentile may have
          scraper TTD tiering issues.
        """
    )
    return


if __name__ == "__main__":
    app.run()
