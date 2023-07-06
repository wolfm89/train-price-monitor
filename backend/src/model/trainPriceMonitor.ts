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

export default User;
