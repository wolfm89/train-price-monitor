#!/usr/bin/env bash
#
# Sync compacted daily_*.parquet files from the scraper S3 bucket into
# data/scraper/. Invoked by `mise run //stats:fetch`, which parses the flags and
# exposes them as usage_* environment variables.
#
# Modes (mutually exclusive):
#   --days N             Fetch the last N days, ending yesterday.
#   --from D [--to D]    Fetch an inclusive date range (default --to = yesterday).
#
# Source layout (see scraper/src/compactor.ts):
#   s3://$BUCKET/prices/year=YYYY/month=MM/day=DD/daily_<epoch>_<rand>.parquet
# The newest daily_ object per partition (highest epoch) is the canonical file;
# it is saved locally as data/scraper/daily_YYYY-MM-DD.parquet.

set -euo pipefail

DAYS="${usage_days:-}"
FROM="${usage_from:-}"
TO="${usage_to:-}"
BUCKET="${usage_bucket:-${SCRAPER_BUCKET_NAME:-}}"

die() {
  echo "fetch: $*" >&2
  exit 1
}

[[ -n "$BUCKET" ]] || die "no bucket: pass --bucket or set SCRAPER_BUCKET_NAME"

# Resolve the inclusive [START, END] date window.
YESTERDAY="$(date -u -d 'yesterday' +%F)"

if [[ -n "$DAYS" && ( -n "$FROM" || -n "$TO" ) ]]; then
  die "use either --days or --from/--to, not both"
elif [[ -n "$DAYS" ]]; then
  [[ "$DAYS" =~ ^[0-9]+$ && "$DAYS" -ge 1 ]] || die "--days must be a positive integer"
  END="$YESTERDAY"
  START="$(date -u -d "$YESTERDAY - $((DAYS - 1)) days" +%F)"
elif [[ -n "$FROM" ]]; then
  START="$FROM"
  END="${TO:-$YESTERDAY}"
else
  die "specify a window: --days N or --from YYYY-MM-DD [--to YYYY-MM-DD]"
fi

# Validate / normalise dates via GNU date (also rejects malformed input).
START="$(date -u -d "$START" +%F)" || die "invalid --from date"
END="$(date -u -d "$END" +%F)" || die "invalid --to date"
[[ "$START" > "$END" ]] && die "start date ($START) is after end date ($END)"

# Optional explicit endpoint (e.g. Floci local emulator).
ENDPOINT_ARGS=()
[[ -n "${AWS_ENDPOINT_URL:-}" ]] && ENDPOINT_ARGS=(--endpoint-url "$AWS_ENDPOINT_URL")

DEST_DIR="data/scraper"
mkdir -p "$DEST_DIR"

echo "fetch: bucket=$BUCKET window=$START..$END -> $DEST_DIR"

fetched=0
missing=0
cursor="$START"
while [[ ! "$cursor" > "$END" ]]; do
  read -r y m d <<<"$(date -u -d "$cursor" '+%Y %m %d')"
  prefix="prices/year=${y}/month=${m}/day=${d}/"

  # Newest daily_ object in the partition (lexical max == highest epoch).
  key="$(
    aws s3api list-objects-v2 "${ENDPOINT_ARGS[@]}" \
      --bucket "$BUCKET" --prefix "$prefix" \
      --query "Contents[?contains(Key, '/daily_')].Key" --output text 2>/dev/null \
      | tr '\t' '\n' | sort | tail -n1
  )"

  if [[ -z "$key" || "$key" == "None" ]]; then
    echo "  $cursor  (no daily file found, skipping)"
    missing=$((missing + 1))
  else
    dest="$DEST_DIR/daily_${cursor}.parquet"
    aws s3 cp "${ENDPOINT_ARGS[@]}" "s3://${BUCKET}/${key}" "$dest" --only-show-errors
    echo "  $cursor  <- ${key##*/}"
    fetched=$((fetched + 1))
  fi

  cursor="$(date -u -d "$cursor + 1 day" +%F)"
done

echo "fetch: done — $fetched file(s) fetched, $missing day(s) missing"
