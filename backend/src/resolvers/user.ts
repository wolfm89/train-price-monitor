import { DynamoDB } from 'aws-sdk';
import { GraphQLContext } from '../context';
import { MutationResolvers, QueryResolvers, UserResolvers } from '../schema/generated/resolvers.generated';
import { User } from '../schema/generated/typeDefs.generated';
import { v4 as uuidv4 } from 'uuid';

export const userResolvers: UserResolvers = {
  id: (parent) => parent.id,
  givenName: (parent) => parent.givenName,
  familyName: (parent) => parent.familyName,
  email: (parent) => parent.email,
  profilePicture: (parent) => parent.profilePicture,
  activated: (parent) => parent.activated,
};

const USERS_TABLE = 'users';

export const userQuery: NonNullable<QueryResolvers['user']> = async (parent, args, context: GraphQLContext) => {
  const dbUser = await context.dynamodb.get(USERS_TABLE, args.id);
  if (!dbUser) {
    return null;
  }
  const user: User = {
    id: dbUser.id.S || args.id,
    givenName: dbUser.givenName.S || '',
    familyName: dbUser.familyName.S || '',
    email: dbUser.email.S || '',
    profilePicture: dbUser.profilePicture.S,
    activated: dbUser.activated.BOOL || false,
  };
  return user;
};

export const updateProfilePicture: NonNullable<MutationResolvers['updateProfilePicture']> = async (
  _,
  { userId, image }: { userId: string; image: File }
) => {
  const user: User = {
    id: userId,
    givenName: 'Bart',
    familyName: 'Simpsons',
    email: 'bart@simpsons.com',
    profilePicture: image.name,
    activated: false,
  };
  return user;
};

export const createUser: NonNullable<MutationResolvers['createUser']> = async (
  _,
  { givenName, familyName, email }: { givenName: string; familyName: string; email: string },
  context: GraphQLContext
) => {
  const id = uuidv4();
  await context.dynamodb.put(USERS_TABLE, {
    id: id,
    givenName: givenName,
    familyName: familyName,
    email: email,
    activated: false,
  });
  const user: User = {
    id: id,
    givenName: givenName,
    familyName: familyName,
    email: email,
    activated: false,
  };
  return user;
};
