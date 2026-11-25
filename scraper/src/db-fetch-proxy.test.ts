import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { decodeProxyBody, isProxyThrottleError, isThrottled } from '../../shared/db-fetch.js';

test('decodes gzip and plain proxy bodies', () => {
  const text = '{"intervalle":[]}';
  const gzipped = gzipSync(Buffer.from(text, 'utf8')).toString('base64');
  assert.equal(decodeProxyBody('gzip', gzipped).toString('utf8'), text);
  assert.equal(decodeProxyBody(undefined, text).toString('utf8'), text);
});

test('classifies proxy throttle errors', () => {
  assert.equal(isProxyThrottleError('DB is throttling this environment (circuit breaker open)'), true);
  assert.equal(isProxyThrottleError('452 OPS_BLOCKED'), true);
  assert.equal(isProxyThrottleError('breaker open'), true);
  assert.equal(isProxyThrottleError('DB proxy failed: Unhandled'), false);
});

test('classifies throttling DB statuses', () => {
  assert.equal(isThrottled(429, ''), true);
  assert.equal(isThrottled(403, '{"code":"OPS_BLOCKED"}'), true);
  assert.equal(isThrottled(452, '{"code":"OPS_BLOCKED"}'), true);
  assert.equal(isThrottled(403, '{"error":"forbidden"}'), false);
  assert.equal(isThrottled(500, ''), false);
});
