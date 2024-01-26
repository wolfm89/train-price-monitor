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
    familyName: { type: 'string' },
    profilePicture: { type: 'string' },
    emailNotificationsEnabled: { type: 'boolean', required: true, default: true },
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
    type: { type: 'string', required: true },
    timestamp: { type: 'string', required: true },
    read: { type: 'boolean', required: true, default: false },
    sent: { type: 'boolean', required: true, default: false },
    data: { type: 'map' },
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
    limitPrice: { type: 'number', required: true },
    refreshToken: { type: 'string', required: true },
    expires: { type: 'string', required: true },
  },
} as const);

export { User, Notification, Journey };
