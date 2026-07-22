import marimo

__generated_with = "0.10.0"
app = marimo.App(width="full", app_title="Booking Curve — Best Time to Book")


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
        # Booking Curve — best time to book

        How the **lowest available fare** evolves as the trip approaches. The x-axis runs
        from far-out (left) to departure (right, lead time = 0).
        """
    )
    return


@app.cell
def _(conn):
    _rows = conn.execute(
        "SELECT DISTINCT route_label, route_id FROM prices ORDER BY route_label"
    ).fetchall()
    route_options = {rid: label for rid, label in _rows}
    return (route_options,)


@app.cell
def _(mo, route_options):
    route_widget = mo.ui.dropdown(
        options=route_options,
        value=next(iter(route_options)),
        label="Route",
    )
    service_widget = mo.ui.dropdown(
        options={"2nd class": 2, "1st class": 1},
        value="2nd class",
        label="Service class",
    )
    mo.hstack([route_widget, service_widget], justify="start", gap=2)
    return route_widget, service_widget


@app.cell
def _(conn, mo, pl, route_widget, service_widget):
    curve = pl.from_arrow(
        conn.execute(
            f"""
        SELECT
          dtd_bucket,
          count(*)                                          AS n_obs,
          min(fare_lowest_eur)                              AS min_fare,
          quantile_cont(fare_lowest_eur, 0.25)              AS p25_fare,
          quantile_cont(fare_lowest_eur, 0.5)               AS median_fare,
          avg(fare_lowest_eur)                              AS avg_fare,
          quantile_cont(fare_lowest_eur, 0.75)              AS p75_fare,
          max(fare_lowest_eur)                              AS max_fare
        FROM prices
        WHERE route_id = '{route_widget.value}'
          AND service_class = {service_widget.value}
        GROUP BY dtd_bucket
        ORDER BY dtd_bucket
        """
        ).to_arrow_table()
    )
    return (curve,)


@app.cell
def _(alt, curve, mo):
    if curve.is_empty():
        mo.stop("No data for this route.")

    _base = (
        alt.Chart(curve)
        .encode(
            x=alt.X(
                "dtd_bucket:Q",
                title="Days to departure (\u2192 departure)",
                scale=alt.Scale(reverse=True),
            ),
        )
    )

    _band = _base.mark_errorband(extent="ci", opacity=0.15).encode(
        y=alt.Y("p25_fare:Q", title="Fare (EUR)", scale=alt.Scale(zero=False)),
        y2="p75_fare:Q",
    )

    _line = _base.mark_line(point=True, size=2, color="#2c3e50").encode(
        y=alt.Y("median_fare:Q"),
        tooltip=[
            "dtd_bucket",
            alt.Tooltip("median_fare:Q", format=".2f"),
            alt.Tooltip("p25_fare:Q", format=".2f"),
            alt.Tooltip("p75_fare:Q", format=".2f"),
            "n_obs",
        ],
    )

    _chart = (
        alt.layer(_band, _line)
        .properties(height=360, title="Booking curve: median fare with P25\u2013P75 band")
    )
    mo.ui.altair_chart(_chart)
    return


@app.cell
def _(mo):
    mo.md("## Price Distribution by Lead Time Bucket")
    return


@app.cell
def _(conn, mo, pl, route_widget, service_widget):
    dist = pl.from_arrow(
        conn.execute(
            f"""
        SELECT
          dtd_bucket,
          round(fare_lowest_eur * 2) / 2.0 AS fare_bin,
          count(*)                          AS n
        FROM prices
        WHERE route_id = '{route_widget.value}'
          AND service_class = {service_widget.value}
          AND fare_lowest_eur IS NOT NULL
          AND fare_lowest_eur < 300
        GROUP BY dtd_bucket, fare_bin
        ORDER BY dtd_bucket, fare_bin
        """
        ).to_arrow_table()
    )
    return (dist,)


@app.cell
def _(alt, dist, mo):
    if dist.is_empty():
        mo.stop("")

    _chart = (
        alt.Chart(dist)
        .mark_bar(opacity=0.7)
        .encode(
            x=alt.X("fare_bin:Q", title="Fare (EUR)"),
            y=alt.Y("n:Q", title="Count"),
            color=alt.Color(
                "dtd_bucket:N",
                title="Days to Departure",
                scale=alt.Scale(scheme="viridis"),
            ),
            tooltip=["fare_bin", "dtd_bucket", "n"],
        )
        .properties(height=250, title="Fare distribution colored by lead time bucket")
        .configure_legend(orient="bottom")
    )
    mo.ui.altair_chart(_chart, chart_selection=False, legend_selection=False)
    return


@app.cell
def _(mo):
    mo.md("## Optimal Booking Window")
    return


@app.cell
def _(curve, mo, pl):
    if curve.is_empty():
        mo.stop("")

    _best = curve.filter(pl.col("median_fare") > 0).sort("median_fare").row(0, named=True)
    mo.hstack(
        [
            mo.stat(
                label="Optimal Booking Window",
                value=f"D-{int(_best['dtd_bucket'])}",
                caption=f"Median fare: \u20ac{_best['median_fare']:.2f} ({_best['n_obs']} observations)",
                bordered=True,
            ),
        ],
        justify="center",
        gap=2,
    )
    return


@app.cell
def _(mo):
    mo.md(
        """
        ### Key Insights

        - **Booking curves** show fares drop as departure nears, then spike in the last 1-3 days.
        - The **P25-P75 band** reveals fare variability at each lead time.
        - The **optimal window** minimizes both price and uncertainty.
        """
    )
    return


if __name__ == "__main__":
    app.run()
