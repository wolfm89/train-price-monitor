import marimo

__generated_with = "0.10.0"
app = marimo.App(width="full", app_title="Scraper Data — Overview")


@app.cell
def _():
    import altair as alt
    import marimo as mo
    import polars as pl

    from tpm_stats.db import available_files, get_connection

    alt.data_transformers.enable("default", max_rows=None)

    conn = get_connection()
    return alt, available_files, conn, get_connection, mo, pl


@app.cell
def _(available_files, mo):
    mo.md(
        f"""
        # Train Price Monitor — Data Overview

        Comprehensive profiling of the locally-synced scraper data. Interactive
        exploration of coverage, completeness, distributions, and scrape health.

        **Files loaded:** {len(available_files())} &nbsp;·&nbsp; `daily_*.parquet`
        """
    )
    return


@app.cell
def _(conn, mo, pl):
    cov = pl.from_arrow(
        conn.execute(
            """
        SELECT
          count(*)                                          AS rows,
          count(DISTINCT route_id)                          AS routes,
          count(DISTINCT departure_date)                    AS departure_days,
          count(DISTINCT observed_at)                       AS scrape_timestamps,
          min(observed_at)::date                            AS first_observed,
          max(observed_at)::date                            AS last_observed,
          min(departure_planned)::date                      AS first_departure,
          max(departure_planned)::date                      AS last_departure,
          round(min(days_to_departure), 1)                  AS min_dtd,
          round(max(days_to_departure), 1)                  AS max_dtd,
          round(avg(duration_minutes), 1)                   AS avg_duration_min,
          round(avg(fare_lowest_eur), 2)                    AS avg_fare_eur,
          round(median(fare_lowest_eur), 2)                 AS median_fare_eur
        FROM prices
        """
        ).to_arrow_table()
    )
    return (cov,)


@app.cell
def _(cov, mo):
    r = cov.row(0, named=True)
    rows_fmt = f"{r['rows']:,.0f}"
    routes_fmt = f"{r['routes']:,d}"
    depdays_fmt = f"{r['departure_days']:,d}"
    scrape_fmt = f"{r['scrape_timestamps']:,.0f}"
    avg_fare_fmt = f"\u20ac{r['avg_fare_eur']:.2f}"
    med_fare_fmt = f"\u20ac{r['median_fare_eur']:.2f}"
    avg_dur_fmt = f"{r['avg_duration_min']:.0f} min"

    mo.hstack(
        [
            mo.stat(label="Total Observations", value=rows_fmt, bordered=True),
            mo.stat(label="Routes Tracked", value=routes_fmt, bordered=True),
            mo.stat(label="Departure Days", value=depdays_fmt, bordered=True),
            mo.stat(label="Scrape Timestamps", value=scrape_fmt, bordered=True),
            mo.stat(label="Average Fare", value=avg_fare_fmt, bordered=True),
            mo.stat(label="Median Fare", value=med_fare_fmt, bordered=True),
            mo.stat(label="Avg Duration", value=avg_dur_fmt, bordered=True),
        ],
        justify="center",
        gap=1,
    )
    return (
        avg_dur_fmt,
        avg_fare_fmt,
        depdays_fmt,
        med_fare_fmt,
        r,
        rows_fmt,
        routes_fmt,
        scrape_fmt,
    )


@app.cell
def _(mo):
    mo.md("## Coverage Calendar")
    return


@app.cell
def _(conn, mo, pl):
    coverage_cal = pl.from_arrow(
        conn.execute(
            """
        SELECT
          departure_date::date                AS date,
          count(DISTINCT route_id)            AS routes_covered,
          count(*)                            AS obs,
          avg(fare_lowest_eur)                AS avg_fare,
          count(DISTINCT observed_at)         AS scrapes_that_day
        FROM prices
        GROUP BY departure_date
        ORDER BY date
        """
        ).to_arrow_table()
    )
    return (coverage_cal,)


@app.cell
def _(alt, coverage_cal, mo):
    _base = alt.Chart(coverage_cal).encode(
        x=alt.X("monthdate(date):O", title="Day", axis=alt.Axis(format="%b %d")),
        y=alt.Y("yearmonth(date):O", title=None),
    )
    _heat = _base.mark_rect().encode(
        color=alt.Color(
            "obs:Q",
            title="Observations",
            scale=alt.Scale(scheme="blues"),
        ),
        tooltip=["date", "obs", "routes_covered", "avg_fare"],
    )
    _text = _base.mark_text(size=8).encode(
        text=alt.Text("routes_covered:N"),
        color=alt.condition(alt.datum.obs > 0, alt.value("black"), alt.value("lightgray")),
    )
    _chart = (
        alt.layer(_heat, _text)
        .properties(
            height=120,
            title="Daily observation count and route coverage by departure date",
        )
        .configure_legend(orient="bottom", title=None)
    )
    mo.ui.altair_chart(_chart)
    return


@app.cell
def _(mo):
    mo.md("## Fare Distribution — by Service Class")
    return


@app.cell
def _(conn, mo, pl):
    fare_dist = pl.from_arrow(
        conn.execute(
            """
        SELECT
          class_label,
          round(fare_lowest_eur * 2) / 2.0 AS fare_bin,
          count(*)                          AS n
        FROM prices
        WHERE fare_lowest_eur IS NOT NULL
          AND fare_lowest_eur < 300
        GROUP BY class_label, fare_bin
        ORDER BY class_label, fare_bin
        """
        ).to_arrow_table()
    )
    return (fare_dist,)


@app.cell
def _(alt, fare_dist, mo):
    _chart = (
        alt.Chart(fare_dist)
        .mark_bar(cornerRadiusTopLeft=2, cornerRadiusTopRight=2)
        .encode(
            x=alt.X("fare_bin:Q", title="Lowest Fare (EUR)", axis=alt.Axis(format=".0f")),
            y=alt.Y("n:Q", title="Observations"),
            color=alt.Color("class_label:N", title="Class", scale=alt.Scale(scheme="set1")),
            tooltip=["fare_bin", "class_label", "n"],
        )
        .properties(
            height=340,
            title="Fare distribution by service class (binned in DuckDB)",
        )
        .configure_legend(orient="bottom")
    )
    mo.ui.altair_chart(_chart, chart_selection=False, legend_selection=False)
    return


@app.cell
def _(mo):
    mo.md("## Scatter Matrix — Fare, Duration, Transfers, Lead Time")
    return


@app.cell
def _(conn, mo, pl):
    scatter_data = pl.from_arrow(
        conn.execute(
            """
        SELECT
          fare_lowest_eur,
          duration_minutes,
          transfers,
          days_to_departure,
          class_label,
          train_type
        FROM prices
        WHERE fare_lowest_eur IS NOT NULL
          AND fare_lowest_eur < 300
          AND duration_minutes IS NOT NULL
          AND duration_minutes < 600
        USING SAMPLE 10000
        """
        ).to_arrow_table()
    )
    return (scatter_data,)


@app.cell
def _(alt, mo, scatter_data):
    _chart = (
        alt.Chart(scatter_data)
        .mark_point(size=10, opacity=0.4)
        .encode(
            x=alt.X("fare_lowest_eur:Q", title="Fare (EUR)"),
            y=alt.Y("duration_minutes:Q", title="Duration (min)"),
            color=alt.Color("class_label:N", title="Class", scale=alt.Scale(scheme="set1")),
            size=alt.Size("transfers:Q", title="Transfers", scale=alt.Scale(range=[20, 100])),
            tooltip=["fare_lowest_eur", "duration_minutes", "transfers", "days_to_departure", "train_type"],
        )
        .properties(
            height=350,
            title="Fare vs Duration (colored by class, sized by transfers) — 10K sample",
        )
    )
    mo.ui.altair_chart(_chart)
    return


@app.cell
def _(mo):
    mo.md("## Route Coverage — Top Routes by Observation Count")
    return


@app.cell
def _(conn, mo, pl):
    top_routes = pl.from_arrow(
        conn.execute(
            """
        SELECT
          route_label,
          class_label,
          count(*)                                          AS n_obs,
          round(avg(fare_lowest_eur), 2)                   AS avg_fare,
          round(avg(duration_minutes), 0)::int              AS avg_duration_min,
          round(avg(price_per_min), 3)                      AS avg_price_per_min
        FROM prices
        GROUP BY route_label, class_label
        ORDER BY n_obs DESC
        """
        ).to_arrow_table()
    )
    return (top_routes,)


@app.cell
def _(alt, mo, pl, top_routes):
    _top20 = top_routes.sort("n_obs", descending=True).unique(
        subset=["route_label"], keep="first"
    ).head(20)

    _chart = (
        alt.Chart(_top20)
        .mark_bar(cornerRadiusTopRight=3)
        .encode(
            x=alt.X("n_obs:Q", title="Observations"),
            y=alt.Y("route_label:N", sort="-x", title="Route"),
            tooltip=["route_label", "n_obs", "avg_fare", "avg_duration_min"],
            color=alt.Color("avg_price_per_min:Q", title="\u20ac/min", scale=alt.Scale(scheme="viridis")),
        )
        .properties(height=350, title="Top 20 routes by observation count (colored by \u20ac/min)")
    )
    mo.ui.altair_chart(_chart, chart_selection=False, legend_selection=False)
    return


@app.cell
def _(mo):
    mo.md("## Data Completeness — Null Profile")
    return


@app.cell
def _(conn, mo, pl):
    nulls = pl.from_arrow(
        conn.execute(
            """
        SELECT col, nulls, total,
               round(100.0 * nulls / total, 1) AS pct_null
        FROM (
          VALUES
            ('load_factor',        (SELECT count(*) FILTER (WHERE load_factor IS NULL)        FROM prices)),
            ('duration_minutes',   (SELECT count(*) FILTER (WHERE duration_minutes IS NULL)   FROM prices)),
            ('fare_lowest_eur',    (SELECT count(*) FILTER (WHERE fare_lowest_eur IS NULL)    FROM prices)),
            ('train_type',         (SELECT count(*) FILTER (WHERE train_type IS NULL)         FROM prices)),
            ('train_number',       (SELECT count(*) FILTER (WHERE train_number IS NULL)       FROM prices)),
            ('transfers',          (SELECT count(*) FILTER (WHERE transfers IS NULL)          FROM prices))
        ) AS t(col, nulls)
        CROSS JOIN (SELECT count(*) AS total FROM prices) s
        ORDER BY nulls DESC
        """
        ).to_arrow_table()
    )
    total = nulls["total"][0]
    return nulls, total


@app.cell
def _(alt, mo, nulls):
    _chart = (
        alt.Chart(nulls)
        .mark_bar(cornerRadiusTopRight=3)
        .encode(
            x=alt.X("nulls:Q", title="Null Count"),
            y=alt.Y("col:N", sort="-x", title="Column"),
            color=alt.Color("pct_null:Q", title="% Null", scale=alt.Scale(scheme="reds")),
            tooltip=["col", "nulls", alt.Tooltip("pct_null:Q", format=".1f")],
        )
        .properties(height=220, title="Null counts across key columns")
    )
    mo.ui.altair_chart(_chart, chart_selection=False, legend_selection=False)
    return


@app.cell
def _(mo, nulls):
    mo.hstack(
        [
            mo.stat(label="Worst Column", value=nulls.row(0, named=True)["col"], bordered=True),
            mo.stat(
                label="Nulls in Worst",
                value=f"{nulls.row(0, named=True)['nulls']:,}",
                bordered=True,
            ),
            mo.stat(
                label="% Null (Worst)",
                value=f"{nulls.row(0, named=True)['pct_null']}%",
                bordered=True,
            ),
        ],
        justify="center",
        gap=1,
    )
    return


@app.cell
def _(mo):
    mo.md("## Scrape Cadence — Distribution of Scrapes per Route")
    return


@app.cell
def _(conn, mo, pl):
    cadence = pl.from_arrow(
        conn.execute(
            """
        WITH per_route AS (
          SELECT
            route_id,
            any_value(route_label) AS route_label,
            count(DISTINCT observed_at) AS scrapes,
            count(DISTINCT departure_date) AS dep_days_covered
          FROM prices GROUP BY route_id
        )
        SELECT
          scrapes,
          count(*) AS n_routes
        FROM per_route
        GROUP BY scrapes
        ORDER BY scrapes
        """
        ).to_arrow_table()
    )
    cadence_stats = pl.from_arrow(
        conn.execute(
            """
        WITH per_route AS (
          SELECT route_id, count(DISTINCT observed_at) AS scrapes
          FROM prices GROUP BY route_id
        )
        SELECT
          min(scrapes)        AS min_scrapes,
          round(avg(scrapes)) AS avg_scrapes,
          median(scrapes)     AS median_scrapes,
          max(scrapes)        AS max_scrapes,
          stddev_samp(scrapes) AS std_scrapes
        FROM per_route
        """
        ).to_arrow_table()
    )
    return cadence, cadence_stats


@app.cell
def _(alt, cadence, cadence_stats, mo):
    _med = cadence_stats.row(0, named=True)["median_scrapes"]
    _chart = (
        alt.Chart(cadence)
        .mark_bar(cornerRadiusTopRight=2)
        .encode(
            x=alt.X("scrapes:Q", bin=alt.Bin(maxbins=30), title="Scrape count per route"),
            y=alt.Y("n_routes:Q", title="Number of routes"),
            tooltip=["scrapes", "n_routes"],
        )
        .properties(height=220, title=f"Distribution of scrape frequency (median={_med} scrapes/route)")
    )
    _rule = alt.Chart().mark_rule(color="red", strokeDash=[4, 2]).encode(
        x=alt.datum(_med)
    )
    alt.layer(_chart, _rule).resolve_scale(x="shared")
    return


@app.cell
def _(cadence_stats, mo):
    cs = cadence_stats.row(0, named=True)
    mo.hstack(
        [
            mo.stat(label="Min Scrapes/Route", value=str(int(cs["min_scrapes"])), bordered=True),
            mo.stat(label="Avg Scrapes/Route", value=f"{cs['avg_scrapes']:.0f}", bordered=True),
            mo.stat(label="Median Scrapes/Route", value=str(int(cs["median_scrapes"])), bordered=True),
            mo.stat(label="Max Scrapes/Route", value=str(int(cs["max_scrapes"])), bordered=True),
        ],
        justify="center",
        gap=1,
    )
    return (cs,)


@app.cell
def _(mo):
    mo.md("## Train Type Composition")
    return


@app.cell
def _(conn, mo, pl):
    train_mix = pl.from_arrow(
        conn.execute(
            """
        SELECT
          train_type,
          count(*)                                    AS n,
          round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct,
          round(avg(fare_lowest_eur), 2)              AS avg_fare,
          round(avg(duration_minutes), 0)::int         AS avg_dur,
          round(avg(transfers), 2)                     AS avg_transfers
        FROM prices
        WHERE train_type IS NOT NULL
        GROUP BY train_type
        ORDER BY n DESC
        """
        ).to_arrow_table()
    )
    return (train_mix,)


@app.cell
def _(alt, mo, train_mix):
    _chart = (
        alt.Chart(train_mix.head(12))
        .mark_bar(cornerRadiusTopRight=3)
        .encode(
            x=alt.X("pct:Q", title="% of Observations", axis=alt.Axis(format=".1f")),
            y=alt.Y("train_type:N", sort="-x", title="Train Type"),
            color=alt.Color("avg_fare:Q", title="Avg Fare (\u20ac)", scale=alt.Scale(scheme="greens")),
            tooltip=["train_type", "pct", "n", "avg_fare", "avg_dur", "avg_transfers"],
        )
        .properties(height=320, title="Train type composition (top 12)")
    )
    mo.ui.altair_chart(_chart, chart_selection=False, legend_selection=False)
    return


@app.cell
def _(mo):
    mo.md("## Full Data Profile")
    return


@app.cell
def _(conn, mo):
    profile = mo.sql(
        """
        SELECT
          column_name,
          column_type,
          CASE WHEN "null" = 'YES' THEN 'nullable' ELSE 'not null' END AS nullable
        FROM (DESCRIBE prices)
        ORDER BY column_name
        """,
        engine=conn,
    )
    return (profile,)


if __name__ == "__main__":
    app.run()
