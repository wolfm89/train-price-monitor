#!/bin/bash
set -e

if [[ -z "${AWS_EXECUTION_ENV}" ]]; then
    echo "Running on AWS Lambda"
    exec /lambda-entrypoint.sh "$@"
else
    echo "Not running on AWS Lambda"
    exec node main.js
fi
