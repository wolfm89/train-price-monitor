#!/usr/bin/env bash
set -euo pipefail

: "${AWS_PROFILE:?Set AWS_PROFILE to an authenticated AWS profile before running this script.}"
STACK_NAME="${STACK_NAME:-InfrastructureStack}"

declare -A CLOUD_FORMATION_OUTPUTS=(
  [PROFILE_IMAGE_BUCKET_NAME]=BackendProfileImageBucketName
  [TPM_SQS_QUEUE_URL]=BackendQueueUrl
  [COGNITO_USER_POOL_ID]=CognitoAuthUserPoolId
  [COGNITO_IDENTITY_POOL_ID]=CognitoAuthIdentityPoolId
)

declare -A ENV_FILE_FIELDS=(
  [backend/.env]='AWS_PROFILE PROFILE_IMAGE_BUCKET_NAME TPM_SQS_QUEUE_URL BROWSER_WS_ENDPOINT'
  [frontend/.env]='COGNITO_USER_POOL_ID COGNITO_CLIENT_ID COGNITO_IDENTITY_POOL_ID AWS_REGION'
  [frontend/.env.development]='REACT_APP_GRAPHQL_ENDPOINT'
)

declare -A STATIC_VALUES=(
  [REACT_APP_GRAPHQL_ENDPOINT]='http://localhost:4000/'
)

ENV_FILES=(
  backend/.env
  frontend/.env
  frontend/.env.development
)

require_value() {
  local name="$1"
  local value="$2"

  if [[ -z "$value" || "$value" == "None" ]]; then
    echo "ERROR: ${name} is required" >&2
    exit 1
  fi
}

cloudformation_output() {
  local output_key_prefix="$1"
  local value

  value="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?starts_with(OutputKey, '${output_key_prefix}')].OutputValue | [0]" \
    --output text)"
  require_value "CloudFormation output starting with '${output_key_prefix}' in ${STACK_NAME}" "$value"
  printf '%s\n' "$value"
}

write_env_file() {
  local file_path="$1"
  local fields="$2"
  local field

  : >"$file_path"
  for field in $fields; do
    printf '%s=%s\n' "$field" "${!field}" >>"$file_path"
  done
}

aws sts get-caller-identity >/dev/null

for env_name in "${!CLOUD_FORMATION_OUTPUTS[@]}"; do
  printf -v "$env_name" '%s' "$(cloudformation_output "${CLOUD_FORMATION_OUTPUTS[$env_name]}")"
done

COGNITO_CLIENT_ID="$(aws cognito-idp list-user-pool-clients --user-pool-id "$COGNITO_USER_POOL_ID" --query 'UserPoolClients[0].ClientId' --output text)"
require_value "Cognito app client for user pool ${COGNITO_USER_POOL_ID}" "$COGNITO_CLIENT_ID"

for env_name in "${!STATIC_VALUES[@]}"; do
  printf -v "$env_name" '%s' "${STATIC_VALUES[$env_name]}"
done

# The vendor CDP endpoint is kept in an SSM SecureString (CI writes it from the
# repository secret) rather than in git. Optional locally: without it the backend
# falls back to the bundled Chromium, which DB currently rejects, so journey
# search fails with OPS_BLOCKED.
SCRAPING_BROWSER_PARAM="${CDK_SCRAPING_BROWSER_PARAM:-/train-price-monitor/scraping-browser-url}"
BROWSER_WS_ENDPOINT="$(aws ssm get-parameter --name "$SCRAPING_BROWSER_PARAM" \
  --with-decryption --query 'Parameter.Value' --output text 2>/dev/null || true)"
if [[ -z "$BROWSER_WS_ENDPOINT" || "$BROWSER_WS_ENDPOINT" == "None" ]]; then
  echo "WARN: SSM parameter ${SCRAPING_BROWSER_PARAM} not found — local journey search will be blocked" >&2
  BROWSER_WS_ENDPOINT=""
fi

for file_path in "${ENV_FILES[@]}"; do
  write_env_file "$file_path" "${ENV_FILE_FIELDS[$file_path]}"
done

echo "Generated ${ENV_FILES[*]} from ${STACK_NAME}"
