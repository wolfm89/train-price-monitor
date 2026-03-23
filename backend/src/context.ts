import { Cache } from '@graphql-yoga/plugin-response-cache';
import { User, Notification, Journey, TrainPriceMonitorTable } from './model/trainPriceMonitor';
import { S3Manager } from './managers/S3Manager';
import { DbHafasManager } from './managers/DbHafasManager';
import dotenv from 'dotenv';
import { SQSManager } from './managers/SQSManager';
import SESManager from './managers/SESManager';

dotenv.config();
const TPM_SQS_QUEUE_URL = process.env.TPM_SQS_QUEUE_URL;

if (!TPM_SQS_QUEUE_URL) {
  throw new Error('TPM_SQS_QUEUE_URL is not defined in process.env');
}

const s3 = new S3Manager();
const sqs = new SQSManager(TPM_SQS_QUEUE_URL);
const ses = new SESManager();
const dbHafas = new DbHafasManager();

type Entities = {
  User: typeof User;
  Notification: typeof Notification;
  Journey: typeof Journey;
  TrainPriceMonitorTable: typeof TrainPriceMonitorTable;
};

export type GraphQLContext = {
  cache: Cache;
  entities: Entities;
  s3: S3Manager;
  sqs: SQSManager;
  ses: SESManager;
  dbHafas: DbHafasManager;
};

export async function createContext(cache: Cache): Promise<GraphQLContext> {
  return { cache, entities: { User, Notification, Journey, TrainPriceMonitorTable }, s3, sqs, ses, dbHafas };
}
