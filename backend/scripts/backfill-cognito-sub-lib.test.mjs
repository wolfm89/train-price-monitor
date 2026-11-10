import test from 'node:test';
import assert from 'node:assert/strict';
import { planBindings } from './backfill-cognito-sub-lib.mjs';

function user(username, attributes) {
  return {
    Username: username,
    Attributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })),
  };
}

function row(attributes) {
  return { ...attributes };
}

function rows(...entries) {
  return new Map(entries.map(([customId, item]) => [customId, item]));
}

test('unique custom:id with matching email is planned for binding', () => {
  const users = [
    user('wolfgang', {
      sub: 'sub-1',
      'custom:id': 'custom-1',
      email: 'Wolfgang@Example.com',
      given_name: 'Wolfgang',
      family_name: 'Moser',
    }),
  ];
  const plan = planBindings(
    users,
    rows(['custom-1', row({ email: 'wolfgang@example.com', givenName: 'Wolfgang', familyName: 'Moser' })])
  );

  assert.equal(plan.bindings.length, 1);
  assert.equal(plan.bindings[0].sub, 'sub-1');
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.ambiguous.length, 0);
});

test('a custom:id shared by two Cognito users is ambiguous and bound to neither', () => {
  const users = [
    user('attacker', { sub: 'sub-attacker', 'custom:id': 'shared', email: 'attacker@example.com' }),
    user('victim', { sub: 'sub-victim', 'custom:id': 'shared', email: 'victim@example.com' }),
  ];
  const plan = planBindings(users, rows(['shared', row({ email: 'victim@example.com' })]));

  assert.equal(plan.bindings.length, 0);
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.ambiguous[0].users.length, 2);
});

test('a matching custom:id but different email is a conflict, not a binding', () => {
  const users = [user('attacker', { sub: 'sub-attacker', 'custom:id': 'victim-id', email: 'attacker@example.com' })];
  const plan = planBindings(users, rows(['victim-id', row({ email: 'victim@example.com' })]));

  assert.equal(plan.bindings.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /email\/name mismatch/);
});

test('a matching email but different immutable name is a conflict', () => {
  const users = [
    user('attacker', {
      sub: 'sub-attacker',
      'custom:id': 'victim-id',
      email: 'victim@example.com',
      given_name: 'Attacker',
    }),
  ];
  const plan = planBindings(
    users,
    rows(['victim-id', row({ email: 'victim@example.com', givenName: 'Victim', familyName: 'Moser' })])
  );

  assert.equal(plan.bindings.length, 0);
  assert.equal(plan.conflicts.length, 1);
});

test('an already bound row with the same sub is not rebound', () => {
  const users = [user('wolfgang', { sub: 'sub-1', 'custom:id': 'custom-1', email: 'wolfgang@example.com' })];
  const plan = planBindings(users, rows(['custom-1', row({ email: 'wolfgang@example.com', cognitoSub: 'sub-1' })]));

  assert.equal(plan.bindings.length, 0);
  assert.equal(plan.alreadyBound.length, 1);
});

test('an already bound row with a different sub is a conflict', () => {
  const users = [user('wolfgang', { sub: 'sub-1', 'custom:id': 'custom-1', email: 'wolfgang@example.com' })];
  const plan = planBindings(users, rows(['custom-1', row({ email: 'wolfgang@example.com', cognitoSub: 'sub-2' })]));

  assert.equal(plan.bindings.length, 0);
  assert.equal(plan.conflicts.length, 1);
});

test('a Cognito user without a matching User row is reported as missing', () => {
  const users = [user('wolfgang', { sub: 'sub-1', 'custom:id': 'custom-1', email: 'wolfgang@example.com' })];
  const plan = planBindings(users, new Map());

  assert.equal(plan.bindings.length, 0);
  assert.equal(plan.missingRow.length, 1);
});

test('users missing a sub or custom:id are skipped', () => {
  const users = [user('no-sub', { 'custom:id': 'custom-1', email: 'a@example.com' }), user('no-id', { sub: 'sub-2' })];
  const plan = planBindings(users, new Map());

  assert.equal(plan.bindings.length, 0);
  assert.equal(plan.skipped.length, 2);
});
