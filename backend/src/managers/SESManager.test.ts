import assert from 'node:assert/strict';
import {
  AlreadyExistsException,
  BadRequestException,
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  DeleteSuppressedDestinationCommand,
  NotFoundException,
  TooManyRequestsException,
} from '@aws-sdk/client-sesv2';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import Logger from '../lib/logger';
import SESManager from './SESManager';

Logger.setLogLevel('SILENT');

const ADDRESS = 'jane.doe@example.com';

/** A stub client that records every command and fails with `failure`, if given. */
function managerWith(failure?: Error): { ses: SESManager; sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    send: async (command: unknown): Promise<object> => {
      sent.push(command);
      if (failure) throw failure;
      return {};
    },
  } as unknown as SESv2Client;
  return { ses: new SESManager(client), sent };
}

const notFound = new NotFoundException({ message: `Email address ${ADDRESS} does not exist`, $metadata: {} });
const badRequest = new BadRequestException({ message: `Identity ${ADDRESS} is invalid`, $metadata: {} });
const throttled = new TooManyRequestsException({ message: `Too many requests for ${ADDRESS}`, $metadata: {} });
const denied = Object.assign(new Error(`User is not authorized to remove ${ADDRESS}`), {
  name: 'AccessDeniedException',
});

async function assertSanitizedRejection(promise: Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, expected);
    // The SES message echoes the address; it must never reach the caller or the logs.
    assert.ok(!error.message.includes(ADDRESS));
    return true;
  });
}

async function main(): Promise<void> {
  // --- suppression list ---------------------------------------------------------
  const removed = managerWith();
  await removed.ses.removeSuppressedDestination(ADDRESS);
  assert.equal(removed.sent.length, 1);
  assert.ok(removed.sent[0] instanceof DeleteSuppressedDestinationCommand);
  assert.equal((removed.sent[0] as DeleteSuppressedDestinationCommand).input.EmailAddress, ADDRESS);

  // Nothing to remove: absent entry, or an address SES considers invalid.
  await managerWith(notFound).ses.removeSuppressedDestination(ADDRESS);
  await managerWith(badRequest).ses.removeSuppressedDestination(ADDRESS);

  // Anything else aborts the account deletion so that it can be retried.
  const suppressionFailure = 'The address could not be removed from the SES suppression list';
  await assertSanitizedRejection(managerWith(throttled).ses.removeSuppressedDestination(ADDRESS), suppressionFailure);
  await assertSanitizedRejection(managerWith(denied).ses.removeSuppressedDestination(ADDRESS), suppressionFailure);

  // --- recipient identity (sandbox) -----------------------------------------------
  const deleted = managerWith();
  await deleted.ses.deleteEmailIdentity(ADDRESS);
  assert.ok(deleted.sent[0] instanceof DeleteEmailIdentityCommand);
  assert.equal((deleted.sent[0] as DeleteEmailIdentityCommand).input.EmailIdentity, ADDRESS);

  await managerWith(notFound).ses.deleteEmailIdentity(ADDRESS);
  await managerWith(badRequest).ses.deleteEmailIdentity(ADDRESS);

  const identityFailure = 'The email identity could not be removed from SES';
  await assertSanitizedRejection(managerWith(throttled).ses.deleteEmailIdentity(ADDRESS), identityFailure);
  await assertSanitizedRejection(managerWith(denied).ses.deleteEmailIdentity(ADDRESS), identityFailure);

  // --- creating an identity never blocks signing in ---------------------------------
  const created = managerWith();
  await created.ses.createEmailIdentity(ADDRESS);
  assert.ok(created.sent[0] instanceof CreateEmailIdentityCommand);
  const exists = new AlreadyExistsException({ message: 'exists', $metadata: {} });
  assert.equal(await managerWith(exists).ses.createEmailIdentity(ADDRESS), undefined);
  assert.equal(await managerWith(throttled).ses.createEmailIdentity(ADDRESS), undefined);

  // --- sandbox switch ---------------------------------------------------------------
  const previous = process.env.SES_SANDBOX;
  try {
    delete process.env.SES_SANDBOX;
    assert.equal(managerWith().ses.sandbox, true);
    process.env.SES_SANDBOX = 'true';
    assert.equal(managerWith().ses.sandbox, true);
    process.env.SES_SANDBOX = 'false';
    assert.equal(managerWith().ses.sandbox, false);
  } finally {
    if (previous === undefined) delete process.env.SES_SANDBOX;
    else process.env.SES_SANDBOX = previous;
  }
}

main().then(
  () => process.stdout.write('SESManager checks passed\n'),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
);
