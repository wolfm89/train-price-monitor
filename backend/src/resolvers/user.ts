import dotenv from 'dotenv';
import { GraphQLContext } from '../context';
import Logger from '../lib/logger';
import { sort } from '../lib/sort';
import { MutationResolvers, QueryResolvers, UserResolvers } from '../schema/generated/resolvers.generated';
import { User, PresignedUrl, Notification, JourneyMonitor } from '../schema/generated/typeDefs.generated';
import { getMeans } from './journey';
import { NOTIFICATION_TYPES } from './notificationTypes';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

dotenv.config(); // Load environment variables from .env file

const profileImageBucketName = process.env.PROFILE_IMAGE_BUCKET_NAME;

if (!profileImageBucketName) {
  throw new Error('PROFILE_IMAGE_BUCKET_NAME is not defined in process.env');
}

export const userResolvers: UserResolvers = {
  notifications: async (parent, args, context: GraphQLContext): Promise<Notification[]> => {
    let notifications: Notification[] | undefined = undefined;
    const filters = [
      { attr: 'userId', eq: `USER#${parent.id}` },
      { attr: 'id', beginsWith: 'NOTIFICATION#' },
    ];
    if (args.read !== undefined) {
      filters.push({ attr: 'read', eq: args.read });
    }
    const { Items: dbNotifications } = await context.entities.Notification.scan({
      filters,
    });
    if (!dbNotifications) {
      return [];
    }

    notifications = await Promise.all(
      dbNotifications.map(async (dbNotification) => {
        return {
          id: dbNotification.id,
          userId: dbNotification.userId,
          type: dbNotification.type,
          timestamp: new Date(dbNotification.timestamp),
          read: dbNotification.read,
          sent: dbNotification.sent,
          ...(await NOTIFICATION_TYPES[dbNotification.type].mapAdditionalData(
            context,
            dbNotification.userId,
            dbNotification.data
          )),
        };
      })
    );
    if (notifications) {
      sort(notifications, '-timestamp');
      if (args.limit !== undefined) {
        notifications = notifications.slice(0, args.limit);
      }
      return notifications;
    }
    return [];
  },
  journeyMonitors: async (parent, args, context: GraphQLContext): Promise<JourneyMonitor[]> => {
    Logger.addPersistentLogAttributes({ userId: parent.id });
    let journeys: JourneyMonitor[];
    const { Items: dbJourneys } = await context.entities.Journey.query(`USER#${parent.id}`, {
      beginsWith: 'JOURNEY#',
    });
    if (!dbJourneys) {
      return [];
    }
    journeys = await Promise.all(
      dbJourneys.map(async (dbJourney) => {
        return await getJourneyMonitor(context, dbJourney);
      })
    );
    if (journeys) {
      journeys.sort(
        (a: JourneyMonitor, b: JourneyMonitor) =>
          (a.journey ? a.journey.departure.getTime() : Infinity) -
          (b.journey ? b.journey.departure.getTime() : Infinity)
      );

      if (args.limit !== undefined) {
        journeys = journeys.slice(0, args.limit);
      }
      return journeys;
    }
    return [];
  },
};

export const userQuery: NonNullable<QueryResolvers['user']> = async (parent, args, context): Promise<User> => {
  const { Item: dbUser } = await context.entities.User.get({ id: args.id });
  if (!dbUser) {
    throw new Error('User not found in database');
  }
  return dbUser as User;
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

  try {
    // Upload file to S3 bucket
    await context.s3.upload(profileImageBucketName, filename, image);
  } catch (error) {
    Logger.error(`Failed to upload file to S3: ${error}`);
    throw error;
  }

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
  context.cache.invalidate([{ typename: 'User' }, { typename: 'PresignedUrl' }]);

  const user: User = { ...dbUser };
  return user;
};

export const createUser: NonNullable<MutationResolvers['createUser']> = async (
  _,
  { id, givenName, familyName, email }: { id: string; givenName: string; familyName?: string; email: string },
  context: GraphQLContext
) => {
  try {
    await context.entities.User.put(
      {
        id: id,
        givenName: givenName,
        familyName: familyName!,
        email: email,
      },
      { conditions: { attr: 'id', exists: false } }
    );
  } catch (error) {
    if (error && error instanceof ConditionalCheckFailedException) {
      Logger.info(`User with id ${id} already exists`);
      throw Error('User already exists');
    }
    Logger.error(`Failed to create user with id ${id}: ${error}`);
    throw error;
  }

  // Only necessary when using SES in sandbox mode
  context.ses.createEmailIdentity(email);

  const user: User = {
    id: id,
    givenName: givenName,
    familyName: familyName,
    email: email,
    emailNotificationsEnabled: true,
  };
  context.cache.invalidate([{ typename: 'User' }]);
  return user;
};

export const updateUserSettings: NonNullable<MutationResolvers['updateUserSettings']> = async (
  _,
  { id, emailNotificationsEnabled }: { id: string; emailNotificationsEnabled: boolean },
  context: GraphQLContext
) => {
  try {
    const { Attributes: dbUser } = await context.entities.User.update(
      { id: id, emailNotificationsEnabled: emailNotificationsEnabled },
      { returnValues: 'ALL_NEW' }
    );

    if (!dbUser) {
      throw new Error('Failed to update user property');
    }
    context.cache.invalidate([{ typename: 'User' }]);

    return dbUser as User;
  } catch (error) {
    Logger.error(`Failed to update user with id ${id}: ${error}`);
    throw error;
  }
};

export const deleteUser: NonNullable<MutationResolvers['deleteUser']> = async (
  _,
  { id }: { id: string },
  context: GraphQLContext
): Promise<User> => {
  try {
    Logger.addPersistentLogAttributes({ userId: id });

    const { Item: dbUserCur } = await context.entities.User.get(
      { id: id },
      { attributes: ['profilePicture', 'email'] }
    );

    // Delete profile picture from S3 bucket
    if (dbUserCur && dbUserCur.profilePicture) {
      Logger.info(`Deleting profile image for user '${id}'`);
      await context.s3.deleteFilesWithPrefix(profileImageBucketName, dbUserCur.profilePicture);
    }

    // Delete database entries related to user
    // Delete notifications
    const { Items: dbNotifications } = await context.entities.Notification.query(`USER#${id}`, {
      beginsWith: 'NOTIFICATION#',
    });
    if (dbNotifications) {
      await Promise.all(
        dbNotifications.map(async (dbNotification) => {
          await context.entities.Notification.delete({ userId: id, id: dbNotification.id });
        })
      );
    }
    // Delete journeys
    const { Items: dbJourneys } = await context.entities.Journey.query(`USER#${id}`, {
      beginsWith: 'JOURNEY#',
    });
    if (dbJourneys) {
      await Promise.all(
        dbJourneys.map(async (dbJourney) => {
          await context.entities.Journey.delete({ userId: id, id: dbJourney.id });
        })
      );
    }

    // Delete user's email identity from SES
    if (dbUserCur && dbUserCur.email) {
      context.ses.deleteEmailIdentity(dbUserCur.email);
    }

    // Delete user from database
    const { Attributes: dbUser } = await context.entities.User.delete({ id: id }, { returnValues: 'ALL_OLD' });
    if (!dbUser) {
      throw new Error('Failed to delete user');
    }

    context.cache.invalidate([{ typename: 'User' }]);
    return dbUser as User;
  } catch (error) {
    Logger.error(`Failed to delete user with id ${id}: ${error}`);
    throw error;
  }
};

export async function getJourneyMonitor(
  context: GraphQLContext,
  dbJourney: {
    expires: string;
    limitPrice: number;
    refreshToken: string;
    userId: string;
    id: string;
  }
): Promise<JourneyMonitor> {
  const journey = await context.dbHafas.requeryJourney(dbJourney.refreshToken);
  return {
    id: dbJourney.id,
    userId: dbJourney.userId,
    limitPrice: dbJourney.limitPrice,
    expires: dbJourney.expires,
    journey: !journey
      ? undefined
      : {
          refreshToken: journey.refreshToken!,
          from: journey.legs[0].origin!.name!,
          to: journey.legs[journey.legs.length - 1].destination!.name!,
          departure: new Date(journey.legs[0].plannedDeparture!),
          arrival: new Date(journey.legs[journey.legs.length - 1].plannedArrival!),
          means: getMeans(journey),
          price: journey.price?.amount,
        },
  };
}
