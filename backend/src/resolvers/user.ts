import { GraphQLContext } from '../context';
import { MutationResolvers, QueryResolvers, UserResolvers } from '../schema/generated/resolvers.generated';
import { User } from '../schema/generated/typeDefs.generated';

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
  const dbUser = await context.dynamodb.get(USERS_TABLE, { id: { S: args.id } });
  if (!dbUser) {
    return null;
  }
  const user: User = {
    id: dbUser.id.S || args.id,
    givenName: dbUser.givenName.S || '',
    familyName: dbUser.familyName.S || '',
    email: dbUser.email.S || '',
    profilePicture: dbUser.profilePicture?.S,
    activated: dbUser.activated.BOOL || false,
  };
  return user;
};

export const updateUserProfilePicture: NonNullable<MutationResolvers['updateUserProfilePicture']> = async (
  _,
  { id, image }: { id: string; image: File },
  context: GraphQLContext
) => {
  const profileImageBucketName = process.env.PROFILE_IMAGE_BUCKET_NAME!;
  const filename = `${id}.${image.name.split('.').pop()}`;

  // Upload file to S3 bucket
  await context.s3.upload(profileImageBucketName, filename, image);

  const dbUser = await context.dynamodb.update(USERS_TABLE, { id: { S: id } }, { profilePicture: { S: filename } });
  if (!dbUser) {
    return null;
  }

  const user: User = {
    id: dbUser.id.S || id,
    givenName: dbUser.givenName.S || '',
    familyName: dbUser.familyName.S || '',
    email: dbUser.email.S || '',
    profilePicture: dbUser.profilePicture?.S,
    activated: dbUser.activated.BOOL || false,
  };
  return user;
};

export const createUser: NonNullable<MutationResolvers['createUser']> = async (
  _,
  { id, givenName, familyName, email }: { id: string; givenName: string; familyName: string; email: string },
  context: GraphQLContext
) => {
  await context.dynamodb.put(USERS_TABLE, {
    id: { S: id },
    givenName: { S: givenName },
    familyName: { S: familyName },
    email: { S: email },
    activated: { BOOL: false },
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

export const activateUser: NonNullable<MutationResolvers['activateUser']> = async (
  _,
  { id }: { id: string },
  context: GraphQLContext
) => {
  const dbUser = await context.dynamodb.update(USERS_TABLE, { id: { S: id } }, { activated: { BOOL: true } });
  const user: User = {
    id: dbUser.id.S || id,
    givenName: dbUser.givenName.S || '',
    familyName: dbUser.familyName.S || '',
    email: dbUser.email.S || '',
    profilePicture: dbUser.profilePicture?.S,
    activated: dbUser.activated.BOOL || false,
  };
  return user;
};
