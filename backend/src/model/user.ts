import { Table, Entity } from 'dynamodb-toolbox';

const UsersTable = new Table({
  name: 'users',
  partitionKey: 'id',
});

const User = new Entity({
  name: 'User',
  attributes: {
    id: { partitionKey: true, type: 'string' },
    email: { type: 'string', required: true },
    givenName: { type: 'string', required: true },
    familyName: { type: 'string', required: true },
    profilePicture: { type: 'string' },
    activated: { type: 'boolean', required: true, default: false },
  },

  table: UsersTable,
} as const);

export default User;
