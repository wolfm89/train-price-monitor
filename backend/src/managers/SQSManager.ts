import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export class SQSManager {
  private sqs: SQSClient;
  private queueUrl: string;

  constructor(queueUrl: string) {
    this.sqs = new SQSClient({ region: process.env.AWS_REGION });
    this.queueUrl = queueUrl;
  }

  private async sendSQSMessage(graphqlMutation: string, variables: { [key: string]: unknown }) {
    const messageBody = JSON.stringify({
      query: graphqlMutation,
      variables: variables,
    });

    const params = {
      QueueUrl: this.queueUrl,
      MessageBody: messageBody,
    };

    await this.sqs.send(new SendMessageCommand(params));
  }

  async sendUpdateJourneyMessage(userId: string, journeyId: string): Promise<void> {
    const graphqlMutation = `mutation ($userId: ID!, $journeyId: ID!) { updateJourneyMonitor(userId: $userId, journeyId: $journeyId) { id } }`;
    await this.sendSQSMessage(graphqlMutation, { userId, journeyId });
  }

  async sendEmailNotificationMessage(userId: string, notificationId: string) {
    const graphqlMutation = `mutation ($userId: ID!, $notificationId: ID!) { sendEmailNotification(userId: $userId, notificationId: $notificationId) { id } }`;
    await this.sendSQSMessage(graphqlMutation, { userId, notificationId });
  }
}
