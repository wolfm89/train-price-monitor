import {
  SESv2Client,
  SendEmailCommand,
  SendEmailCommandInput,
  SendEmailCommandOutput,
  CreateEmailIdentityCommand,
  CreateEmailIdentityRequest,
  CreateEmailIdentityCommandOutput,
  AlreadyExistsException,
  BadRequestException,
  DeleteEmailIdentityCommand,
  DeleteSuppressedDestinationCommand,
  NotFoundException,
} from '@aws-sdk/client-sesv2';
import { EmailNotificationInfo } from '../resolvers/notificationTypes';
import Logger from '../lib/logger';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * SES answers a delete with NotFoundException when the entry is absent, and with
 * BadRequestException when it considers the address itself invalid (for example
 * a non-ASCII local part that Cognito still accepted). Such an address cannot be
 * an identity or on the suppression list, so there is nothing left to remove.
 */
function nothingToRemove(error: unknown): boolean {
  return error instanceof NotFoundException || error instanceof BadRequestException;
}

/**
 * Logs only the error name, because SES messages echo the address back, and
 * returns a generic error for the caller to throw.
 */
function sanitizedFailure(message: string, error: unknown): Error {
  Logger.error(message, { error: errorName(error) });
  return new Error(message);
}

class SESManager {
  private readonly ses: Pick<SESv2Client, 'send'>;

  /**
   * True while the SES account is in the sandbox, where every recipient has to
   * be a verified identity. Set by the stack (SES_SANDBOX); anything other than
   * "false" keeps the per-user identity workaround on.
   */
  readonly sandbox: boolean;

  constructor(client: Pick<SESv2Client, 'send'> = new SESv2Client({ region: process.env.AWS_REGION })) {
    this.ses = client;
    this.sandbox = process.env.SES_SANDBOX !== 'false';
  }

  private createEmail(to: string, subject: string, htmlBody: string): SendEmailCommand {
    const input: SendEmailCommandInput = {
      FromEmailAddress: process.env.SES_FROM_EMAIL || 'noreply@example.com',
      Destination: {
        ToAddresses: [to],
      },
      Content: {
        Simple: {
          Subject: {
            Data: subject,
          },
          Body: {
            Html: {
              Data: htmlBody,
            },
          },
        },
      },
    };
    return new SendEmailCommand(input);
  }

  private async sendEmail(command: SendEmailCommand): Promise<SendEmailCommandOutput> {
    return await this.ses.send(command);
  }

  async sendEmailNotification(emailNotificationInfo: EmailNotificationInfo): Promise<SendEmailCommandOutput> {
    const command = this.createEmail(
      emailNotificationInfo.to,
      emailNotificationInfo.subject,
      emailNotificationInfo.htmlBody
    );
    return await this.sendEmail(command);
  }

  // Create email identity in SES for new user (sandbox only)
  async createEmailIdentity(email: string): Promise<CreateEmailIdentityCommandOutput | undefined> {
    const request: CreateEmailIdentityRequest = {
      EmailIdentity: email,
    };
    try {
      return await this.ses.send(new CreateEmailIdentityCommand(request));
    } catch (error) {
      // Only the error name: SES messages can echo the address back.
      if (error && error instanceof AlreadyExistsException) {
        Logger.info('Recipient email identity already exists');
      } else {
        Logger.warn('Failed to create recipient email identity', { error: errorName(error) });
      }
      return undefined;
    }
  }

  /**
   * Deletes the user's email identity in SES (sandbox only). A missing identity
   * is fine; any other failure throws, so the account deletion stops before the
   * user row is removed and can be retried.
   */
  async deleteEmailIdentity(email: string): Promise<void> {
    try {
      await this.ses.send(new DeleteEmailIdentityCommand({ EmailIdentity: email }));
    } catch (error) {
      if (nothingToRemove(error)) return;
      throw sanitizedFailure('The email identity could not be removed from SES', error);
    }
  }

  /**
   * Removes a deleted user's address from the account-level suppression list,
   * where SES puts addresses after a hard bounce or a complaint. An absent entry
   * is the normal case; any other failure throws, so the account deletion stops
   * before the user row is removed (nothing could find the entry afterwards) and
   * can be retried.
   */
  async removeSuppressedDestination(email: string): Promise<void> {
    try {
      await this.ses.send(new DeleteSuppressedDestinationCommand({ EmailAddress: email }));
    } catch (error) {
      if (nothingToRemove(error)) return;
      throw sanitizedFailure('The address could not be removed from the SES suppression list', error);
    }
  }
}

export default SESManager;
