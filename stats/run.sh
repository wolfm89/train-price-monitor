#!/bin/bash
set -euo pipefail

# Print help message if any of the parameters are missing
if [ $# -ne 4 ]; then
  echo "Usage: $0 <from> <to> <datetime> <n_days>"
  exit 1
fi

BASE_URL="https://v6.db.transport.rest"
from_id=$(http ${BASE_URL}/locations query=="$1" results==1 addresses==false poi==false | jq -r ".[].id")
to_id=$(http ${BASE_URL}/locations query=="$2" results==1 addresses==false poi==false | jq -r ".[].id")

datetime="$3"
n_days="$4"

./get_prices.sh "$from_id" "$to_id" "$datetime" "$n_days" && gnuplot -e "fname='data/$from_id-$to_id-$(date -u -d "$datetime" +"%Y-%m-%dT%H-%MZ").csv'" price.plt
