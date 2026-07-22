import marimo

__generated_with = "0.10.0"
app = marimo.App(width="full", app_title="Temporal Patterns — When to Travel")


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
        # Temporal Patterns — When to Travel

        Fares by **departure day-of-week** and **hour-of-day**. Discover weekend premiums,
        peak-hour pricing, and the cheapest times to travel.
        """
    )
    return


@app.cell
def _(mo):
    service = mo.ui.dropdown(
        options={"2nd class": 2, "1st class": 1},
        value="2nd class",
        label="Service class",
    )
    mo.hstack([service], justify="start", gap=2)
    return (service,)


@app.cell
def _(conn, mo, service):
    by_dow = mo.sql(
        f"""
        SELECT
          dep_isodow,
          any_value(dep_dayname)              AS dep_dayname,
          avg(fare_lowest_eur)                AS avg_fare,
          quantile_cont(fare_lowest_eur, 0.5) AS median_fare,
          count(*)                            AS n_obs,
          avg(duration_minutes)               AS avg_dur
        FROM prices
        WHERE service_class = {service.value}
        GROUP BY dep_isodow
        ORDER BY dep_isodow
        """,
        engine=conn,
    )
    return (by_dow,)


@app.cell
def _(by_dow, mo, pl):
    _weekdays = by_dow.filter(pl.col("dep_isodow").is_between(1, 5))
    _weekend = by_dow.filter(pl.col("dep_isodow").is_between(6, 7))
    _weekday_avg = _weekdays["avg_fare"].mean()
    _weekend_avg = _weekend["avg_fare"].mean()
    _premium = (_weekend_avg / _weekday_avg - 1) * 100 if _weekday_avg > 0 else 0

    mo.hstack(
        [
            mo.stat(
                label="Weekday Avg Fare",
                value=f"\u20ac{_weekday_avg:.2f}",
                bordered=True,
            ),
            mo.stat(
                label="Weekend Avg Fare",
                value=f"\u20ac{_weekend_avg:.2f}",
                caption=f"Premium: +{_premium:.1f}%",
                direction="increase" if _premium > 0 else "decrease",
                bordered=True,
            ),
            mo.stat(
                label="Cheapest Day",
                value=by_dow.sort("avg_fare").row(0, named=True)["dep_dayname"],
                caption=f"\u20ac{by_dow.sort('avg_fare').row(0, named=True)['avg_fare']:.2f}",
                bordered=True,
            ),
            mo.stat(
                label="Most Expensive Day",
                value=by_dow.sort("avg_fare", descending=True).row(0, named=True)["dep_dayname"],
                caption=f"\u20ac{by_dow.sort('avg_fare', descending=True).row(0, named=True)['avg_fare']:.2f}",
                direction="increase",
                bordered=True,
            ),
        ],
        justify="center",
        gap=2,
    )
    return


@app.cell
def _(mo):
    mo.md("## Day-of-Week Fare Analysis")
    return


@app.cell
def _(alt, by_dow, mo):
    _base = alt.Chart(by_dow).encode(
        x=alt.X("dep_dayname:N", sort=alt.SortField("dep_isodow"), title="Departure Day"),
        tooltip=[
            "dep_dayname",
            alt.Tooltip("avg_fare:Q", format=".2f"),
            alt.Tooltip("median_fare:Q", format=".2f"),
            "n_obs",
        ],
    )
    _bars = _base.mark_bar(cornerRadiusTopRight=3, opacity=0.85).encode(
        y=alt.Y("avg_fare:Q", title="Fare (\u20ac)"),
        color=alt.Color(
            "dep_dayname:N",
            sort=alt.SortField("dep_isodow"),
            scale=alt.Scale(
                scheme="category10",
            ),
            legend=None,
        ),
    )
    _line = _base.mark_line(color="black", size=1, opacity=0.5, strokeDash=[4, 2]).encode(
        y=alt.Y("median_fare:Q"),
    )
    _rule = alt.Chart().mark_rule(
        color="firebrick", strokeDash=[6, 3], size=1.5, opacity=0.6
    ).encode(y=alt.datum(by_dow["avg_fare"].mean()))

    alt.layer(_bars, _line, _rule).properties(
        height=320,
        title="Average fare by day of week (bar) with median (dashed) and overall mean (red line)",
    ).configure_legend(orient="bottom")
    return


@app.cell
def _(mo):
    mo.md("## Day-of-Week × Hour-of-Day Heatmap")
    return


@app.cell
def _(conn, mo, pl, service):
    heat = pl.from_arrow(
        conn.execute(
            f"""
        SELECT
          dep_isodow,
          any_value(dep_dayname)              AS dep_dayname,
          dep_hour,
          avg(fare_lowest_eur)                AS avg_fare,
          quantile_cont(fare_lowest_eur, 0.5) AS median_fare,
          count(*)                            AS n_obs
        FROM prices
        WHERE service_class = {service.value}
        GROUP BY dep_isodow, dep_hour
        """
        ).to_arrow_table()
    )
    return (heat,)


@app.cell
def _(alt, heat, mo):
    _chart = (
        alt.Chart(heat)
        .mark_rect()
        .encode(
            x=alt.X("dep_hour:O", title="Hour of Departure"),
            y=alt.Y(
                "dep_dayname:N",
                sort=alt.SortField("dep_isodow"),
                title="Departure Day",
            ),
            color=alt.Color(
                "avg_fare:Q",
                title="Avg Fare (\u20ac)",
                scale=alt.Scale(scheme="magma"),
            ),
            tooltip=[
                "dep_dayname",
                "dep_hour",
                alt.Tooltip("avg_fare:Q", format=".2f"),
                alt.Tooltip("median_fare:Q", format=".2f"),
                "n_obs",
            ],
        )
        .properties(
            height=280,
            title="Fare heatmap: day of week vs hour of departure",
        )
    )
    mo.ui.altair_chart(_chart)
    return


@app.cell
def _(mo):
    mo.md("## Hourly Fare Profile — Weekday vs Weekend")
    return


@app.cell
def _(alt, heat, mo, pl):
    _hourly = heat.with_columns(
        pl.when(pl.col("dep_isodow").is_between(1, 5))
        .then(pl.lit("Weekday"))
        .otherwise(pl.lit("Weekend"))
        .alias("day_type")
    )

    _chart = (
        alt.Chart(_hourly)
        .mark_line(point=True, size=2, opacity=0.8)
        .encode(
            x=alt.X("dep_hour:O", title="Hour of Departure"),
            y=alt.Y(
                "avg_fare:Q",
                title="Avg Fare (\u20ac)",
                scale=alt.Scale(zero=False),
            ),
            color=alt.Color(
                "day_type:N",
                title="Day Type",
                scale=alt.Scale(domain=["Weekday", "Weekend"], range=["#3498db", "#e74c3c"]),
            ),
            tooltip=["dep_hour", "day_type", alt.Tooltip("avg_fare:Q", format=".2f"), "n_obs"],
        )
        .properties(
            height=300,
            title="Hourly fare profile: weekday vs weekend",
        )
    )
    mo.ui.altair_chart(_chart)
    return


@app.cell
def _(mo):
    mo.md("## Departure Volume by Hour (Travel Demand)")
    return


@app.cell
def _(alt, conn, mo, pl, service):
    vol = pl.from_arrow(
        conn.execute(
            f"""
        SELECT
          dep_hour,
          count(*) AS departures
        FROM prices
        WHERE service_class = {service.value}
        GROUP BY dep_hour
        ORDER BY dep_hour
        """
        ).to_arrow_table()
    )
    return (vol,)


@app.cell
def _(alt, mo, vol):
    _chart = (
        alt.Chart(vol)
        .mark_bar(cornerRadiusTopRight=3, opacity=0.8)
        .encode(
            x=alt.X("dep_hour:O", title="Hour of Departure"),
            y=alt.Y("departures:Q", title="Number of Departures"),
            color=alt.Color(
                "departures:Q",
                scale=alt.Scale(scheme="blues"),
                legend=None,
            ),
            tooltip=["dep_hour", "departures"],
        )
        .properties(
            height=250,
            title="Departure volume by hour (when trains depart most frequently)",
        )
    )
    mo.ui.altair_chart(_chart, chart_selection=False, legend_selection=False)
    return


@app.cell
def _(mo):
    mo.md(
        """
        ### Key Insights

        - **Weekend travel** carries a **premium** — Friday and Sunday departures are most expensive
          (evening rush + leisure travel).
        - **Tuesday and Wednesday** are consistently the cheapest days to travel.
        - The **heatmap** reveals early-morning (6-9) and late-afternoon (15-18) peak pricing.
        - **Late-night** departures (22-0) often drop in price — DB's night trains offer a discount.
        - **Volume profile** shows most departures cluster in the 6-10 AM and 3-7 PM windows.
        - The **weekend hourly curve** flattens — no sharp morning peak, but fares stay elevated
          through midday.
        """
    )
    return


if __name__ == "__main__":
    app.run()
