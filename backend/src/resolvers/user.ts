import { GraphQLContext } from '../context';
import Logger from '../lib/logger';
import { MutationResolvers, QueryResolvers, UserResolvers } from '../schema/generated/resolvers.generated';
import { User, PresignedUrl } from '../schema/generated/typeDefs.generated';

const profileImageBucketName = process.env.PROFILE_IMAGE_BUCKET_NAME;

if (!profileImageBucketName) {
  throw new Error('PROFILE_IMAGE_BUCKET_NAME is not defined in process.env');
}

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

export const userProfilePicturePresignedUrlQuery: NonNullable<
  QueryResolvers['userProfilePicturePresignedUrl']
> = async (_, { id }: { id: string }, context: GraphQLContext) => {
  const { Item: dbUser } = await context.entities.User.get({ id: id });
  let url: string | undefined = undefined;
  if (dbUser?.profilePicture) {
    // get presigned url for file dbUser?.profilePicture in bucket profileImageBucketName
    url = await context.s3.getPresignedUrl(profileImageBucketName, dbUser?.profilePicture);
  }
  const presignedUrl: PresignedUrl = {
    id: id,
    url: url,
  };
  return presignedUrl;
};

export const updateUserProfilePicture: NonNullable<MutationResolvers['updateUserProfilePicture']> = async (
  _,
  { id, image }: { id: string; image: File },
  context: GraphQLContext
) => {
  const { Item: dbUserCur } = await context.entities.User.get({ id: id });
  const filename = `${id}.${image.name.split('.').pop()}`;

  // Upload file to S3 bucket
  await context.s3.upload(profileImageBucketName, filename, image);

  // Delete previous image
  if (dbUserCur && dbUserCur.profilePicture && dbUserCur.profilePicture != filename) {
    Logger.info(`'Deleting previous profile image for user '${id}'`);
    await context.s3.deleteFilesWithPrefix(profileImageBucketName, dbUserCur.profilePicture);
  }

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
