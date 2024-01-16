#!/bin/bash
set -euo pipefail
# Print all commands
# set -x

date_format_iso="%Y-%m-%dT%H:%MZ"
BASE_URL="https://v6.db.transport.rest"

# Function to format datetime
format_datetime() {
  date -u -d "$1" +"$2"
}

# Function to get the price for a journey on a specific datetime
get_price() {
  local from_id="$1"
  shift
  local to_id="$1"
  shift
  local datetime="$1"
  shift
  local lines=("$@")
  local response

  response=$(http GET ${BASE_URL}/journeys results==5 from=="${from_id}" to=="${to_id}" departure=="${datetime}" | jq -r --argjson lines "$(printf '%s\n' "${lines[@]}" | jq -R . | jq -s .)" '.journeys[] | select(has("legs") and all(.legs[]; .line.name as $lname | $lines | index($lname))) | .price.amount')

  echo "$response"
}

# Function to get journeys for a specific datetime
get_journeys() {
  local from_id="$1"
  local to_id="$2"
  local datetime="$3"
  local response

  response=$(http GET ${BASE_URL}/journeys results==5 from=="${from_id}" to=="${to_id}" departure=="${datetime}" | jq -r '{"journeys": [.journeys[] | { "price": .price.amount, "legs": [.legs[] | { "origin": .origin.name, "destination": .destination.name, "line": .line.name, "plannedDeparture": .plannedDeparture, "plannedArrival": .plannedArrival }]}]}')

  echo "$response"
}

# Input parameters
from_id="$1"
to_id="$2"
start_datetime="$3"
num_days="$4"

# Print input parameters
echo "From: $from_id"
echo "To: $to_id"
echo "Start datetime: $start_datetime"
echo "Number of days: $num_days"

# Initialize CSV file
output_filename="data/${from_id}-${to_id}-$(format_datetime "$start_datetime" "%Y-%m-%dT%H-%MZ").csv"
echo "output_filename: $output_filename"
echo "Date,Price" > "$output_filename"

# Get the selected journey on the first day
formatted_datetime=$(format_datetime "$start_datetime" "$date_format_iso")
journeys="$(get_journeys "$from_id" "$to_id" "$formatted_datetime")"

# Display JSON result for the first day
echo "$journeys" | less

# Prompt user to select a journey on the first day
read -p "Enter the journey number: " selected_index

# Get array of journey[selected_index].legs[].line to identify the journey
mapfile -t lines < <(echo "$journeys" | jq -r --argjson idx "$selected_index" '.journeys[$idx] | .legs[].line')
# Display the lines comma-separated
echo "$(IFS=,; echo "Lines: ${lines[*]}")"

# Loop over days from the start datetime
current_datetime="$start_datetime"
for ((i=0; i<num_days; i++)); do
  echo "Day $i: $current_datetime..."
  formatted_datetime=$(format_datetime "$current_datetime" "$date_format_iso")

  # Get the price for the current day
  price=$(get_price "$from_id" "$to_id" "$formatted_datetime" "${lines[@]}")

  # Append data to CSV file
  echo "$formatted_datetime,$price" >> "$output_filename"

  # Move to the next day
  current_datetime=$(date -u -d "$current_datetime + 1 day" +"$date_format_iso")
done

echo "Data saved to $output_filename"
