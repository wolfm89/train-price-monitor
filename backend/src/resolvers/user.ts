import dotenv from 'dotenv'; // Load environment variables from .env file
import { GraphQLContext } from '../context';
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  StoredJourney,
} from '../model/trainPriceMonitor';
import Logger from '../lib/logger';
import { sort } from '../lib/sort';
import { MutationResolvers, QueryResolvers, UserResolvers } from '../schema/generated/resolvers.generated';
import {
  User,
  PresignedUrl,
  JourneyMonitor,
  JourneyExpiryNotification,
  JourneyStaleNotification,
  PriceAlertNotification,
  InputMaybe,
  LoyaltyCardInput,
  AgeGroup,
} from '../schema/generated/typeDefs.generated';
import { NOTIFICATION_TYPES } from './notificationTypes';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { LoyaltyCardData, validateLoyaltyCard, VALID_AGE_GROUPS } from '../lib/loyaltyCards';
import { LoyaltyCard, LoyaltyCardType } from '../schema/generated/typeDefs.generated';

dotenv.config();

const profileImageBucketName = process.env.PROFILE_IMAGE_BUCKET_NAME;

if (!profileImageBucketName) {
  throw new Error('PROFILE_IMAGE_BUCKET_NAME is not defined in process.env');
}

/**
 * Parses stored loyaltyCard JSON string into a LoyaltyCard.
 * Migration shim: also handles the old array format by returning the first element.
 */
function parseLoyaltyCard(raw?: string): LoyaltyCard | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as LoyaltyCardData | LoyaltyCardData[];
    const card = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!card) return undefined;
    return {
      type: card.type as LoyaltyCardType,
      discount: card.discount,
      class: card.class,
    };
  } catch {
    Logger.warn('Failed to parse stored loyaltyCard JSON', { raw });
    return undefined;
  }
}

/**
 * Parses stored loyaltyCards JSON string (User wallet) into array of LoyaltyCard.
 */
function parseWalletLoyaltyCards(raw?: string): LoyaltyCard[] | undefined {
  if (!raw) return undefined;
  try {
    const cards = JSON.parse(raw) as LoyaltyCardData[];
    return cards.map((card) => ({
      type: card.type as LoyaltyCardType,
      discount: card.discount,
      class: card.class,
    }));
  } catch {
    Logger.warn('Failed to parse stored loyaltyCards JSON', { raw });
    return undefined;
  }
}

export const userResolvers: UserResolvers = {
  loyaltyCards: (parent) => {
    const raw = (parent as unknown as { loyaltyCards?: string }).loyaltyCards;
    return parseWalletLoyaltyCards(raw) ?? null;
  },
  ageGroup: (parent) => {
    const raw = (parent as unknown as { ageGroup?: string }).ageGroup;
    if (!raw || !VALID_AGE_GROUPS.includes(raw)) return null;
    return raw as AgeGroup;
  },
  deutschlandTicketDiscount: (parent) => {
    return (parent as unknown as { deutschlandTicketDiscount?: boolean }).deutschlandTicketDiscount ?? null;
  },
  notifications: async (
    parent,
    args,
    context: GraphQLContext
  ): Promise<(JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification)[]> => {
    const { Items: dbNotifications } = await context.entities.TrainPriceMonitorTable.build(QueryCommand)
      .entities(context.entities.Notification)
      .query({ partition: `USER#${parent.id}`, range: { beginsWith: 'NOTIFICATION#' } })
      .send();

    const userNotifications = dbNotifications ?? [];

    const filteredNotifications = userNotifications.filter(
      (n: { read?: boolean }) => args.read === undefined || n.read === args.read
    );

    const notificationResults = await Promise.allSettled(
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
          } as JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification;
        }
      )
    );

    const notifications = notificationResults.flatMap(
      (result, index): (JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification)[] => {
        if (result.status === 'rejected') {
          const n = filteredNotifications[index];
          Logger.error('Failed to load notification', {
            error: result.reason,
            notificationId: n.id,
            notificationType: n.type,
            userId: n.userId,
          });
          return [];
        }
        return [result.value];
      }
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

    const journeys: JourneyMonitor[] = (dbJourneys as StoredJourney[]).map(getJourneyMonitor);
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
    await context.s3.upload(profileImageBucketName, filename, image);
  } catch (error) {
    Logger.error(`Failed to upload file to S3: ${error}`);
    throw error;
  }

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

export const updateTravelPreferences: NonNullable<MutationResolvers['updateTravelPreferences']> = async (
  _,
  args: {
    userId: string;
    loyaltyCards?: InputMaybe<LoyaltyCardInput[]>;
    ageGroup?: InputMaybe<AgeGroup>;
    deutschlandTicketDiscount?: InputMaybe<boolean>;
  },
  context: GraphQLContext
) => {
  // Validate loyalty cards
  if (args.loyaltyCards) {
    for (const card of args.loyaltyCards) {
      validateLoyaltyCard({
        type: card.type,
        discount: card.discount ?? undefined,
        class: card.class ?? undefined,
      });
    }
  }

  // Validate age group
  if (args.ageGroup && !VALID_AGE_GROUPS.includes(args.ageGroup)) {
    throw new Error(`Invalid age group: ${args.ageGroup}. Valid values: ${VALID_AGE_GROUPS.join(', ')}`);
  }

  const updateItem: {
    id: string;
    loyaltyCards?: string;
    ageGroup?: string;
    deutschlandTicketDiscount?: boolean;
  } = { id: args.userId };

  // Store loyalty cards as JSON string, or remove if empty/null
  if (args.loyaltyCards !== undefined) {
    updateItem.loyaltyCards =
      args.loyaltyCards && args.loyaltyCards.length > 0
        ? JSON.stringify(
            args.loyaltyCards.map((card) => ({
              type: card.type,
              discount: card.discount ?? undefined,
              class: card.class ?? undefined,
            }))
          )
        : undefined;
  }

  if (args.ageGroup !== undefined) {
    updateItem.ageGroup = args.ageGroup ?? undefined;
  }

  if (args.deutschlandTicketDiscount !== undefined) {
    updateItem.deutschlandTicketDiscount = args.deutschlandTicketDiscount ?? undefined;
  }

  try {
    const { Attributes: dbUser } = await context.entities.User.build(UpdateItemCommand)
      .item(updateItem)
      .options({ returnValues: 'ALL_NEW' })
      .send();

    if (!dbUser) {
      throw new Error('Failed to update travel preferences');
    }
    context.cache.invalidate([{ typename: 'User' }]);

    return dbUser as unknown as User;
  } catch (error) {
    Logger.error(`Failed to update travel preferences for user ${args.userId}: ${error}`);
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
      Logger.info(`Deleting profile image for user '${id}'`);
      await context.s3.deleteFilesWithPrefix(profileImageBucketName, dbUserCur.profilePicture);
    }

    const { Items: dbNotifications } = await context.entities.TrainPriceMonitorTable.build(QueryCommand)
      .entities(context.entities.Notification)
      .query({ partition: `USER#${id}` })
      .send();

    if (dbNotifications) {
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
      await Promise.all(
        dbJourneys.map(async (dbJourney: { id: string }) => {
          await context.entities.Journey.build(DeleteItemCommand).key({ userId: id, id: dbJourney.id }).send();
        })
      );
    }

    if (dbUserCur && dbUserCur.email) {
      context.ses.deleteEmailIdentity(dbUserCur.email);
    }

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

/**
 * Builds the API representation of a stored journey from its cached snapshot.
 *
 * This is the read path, so it deliberately performs no network I/O: DB is
 * only ever contacted by the refresher, which writes the snapshot. A journey
 * that has never been fetched successfully (no `lastCheckedAt`) is reported as
 * `unavailable` rather than failing the whole watchlist query.
 */
export function getJourneyMonitor(dbJourney: StoredJourney): JourneyMonitor {
  const hasSnapshot = Boolean(dbJourney.lastCheckedAt && dbJourney.cachedDeparture && dbJourney.cachedArrival);

  return {
    id: dbJourney.id,
    userId: dbJourney.userId,
    limitPrice: dbJourney.limitPrice,
    expires: dbJourney.expires,
    from: dbJourney.cachedFrom ?? undefined,
    to: dbJourney.cachedTo ?? undefined,
    firstClass: dbJourney.firstClass ?? undefined,
    bike: dbJourney.bike ?? undefined,
    deutschlandTicketDiscount: dbJourney.deutschlandTicketDiscount ?? undefined,
    ageGroup: (dbJourney.ageGroup as AgeGroup | undefined) ?? undefined,
    loyaltyCard: parseLoyaltyCard(dbJourney.loyaltyCard) ?? undefined,
    unavailable: !hasSnapshot,
    journey: hasSnapshot
      ? {
          refreshToken: dbJourney.refreshToken,
          departure: new Date(dbJourney.cachedDeparture!),
          arrival: new Date(dbJourney.cachedArrival!),
          means: parseCachedMeans(dbJourney.cachedMeans),
          price: dbJourney.cachedPrice ?? undefined,
        }
      : undefined,
  };
}

function parseCachedMeans(cachedMeans?: string): string[] {
  if (!cachedMeans) return [];
  try {
    const parsed: unknown = JSON.parse(cachedMeans);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}
