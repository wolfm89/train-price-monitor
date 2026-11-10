import assert from 'node:assert/strict';
import { GraphQLError } from 'graphql';
import { buildDataExport } from './dataExport';
import { corsHeaders, parseAllowedOrigins, requestOrigin } from './cors';
import { MAX_PROFILE_PICTURE_BYTES, validateProfilePicture } from './profilePicture';
import { redactEmails } from './redact';
import { JOURNEY_TTL_MARGIN_DAYS, NOTIFICATION_RETENTION_DAYS, journeyTtl, notificationTtl } from './retention';

const DAY = 24 * 60 * 60;

// --- retention ---------------------------------------------------------------

const created = new Date('2026-11-01T00:00:00Z');
const createdSeconds = created.getTime() / 1000;
assert.equal(notificationTtl(created), createdSeconds + NOTIFICATION_RETENTION_DAYS * DAY);
assert.equal(
  journeyTtl(new Date('2026-12-01T10:00:00Z')),
  new Date('2026-12-01T10:00:00Z').getTime() / 1000 + JOURNEY_TTL_MARGIN_DAYS * DAY
);
// A notification about a journey lives at least as long as the journey.
const lateJourney = new Date('2027-06-01T00:00:00Z');
assert.equal(notificationTtl(created, lateJourney), journeyTtl(lateJourney));
assert.equal(notificationTtl(created, new Date('2026-11-05T00:00:00Z')), notificationTtl(created));

// --- profile picture validation ---------------------------------------------

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
assert.deepEqual(validateProfilePicture(png), { contentType: 'image/png', extension: 'png' });
assert.deepEqual(validateProfilePicture(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), {
  contentType: 'image/jpeg',
  extension: 'jpg',
});
assert.deepEqual(validateProfilePicture(new TextEncoder().encode('GIF89a...')), {
  contentType: 'image/gif',
  extension: 'gif',
});

function assertRejected(body: Uint8Array): void {
  assert.throws(
    () => validateProfilePicture(body),
    (error: unknown) => error instanceof GraphQLError && error.extensions.code === 'BAD_USER_INPUT'
  );
}
// An SVG or HTML file renamed to .png is rejected: the bytes decide, not the name.
assertRejected(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
assertRejected(new Uint8Array());
const tooLarge = new Uint8Array(MAX_PROFILE_PICTURE_BYTES + 1);
tooLarge.set(png);
assertRejected(tooLarge);

// --- CORS --------------------------------------------------------------------

assert.deepEqual(parseAllowedOrigins(' https://tpm.example.com , http://localhost:3000 '), [
  'https://tpm.example.com',
  'http://localhost:3000',
]);
assert.deepEqual(parseAllowedOrigins(undefined), ['http://localhost:3000', 'http://127.0.0.1:3000']);
assert.equal(requestOrigin({ Origin: 'https://tpm.example.com' }), 'https://tpm.example.com');
assert.equal(requestOrigin({ origin: 'https://tpm.example.com' }), 'https://tpm.example.com');
assert.equal(requestOrigin(null), undefined);

const allowed = ['https://tpm.example.com'];
assert.equal(corsHeaders('https://tpm.example.com', allowed)['Access-Control-Allow-Origin'], 'https://tpm.example.com');
assert.equal(corsHeaders('https://evil.example', allowed)['Access-Control-Allow-Origin'], undefined);
assert.equal(corsHeaders(undefined, allowed)['Access-Control-Allow-Origin'], undefined);
assert.equal(corsHeaders('https://evil.example', allowed).Vary, 'Origin');

// --- log redaction ------------------------------------------------------------

assert.equal(
  redactEmails(
    'Email address is not verified. The following identities failed the check in region EU-CENTRAL-1: Jane.Doe+tpm@Example.co.uk'
  ),
  'Email address is not verified. The following identities failed the check in region EU-CENTRAL-1: [email]'
);
assert.equal(redactEmails('<a@b.de>, "c@d.com"'), '<[email]>, "[email]"');
assert.equal(redactEmails('no address here'), 'no address here');

// --- data export ----------------------------------------------------------------

const exported = JSON.parse(
  buildDataExport({
    user: {
      id: 'u1',
      email: 'jane@example.com',
      givenName: 'Jane',
      loyaltyCards: JSON.stringify([{ type: 'BAHNCARD', discount: 25, class: 2 }]),
      profilePicture: 'u1.png',
    },
    journeys: [
      { id: 'j2', departure: '2026-12-02T10:00:00.000Z', cachedMeans: '["ICE 1"]', ttl: 1_800_000_000 },
      { id: 'j1', departure: '2026-12-01T10:00:00.000Z', loyaltyCard: 'not json' },
    ],
    notifications: [{ id: 'n1', timestamp: '2026-11-01T00:00:00.000Z', data: '{"journeyId":"j1"}' }],
    profilePictureUrl: 'https://bucket.example/u1.png?signature',
    exportedAt: new Date('2026-11-11T12:00:00Z'),
  })
);
assert.equal(exported.exportedAt, '2026-11-11T12:00:00.000Z');
assert.deepEqual(exported.account.loyaltyCards, [{ type: 'BAHNCARD', discount: 25, class: 2 }]);
assert.deepEqual(exported.profilePicture, {
  file: 'u1.png',
  temporaryDownloadUrl: 'https://bucket.example/u1.png?signature',
});
assert.deepEqual(
  exported.journeyMonitors.map((journey: { id: string }) => journey.id),
  ['j1', 'j2']
);
// Unparseable JSON is exported as stored rather than dropped.
assert.equal(exported.journeyMonitors[0].loyaltyCard, 'not json');
assert.deepEqual(exported.journeyMonitors[1].cachedMeans, ['ICE 1']);
assert.equal(exported.journeyMonitors[1].ttl, undefined);
assert.equal(exported.journeyMonitors[1].scheduledDeletion, new Date(1_800_000_000 * 1000).toISOString());
assert.deepEqual(exported.notifications[0].data, { journeyId: 'j1' });

const withoutPicture = JSON.parse(
  buildDataExport({ user: { id: 'u2' }, journeys: [], notifications: [], exportedAt: new Date(0) })
);
assert.equal(withoutPicture.profilePicture, null);

process.stdout.write('privacy checks passed\n');
