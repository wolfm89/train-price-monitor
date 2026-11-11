import {
  SESv2Client,
  SendEmailCommand,
  SendEmailCommandInput,
  SendEmailCommandOutput,
  CreateEmailIdentityCommand,
  CreateEmailIdentityRequest,
  CreateEmailIdentityCommandOutput,
  AlreadyExistsException,
  DeleteEmailIdentityCommand,
  DeleteEmailIdentityRequest,
  DeleteEmailIdentityCommandOutput,
  DeleteSuppressedDestinationCommand,
  NotFoundException,
} from '@aws-sdk/client-sesv2';
import { EmailNotificationInfo } from '../resolvers/notificationTypes';
import Logger from '../lib/logger';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

class SESManager {
  private ses: SESv2Client;

  /**
   * True while the SES account is in the sandbox, where every recipient has to
   * be a verified identity. Set by the stack (SES_SANDBOX); anything other than
   * "false" keeps the per-user identity workaround on.
   */
  readonly sandbox: boolean;

  constructor() {
    this.ses = new SESv2Client({ region: process.env.AWS_REGION });
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

  // Delete email identity in SES for deleted user (sandbox only)
  async deleteEmailIdentity(email: string): Promise<DeleteEmailIdentityCommandOutput | undefined> {
    const request: DeleteEmailIdentityRequest = {
      EmailIdentity: email,
    };
    try {
      return await this.ses.send(new DeleteEmailIdentityCommand(request));
    } catch (error) {
      Logger.error('Failed to delete recipient email identity', { error: errorName(error) });
      return undefined;
    }
  }

  /**
   * Removes a deleted user's address from the account-level suppression list,
   * where SES puts addresses after a hard bounce or a complaint. Absent entries
   * are the normal case.
   */
  async removeSuppressedDestination(email: string): Promise<void> {
    try {
      await this.ses.send(new DeleteSuppressedDestinationCommand({ EmailAddress: email }));
    } catch (error) {
      if (error instanceof NotFoundException) return;
      Logger.warn('Failed to remove the address from the SES suppression list', { error: errorName(error) });
    }
  }
}

export default SESManager;
