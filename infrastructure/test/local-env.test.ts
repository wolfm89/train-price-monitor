import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

const SCRIPT = resolve(__dirname, '../../scripts/generate-local-env.sh');

const STUB = `#!/bin/sh
if [ "\${1:-}" = "sts" ]; then
  exit 0
fi

if [ "\${1:-}" = "cognito-idp" ]; then
  echo "client"
  exit 0
fi

if [ "\${1:-}" = "cloudformation" ]; then
  case "$*" in
    *BackendProfileImageBucketName*) echo "bucket" ;;
    *BackendQueueUrl*) echo "queue" ;;
    *CognitoAuthUserPoolId*) echo "pool" ;;
    *CognitoAuthIdentityPoolId*) echo "identity" ;;
    *BackendApiEndpoint*)
      if [ "\${STUB_MISSING:-}" = "BackendApiEndpoint" ]; then
        echo "None"
      else
        echo "https://api.example.test/prod/"
      fi
      ;;
    *) echo "unexpected cloudformation query: $*" >&2; exit 1 ;;
  esac
  exit 0
fi

echo "unexpected aws call: $*" >&2
exit 1
`;

function runScript(missing?: string): { result: SpawnSyncReturns<string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tpm-local-env-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'backend'));
  mkdirSync(join(dir, 'frontend'));

  const aws = join(bin, 'aws');
  writeFileSync(aws, STUB);
  chmodSync(aws, 0o755);
  writeFileSync(join(dir, 'generate-local-env.sh'), readFileSync(SCRIPT));

  const env = {
    ...process.env,
    AWS_PROFILE: 'test',
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    ...(missing ? { STUB_MISSING: missing } : {}),
  };

  const result = spawnSync('bash', ['generate-local-env.sh'], { cwd: dir, env, encoding: 'utf8' });
  return { result, dir };
}

function readGenerated(dir: string, file: string): string {
  return readFileSync(join(dir, file), 'utf8');
}

describe('generate-local-env.sh', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('writes all three env files from the real output prefixes', () => {
    const { result, dir } = runScript();
    dirs.push(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Generated backend/.env frontend/.env frontend/.env.production');
    expect(readGenerated(dir, 'backend/.env')).toContain('PROFILE_IMAGE_BUCKET_NAME=bucket');
    expect(readGenerated(dir, 'backend/.env')).toContain('TPM_SQS_QUEUE_URL=queue');
    expect(readGenerated(dir, 'frontend/.env')).toContain('COGNITO_USER_POOL_ID=pool');
    expect(readGenerated(dir, 'frontend/.env')).toContain('COGNITO_CLIENT_ID=client');
    expect(readGenerated(dir, 'frontend/.env')).toContain('COGNITO_IDENTITY_POOL_ID=identity');
    expect(readGenerated(dir, 'frontend/.env.production')).toBe(
      'REACT_APP_GRAPHQL_ENDPOINT=https://api.example.test/prod/\n'
    );
  });

  test('fails instead of writing an empty endpoint when an output is missing', () => {
    const { result, dir } = runScript('BackendApiEndpoint');
    dirs.push(dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERROR: CloudFormation output starting with');
    expect(existsSync(join(dir, 'frontend/.env.production'))).toBe(false);
  });
});
