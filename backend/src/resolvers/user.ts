import dotenv from 'dotenv'; // Load environment variables from .env file
import { GraphQLContext } from '../context';
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '../model/trainPriceMonitor';
import Logger from '../lib/logger';
import { sort } from '../lib/sort';
import { MutationResolvers, QueryResolvers, UserResolvers } from '../schema/generated/resolvers.generated';
import {
  User,
  PresignedUrl,
  JourneyMonitor,
  JourneyExpiryNotification,
  PriceAlertNotification,
  InputMaybe,
} from '../schema/generated/typeDefs.generated';
import { getMeans } from './journey';
import { NOTIFICATION_TYPES } from './notificationTypes';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

dotenv.config();

const profileImageBucketName = process.env.PROFILE_IMAGE_BUCKET_NAME;

if (!profileImageBucketName) {
  throw new Error('PROFILE_IMAGE_BUCKET_NAME is not defined in process.env');
}

export const userResolvers: UserResolvers = {
  notifications: async (
    parent,
    args,
    context: GraphQLContext
  ): Promise<(JourneyExpiryNotification | PriceAlertNotification)[]> => {
    const { Items: dbNotifications } = await context.entities.TrainPriceMonitorTable.build(QueryCommand)
      .entities(context.entities.Notification)
      .query({ partition: `USER#${parent.id}`, range: { beginsWith: 'NOTIFICATION#' } })
      .send();

    const userNotifications = dbNotifications ?? [];

    const filteredNotifications = userNotifications.filter(
      (n: { read?: boolean }) => args.read === undefined || n.read === args.read
    );

    const notifications = await Promise.all(
      filteredNotifications.map(
        async (dbNotification: {
          id: string;
          userId: string;
          type: string;
          timestamp: string;
          read: boolean;
          sent: boolean;
          data?: string;
        }) => {
          let data: Record<string, unknown> = {};
          if (dbNotification.data) {
            try {
              data = typeof dbNotification.data === 'string' ? JSON.parse(dbNotification.data) : dbNotification.data;
            } catch {
              data = {};
            }
          }
          const additionalData = await NOTIFICATION_TYPES[dbNotification.type].mapAdditionalData(
            context,
            dbNotification.userId,
            data
          );
          return {
            id: dbNotification.id,
            userId: dbNotification.userId,
            type: dbNotification.type,
            timestamp: new Date(dbNotification.timestamp),
            read: dbNotification.read,
            sent: dbNotification.sent,
            ...additionalData,
          } as JourneyExpiryNotification | PriceAlertNotification;
        }
      )
    );

    sort(notifications, '-timestamp');
    const limit = args.limit ?? undefined;
    if (limit !== undefined) {
      return notifications.slice(0, limit);
    }
    return notifications;
  },
  journeyMonitors: async (parent, args, context: GraphQLContext): Promise<JourneyMonitor[]> => {
    Logger.addPersistentLogAttributes({ userId: parent.id });
    const { Items: dbJourneys } = await context.entities.TrainPriceMonitorTable.build(QueryCommand)
      .entities(context.entities.Journey)
      .query({ partition: `USER#${parent.id}`, range: { beginsWith: 'JOURNEY#' } })
      .send();

    if (!dbJourneys) {
      return [];
    }
    const journeys: JourneyMonitor[] = await Promise.all(
      dbJourneys.map(
        async (dbJourney: {
          expires: string;
          limitPrice: number;
          refreshToken: string;
          userId: string;
          id: string;
        }) => {
          return await getJourneyMonitor(context, dbJourney);
        }
      )
    );
    journeys.sort(
      (a: JourneyMonitor, b: JourneyMonitor) =>
        (a.journey ? a.journey.departure.getTime() : Infinity) - (b.journey ? b.journey.departure.getTime() : Infinity)
    );

    const limit = args.limit ?? undefined;
    if (limit !== undefined) {
      return journeys.slice(0, limit);
    }
    return journeys;
  },
};

export const userQuery: NonNullable<QueryResolvers['user']> = async (parent, args, context): Promise<User> => {
  const { Item: dbUser } = await context.entities.User.build(GetItemCommand).key({ id: args.id }).send();
  if (!dbUser) {
    throw new Error('User not found in database');
  }
  return dbUser as unknown as User;
};

export const userProfilePicturePresignedUrlQuery: NonNullable<
  QueryResolvers['userProfilePicturePresignedUrl']
> = async (_, { id }: { id: string }, context: GraphQLContext) => {
  const { Item: dbUser } = await context.entities.User.build(GetItemCommand).key({ id }).send();
  let url: string | undefined = undefined;
  if (dbUser?.profilePicture) {
    // get presigned url for file dbUser?.profilePicture in bucket profileImageBucketName
    url = await context.s3.getPresignedUrl(profileImageBucketName, dbUser.profilePicture);
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
  const { Item: dbUserCur } = await context.entities.User.build(GetItemCommand).key({ id }).send();
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
    Logger.info(`Deleting previous profile image for user '${id}'`);
    await context.s3.deleteFilesWithPrefix(profileImageBucketName, dbUserCur.profilePicture);
  }

  const { Attributes: dbUser } = await context.entities.User.build(UpdateItemCommand)
    .item({ id, profilePicture: filename })
    .options({ returnValues: 'ALL_NEW' })
    .send();

  if (!dbUser) {
    return null;
  }
  context.cache.invalidate([{ typename: 'User' }, { typename: 'PresignedUrl' }]);

  return dbUser as unknown as User;
};

export const createUser: NonNullable<MutationResolvers['createUser']> = async (
  _,
  {
    id,
    givenName,
    familyName,
    email,
  }: { id: string; givenName: string; familyName?: InputMaybe<string>; email: string },
  context: GraphQLContext
) => {
  try {
    await context.entities.User.build(PutItemCommand)
      .item({
        id: id,
        givenName: givenName,
        familyName: familyName ?? undefined,
        email: email,
      })
      .options({ condition: { attr: 'id', exists: false } })
      .send();
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
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
    const { Attributes: dbUser } = await context.entities.User.build(UpdateItemCommand)
      .item({ id, emailNotificationsEnabled })
      .options({ returnValues: 'ALL_NEW' })
      .send();

    if (!dbUser) {
      throw new Error('Failed to update user property');
    }
    context.cache.invalidate([{ typename: 'User' }]);

    return dbUser as unknown as User;
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

    const { Item: dbUserCur } = await context.entities.User.build(GetItemCommand).key({ id }).send();

    if (dbUserCur && dbUserCur.profilePicture) {
      // Delete profile picture from S3 bucket
      Logger.info(`Deleting profile image for user '${id}'`);
      await context.s3.deleteFilesWithPrefix(profileImageBucketName, dbUserCur.profilePicture);
    }

    // Delete database entries related to user
    const { Items: dbNotifications } = await context.entities.TrainPriceMonitorTable.build(QueryCommand)
      .entities(context.entities.Notification)
      .query({ partition: `USER#${id}` })
      .send();

    if (dbNotifications) {
      // Delete notifications
      await Promise.all(
        dbNotifications.map(async (dbNotification: { id: string }) => {
          await context.entities.Notification.build(DeleteItemCommand)
            .key({ userId: id, id: dbNotification.id })
            .send();
        })
      );
    }

    const { Items: dbJourneys } = await context.entities.TrainPriceMonitorTable.build(QueryCommand)
      .entities(context.entities.Journey)
      .query({ partition: `USER#${id}` })
      .send();

    if (dbJourneys) {
      // Delete journeys
      await Promise.all(
        dbJourneys.map(async (dbJourney: { id: string }) => {
          await context.entities.Journey.build(DeleteItemCommand).key({ userId: id, id: dbJourney.id }).send();
        })
      );
    }

    if (dbUserCur && dbUserCur.email) {
      // Delete user's email identity from SES
      context.ses.deleteEmailIdentity(dbUserCur.email);
    }

    // Delete user from database
    const { Attributes: dbUser } = await context.entities.User.build(DeleteItemCommand)
      .key({ id })
      .options({ returnValues: 'ALL_OLD' })
      .send();

    if (!dbUser) {
      throw new Error('Failed to delete user');
    }

    context.cache.invalidate([{ typename: 'User' }]);
    return dbUser as unknown as User;
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
