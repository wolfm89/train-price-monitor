#!/bin/bash
set -euo pipefail
# Print all commands
# set -x

date_format_iso="%Y-%m-%dT%H:%MZ"

# Function to format datetime
format_datetime() {
  date -u -d "$1" +"$2"
}

# Function to get the price for a journey on a specific datetime
get_journeys() {
  local from_id="$1"
  local to_id="$2"
  local datetime="$3"
  local index="${4:--1}"
  local response

  # Conditionally include index parameter if defined
  if [ "$index" -eq -1 ]; then
    response=$(http GET 'https://v6.db.transport.rest/journeys' from=="${from_id}" to=="${to_id}" departure=="${datetime}" | jq -r '.journeys[]')
  else
    response=$(http GET 'https://v6.db.transport.rest/journeys' from=="${from_id}" to=="${to_id}" departure=="${datetime}" | jq -r --argjson idx "$index" '.journeys[$idx] | .price.amount')
  fi

  echo "$response"
}

# Input parameters
from_id="$1"
to_id="$2"
start_datetime="$3"
num_days="$4"

# Initialize CSV file
output_filename="data/${from_id}-${to_id}-$(format_datetime "$start_datetime" "%Y-%m-%dT%H-%MZ").csv"
echo "output_filename: $output_filename"
echo "Date,Price" > "$output_filename"

# Get the selected journey on the first day
formatted_datetime=$(format_datetime "$start_datetime" "$date_format_iso")
journeys="$(get_journeys "$from_id" "$to_id" "$formatted_datetime")"

# Display JSON result for the first day
echo "JSON Result for $formatted_datetime:"
echo "$journeys" | less

# Prompt user to select a journey on the first day
read -p "Enter the journey number: " selected_index

# Loop over days from the start datetime
current_datetime="$start_datetime"
for ((i=0; i<num_days; i++)); do
  echo "Day $i: $current_datetime..."
  formatted_datetime=$(format_datetime "$current_datetime" "$date_format_iso")

  # Get the price for the current day
  price=$(get_journeys "$from_id" "$to_id" "$formatted_datetime" "$selected_index")

  # Append data to CSV file
  echo "$formatted_datetime,$price" >> "$output_filename"

  # Move to the next day
  current_datetime=$(date -u -d "$current_datetime + 1 day" +"$date_format_iso")
done

echo "Data saved to $output_filename"
