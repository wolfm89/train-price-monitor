import {
  SESv2Client,
  SendEmailCommand,
  SendEmailCommandInput,
  SendEmailCommandOutput,
  CreateEmailIdentityCommand,
  CreateEmailIdentityRequest,
  CreateEmailIdentityCommandOutput,
} from '@aws-sdk/client-sesv2';
import { EmailNotificationInfo } from '../resolvers/notificationTypes';

class SESManager {
  private ses: SESv2Client;
  private from: string = 'trainpricemonitor@wolfgangmoser.eu';

  constructor() {
    this.ses = new SESv2Client({ region: process.env.AWS_REGION });
  }

  private createEmail(to: string, subject: string, htmlBody: string): SendEmailCommand {
    const input: SendEmailCommandInput = {
      FromEmailAddress: this.from,
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

  // Create email identity in SES for new user
  async createEmailIdentity(email: string): Promise<CreateEmailIdentityCommandOutput> {
    const request: CreateEmailIdentityRequest = {
      EmailIdentity: email,
    };
    return await this.ses.send(new CreateEmailIdentityCommand(request));
  }
}

export default SESManager;
