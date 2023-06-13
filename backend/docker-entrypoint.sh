#!/bin/bash
set -e

if [[ "${AWS_EXECUTION_ENV:0:13}" == "AWS_Lambda_nodejs" ]]; then
    echo "Running on AWS Lambda"
    exec /lambda-entrypoint.sh "$@"
else
    echo "Not running on AWS Lambda"
    exec node main.js
fi
