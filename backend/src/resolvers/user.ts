import dotenv from 'dotenv';
import { GraphQLContext } from '../context';
import Logger from '../lib/logger';
import { sort } from '../lib/sort';
import { MutationResolvers, QueryResolvers, UserResolvers } from '../schema/generated/resolvers.generated';
import { User, PresignedUrl, Notification, JourneyMonitor } from '../schema/generated/typeDefs.generated';
import { getMeans } from './journey';
import { NOTIFICATION_TYPES } from './notificationTypes';

dotenv.config(); // Load environment variables from .env file

const profileImageBucketName = process.env.PROFILE_IMAGE_BUCKET_NAME;

if (!profileImageBucketName) {
  throw new Error('PROFILE_IMAGE_BUCKET_NAME is not defined in process.env');
}

export const userResolvers: UserResolvers = {
  notifications: async (parent, args, context: GraphQLContext): Promise<Notification[]> => {
    let notifications: Notification[] | undefined = undefined;
    const { Items: dbNotifications } = await context.entities.Notification.scan({
      filters: [
        { attr: 'userId', eq: `USER#${parent.id}` },
        { attr: 'id', beginsWith: 'NOTIFICATION#' },
      ],
    });
    if (!dbNotifications) {
      return [];
    }

    notifications = dbNotifications.map((dbNotification) => {
      return {
        id: dbNotification.id,
        userId: dbNotification.userId,
        type: dbNotification.type,
        timestamp: new Date(dbNotification.timestamp),
        read: dbNotification.read,
        ...NOTIFICATION_TYPES[dbNotification.type].mapAdditionalData(
          context,
          dbNotification.userId,
          dbNotification.data
        ),
      };
    });
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

export const userQuery: NonNullable<QueryResolvers['user']> = async (parent, args, context) => {
  const { Item: dbUser } = await context.entities.User.get({ id: args.id });
  if (!dbUser) {
    return null;
  }
  const user: User = {
    ...dbUser,
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

  const user: User = { ...dbUser };
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
  try {
    const { Attributes: dbUser } = await context.entities.User.update(
      { id: id, activated: true },
      { returnValues: 'ALL_NEW' }
    );

    if (!dbUser) {
      throw new Error('Failed to update user property');
    }

    const user: User = { ...dbUser };
    return user;
  } catch (error) {
    Logger.error(`Failed to activate user with id ${id}: ${error}`);
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
