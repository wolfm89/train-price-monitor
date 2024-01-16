#!/bin/bash
set -euo pipefail

# Print help message if any of the parameters are missing
if [ $# -ne 4 ]; then
  echo "Usage: $0 <from> <to> <datetime> <n_days>"
  exit 1
fi

from="$1"
to="$2"
datetime="$3"
n_days="$4"

./get_prices.sh "$from" "$to" "$datetime" "$n_days" && gnuplot -e "fname='data/$from-$to-$(date -u -d "$datetime" +"%Y-%m-%dT%H-%MZ").csv'" price.plt
