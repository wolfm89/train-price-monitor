# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Silver builder image: AWS Lambda Python 3.15 + the pinned DuckDB wheel.
#
# Everything the build needs lives inside analytics/, so unlike backend/ and
# scraper/ the bundle is not built on the host first.
# ---------------------------------------------------------------------------

FROM ghcr.io/astral-sh/uv:0.13.8 AS uv

FROM public.ecr.aws/lambda/python:3.15 AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_NO_INSTALLER_METADATA=1 \
    UV_LINK_MODE=copy \
    UV_FROZEN=1

# Runtime dependencies only, straight from the lockfile, into the task root.
RUN --mount=from=uv,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv export --no-dev --no-emit-project -o /tmp/requirements.txt && \
    uv pip install -r /tmp/requirements.txt --target "${LAMBDA_TASK_ROOT}"

FROM public.ecr.aws/lambda/python:3.15

COPY --from=builder ${LAMBDA_TASK_ROOT} ${LAMBDA_TASK_ROOT}
COPY src/tpm_analytics ${LAMBDA_TASK_ROOT}/tpm_analytics
COPY scripts/install_httpfs.py /tmp/install_httpfs.py

# httpfs is not bundled in the wheel and Lambda's root filesystem is read-only at runtime, so it is
# installed into a fixed directory baked into the image. tpm_analytics sets the same
# extension_directory from DUCKDB_EXTENSION_DIR and issues LOAD httpfs; nothing is downloaded at
# cold start.
ENV DUCKDB_EXTENSION_DIR=/opt/duckdb/extensions
RUN PYTHONPATH="${LAMBDA_TASK_ROOT}" python /tmp/install_httpfs.py && rm /tmp/install_httpfs.py

# Validate the entrypoint, both packaged assets and the DuckDB secret statement at build time.
RUN python -c "\
from tpm_analytics.silver.handler import handler; \
from tpm_analytics.silver._duck import S3Secret, asset_dir, create_secret_sql; \
import os; \
import duckdb; \
assert callable(handler); \
assert (asset_dir('sql') / 'silver.sql').is_file(); \
assert (asset_dir('data') / 'stations.json').is_file(); \
assert (asset_dir('data') / 'silver-config.json').is_file(); \
c = duckdb.connect(); \
c.execute(f\"SET extension_directory = '{os.environ['DUCKDB_EXTENSION_DIR']}'\"); \
c.execute('LOAD httpfs'); \
c.execute(create_secret_sql(S3Secret('a', 'b', '', 'eu-central-1'))); \
print('image smoke test ok')"

CMD ["tpm_analytics.silver.handler.handler"]
