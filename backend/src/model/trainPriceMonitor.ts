import { Table, Entity } from 'dynamodb-toolbox';

const TrainPriceMonitorTable = new Table({
  name: 'TrainPriceMonitor',
  partitionKey: 'pk',
  sortKey: 'sk',
});

const User = new Entity({
  name: 'User',
  table: TrainPriceMonitorTable,
  attributes: {
    id: { partitionKey: true, type: 'string', prefix: 'USER#' },
    sk: {
      sortKey: true,
      type: 'string',
      hidden: true,
      prefix: 'METADATA#',
      default: (data: { id: string }) => data.id,
    },
    email: { type: 'string', required: true },
    givenName: { type: 'string', required: true },
    familyName: { type: 'string', required: true },
    profilePicture: { type: 'string' },
    activated: { type: 'boolean', required: true, default: false },
  },
} as const);

const Notification = new Entity({
  name: 'Notification',
  table: TrainPriceMonitorTable,
  attributes: {
    userId: { partitionKey: true, type: 'string', prefix: 'USER#' },
    id: {
      sortKey: true,
      type: 'string',
      prefix: 'NOTIFICATION#',
    },
    journeyId: { type: 'string' },
    message: { type: 'string', required: true },
    timestamp: { type: 'string', required: true },
    read: { type: 'boolean', required: true, default: false },
  },
} as const);

const Journey = new Entity({
  name: 'Journey',
  table: TrainPriceMonitorTable,
  attributes: {
    userId: { partitionKey: true, type: 'string', prefix: 'USER#' },
    id: {
      sortKey: true,
      type: 'string',
      prefix: 'JOURNEY#',
    },
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    departure: { type: 'string', required: true },
    arrival: { type: 'string', required: true },
    means: { type: 'list', required: true },
    price: { type: 'number', required: true },
    limitPrice: { type: 'number', required: true },
    refreshToken: { type: 'string', required: true },
  },
} as const);

export { User, Notification, Journey };
