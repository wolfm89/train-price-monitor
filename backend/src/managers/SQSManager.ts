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

  // Journey refreshes are no longer queued: the hourly scan refreshes them
  // inline so the browser starts once per run instead of once per journey.
  // The queue is now used only for notification emails.
  async sendEmailNotificationMessage(userId: string, notificationId: string) {
    const graphqlMutation = `mutation ($userId: ID!, $notificationId: ID!) { sendEmailNotification(userId: $userId, notificationId: $notificationId) { id } }`;
    await this.sendSQSMessage(graphqlMutation, { userId, notificationId });
  }
}
