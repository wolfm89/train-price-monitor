import test from 'node:test';
import assert from 'node:assert/strict';
import { maskEmail, planIdentityCleanup } from './cleanup-ses-identities-lib.mjs';

test('deletes only email identities without a current user', () => {
  const identities = [
    { IdentityName: 'wolfgangmoser.eu', IdentityType: 'DOMAIN' },
    { IdentityName: 'trainpricemonitor@wolfgangmoser.eu', IdentityType: 'EMAIL_ADDRESS' },
    { IdentityName: 'current@example.com', IdentityType: 'EMAIL_ADDRESS' },
    { IdentityName: 'Mixed.Case@Example.com', IdentityType: 'EMAIL_ADDRESS' },
    { IdentityName: 'deleted@example.com', IdentityType: 'EMAIL_ADDRESS' },
  ];

  const plan = planIdentityCleanup(
    identities,
    ['current@example.com', 'mixed.case@example.com', undefined],
    ['trainpricemonitor@wolfgangmoser.eu']
  );

  assert.deepEqual(plan, { toDelete: ['deleted@example.com'], kept: 3 });
});

test('masks addresses in the output', () => {
  assert.equal(maskEmail('jane.doe@example.com'), 'j***@example.com');
  assert.equal(maskEmail('not-an-address'), '***');
});
