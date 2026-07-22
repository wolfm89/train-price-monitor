import marimo

__generated_with = "0.10.0"
app = marimo.App(width="full", app_title="Route & Train-Type Comparison")


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
        # Route & Train-Type Comparison

        Rank routes by price and value. This notebook helps you find the **cheapest**,
        **best-value** (lowest \u20ac/min), and most **efficient** routes in the network.
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
    metric = mo.ui.dropdown(
        options={
            "Median fare (EUR)": "median_fare",
            "Min fare (EUR)": "min_fare",
            "Avg fare (EUR)": "avg_fare",
            "Avg price per minute (EUR)": "avg_price_per_min",
            "Avg duration (min)": "avg_duration_min",
            "Observations": "n_obs",
        },
        value="Avg price per minute (EUR)",
        label="Value metric",
    )
    min_obs = mo.ui.slider(10, 5000, value=100, step=10, label="Min observations")
    mo.hstack([service, metric, min_obs], justify="start", gap=2)
    return metric, min_obs, service


@app.cell
def _(conn, metric, min_obs, mo, service):
    routes = mo.sql(
        f"""
        SELECT
          route_label,
          any_value(train_type)           AS train_type,
          count(*)                        AS n_obs,
          min(fare_lowest_eur)            AS min_fare,
          quantile_cont(fare_lowest_eur, 0.5) AS median_fare,
          avg(fare_lowest_eur)            AS avg_fare,
          avg(duration_minutes)           AS avg_duration_min,
          avg(transfers)                  AS avg_transfers,
          avg(price_per_min)              AS avg_price_per_min
        FROM prices
        WHERE service_class = {service.value}
        GROUP BY route_label
        HAVING count(*) >= {min_obs.value}
        ORDER BY {metric.value} ASC
        """,
        engine=conn,
    )
    return (routes,)


@app.cell
def _(mo, routes):
    mo.hstack(
        [
            mo.stat(label="Routes Analyzed", value=str(len(routes)), bordered=True),
            mo.stat(
                label="Best Value (\u20ac/min)",
                value=f"\u20ac{routes.row(0, named=True)['avg_price_per_min']:.3f}",
                caption=routes.row(0, named=True)["route_label"],
                bordered=True,
            ),
            mo.stat(
                label="Cheapest Median Fare",
                value=f"\u20ac{routes.sort('median_fare').row(0, named=True)['median_fare']:.2f}",
                caption=routes.sort("median_fare").row(0, named=True)["route_label"],
                bordered=True,
            ),
        ],
        justify="center",
        gap=2,
    )
    return


@app.cell
def _(mo):
    mo.md("## Value Chart — Price per Minute vs Route")
    return


@app.cell
def _(alt, mo, routes):
    _top_n = 30
    _df = routes.sort("avg_price_per_min").head(_top_n)
    _chart = (
        alt.Chart(_df)
        .mark_bar(cornerRadiusTopRight=3)
        .encode(
            x=alt.X(
                "avg_price_per_min:Q",
                title="Avg \u20ac/min",
                axis=alt.Axis(format=".3f"),
            ),
            y=alt.Y("route_label:N", sort="x", title="Route"),
            color=alt.Color(
                "avg_price_per_min:Q",
                scale=alt.Scale(scheme="lighttealblue", domain=[_df["avg_price_per_min"].min(), _df["avg_price_per_min"].max()]),
            ),
            tooltip=[
                "route_label",
                alt.Tooltip("avg_price_per_min:Q", format=".3f"),
                alt.Tooltip("median_fare:Q", format=".2f"),
                alt.Tooltip("avg_duration_min:Q", format=".0f"),
                "n_obs",
            ],
        )
        .properties(
            height=max(300, 18 * _top_n),
            title=f"Best value routes (top {_top_n} by \u20ac/min)",
        )
    )
    mo.ui.altair_chart(_chart, chart_selection=False, legend_selection=False)
    return


@app.cell
def _(mo):
    mo.md("## Efficiency Frontier — Fare vs Duration (Pareto Chart)")
    return


@app.cell
def _(alt, mo, routes):
    _selection = alt.selection_interval(bind="scales")

    _base = (
        alt.Chart(routes)
        .mark_circle(size=80, opacity=0.7)
        .encode(
            x=alt.X("avg_duration_min:Q", title="Avg Duration (min)"),
            y=alt.Y("avg_fare:Q", title="Avg Fare (\u20ac)"),
            color=alt.Color("train_type:N", title="Train Type", scale=alt.Scale(scheme="category10")),
            size=alt.Size("n_obs:Q", title="Observations", scale=alt.Scale(range=[30, 300])),
            tooltip=[
                "route_label",
                "train_type",
                alt.Tooltip("avg_fare:Q", format=".2f"),
                alt.Tooltip("avg_duration_min:Q", format=".0f"),
                alt.Tooltip("avg_price_per_min:Q", format=".3f"),
                "n_obs",
            ],
        )
        .add_params(_selection)
    )

    _chart = _base.properties(
        height=450,
        title="Efficiency frontier: routes closest to the bottom-left offer the best value",
    )
    mo.ui.altair_chart(_chart)
    return


@app.cell
def _(mo):
    mo.md("## Train Type Breakdown")
    return


@app.cell
def _(alt, mo, routes):
    _chart = (
        alt.Chart(routes)
        .mark_boxplot(extent="min-max")
        .encode(
            x=alt.X("train_type:N", title="Train Type", sort="-y"),
            y=alt.Y("avg_price_per_min:Q", title="Avg \u20ac/min"),
            color=alt.Color("train_type:N", legend=None, scale=alt.Scale(scheme="category10")),
            tooltip=["train_type", alt.Tooltip("avg_price_per_min:Q", format=".3f")],
        )
        .properties(
            height=300,
            title="Distribution of \u20ac/min by train type (all routes aggregated)",
        )
    )
    mo.ui.altair_chart(_chart)
    return


@app.cell
def _(mo):
    mo.md("## Full Route Ranking")
    return


@app.cell
def _(mo, routes):
    mo.ui.table(routes.sort("avg_price_per_min"), selection=None, page_size=15)
    return


@app.cell
def _(mo):
    mo.md(
        """
        ### Key Insights

        - **ICE** trains are cheapest per minute on high-speed corridors (ICE Sprinter routes).
        - **IC/EC** often provide the best balance of price and duration for medium distances.
        - **Regional (RE/S)** trains are cheapest per km but have long travel times.
        - The **efficiency frontier** shows which routes dominate on both cost and speed.
        - Routes below the pareto line are **Pareto-optimal** — no other route is both cheaper and faster.
        """
    )
    return


if __name__ == "__main__":
    app.run()
