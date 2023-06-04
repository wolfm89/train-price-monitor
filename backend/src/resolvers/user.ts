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

export const userQuery: NonNullable<QueryResolvers['user']> = async (parent, args, context: GraphQLContext) => {
  const { Item: dbUser } = await context.entities.User.get({ id: args.id });
  if (!dbUser) {
    return null;
  }
  const user: User = {
    id: dbUser.id,
    givenName: dbUser.givenName,
    familyName: dbUser.familyName,
    email: dbUser.email,
    profilePicture: dbUser.profilePicture,
    activated: dbUser.activated,
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

  const { Attributes: dbUser } = await context.entities.User.update(
    { id: id, profilePicture: filename },
    { returnValues: 'ALL_NEW' }
  );
  if (!dbUser) {
    return null;
  }

  const user: User = {
    id: dbUser.id,
    givenName: dbUser.givenName,
    familyName: dbUser.familyName,
    email: dbUser.email,
    profilePicture: dbUser.profilePicture,
    activated: dbUser.activated,
  };
  return user;
};

export const createUser: NonNullable<MutationResolvers['createUser']> = async (
  _,
  { id, givenName, familyName, email }: { id: string; givenName: string; familyName: string; email: string },
  context: GraphQLContext
) => {
  await context.entities.User.put({
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

export const activateUser: NonNullable<MutationResolvers['activateUser']> = async (
  _,
  { id }: { id: string },
  context: GraphQLContext
) => {
  const { Attributes: dbUser } = await context.entities.User.update(
    { id: id, activated: true },
    { returnValues: 'ALL_NEW' }
  );

  if (!dbUser) {
    return null;
  }

  const user: User = {
    id: dbUser.id,
    givenName: dbUser.givenName,
    familyName: dbUser.familyName,
    email: dbUser.email,
    profilePicture: dbUser.profilePicture,
    activated: dbUser.activated,
  };
  return user;
};
