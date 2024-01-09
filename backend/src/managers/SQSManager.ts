import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export class SQSManager {
  private sqs: SQSClient;
  private queueUrl: string;

  constructor(queueUrl: string) {
    this.sqs = new SQSClient({ region: process.env.AWS_REGION });
    this.queueUrl = queueUrl;
  }

  async sendUpdateJourneyMessage(userId: string, journeyId: string): Promise<void> {
    const graphqlMutation = `mutation ($userId: ID!, $journeyId: ID!) { updateJourneyMonitor(userId: $userId, journeyId: $journeyId) { id } }`;

    const messageBody = JSON.stringify({
      query: graphqlMutation,
      variables: { userId, journeyId },
    });

    const params = {
      QueueUrl: this.queueUrl,
      MessageBody: messageBody,
    };

    await this.sqs.send(new SendMessageCommand(params));
  }
}
