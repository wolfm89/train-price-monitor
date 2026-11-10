import dotenv from 'dotenv'; // Load environment variables from .env file
import { GraphQLContext } from '../context';
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  StoredJourney,
  StoredUser,
} from '../model/trainPriceMonitor';
import Logger from '../lib/logger';
import { sort } from '../lib/sort';
import { assertUserAccess, requireAuth, requireUserAccess } from '../lib/auth';
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
import { NOTIFICATION_TYPES, NotificationSkipError } from './notificationTypes';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GraphQLError } from 'graphql';
import { LoyaltyCardData, validateLoyaltyCard, VALID_AGE_GROUPS } from '../lib/loyaltyCards';
import { LoyaltyCard, LoyaltyCardType } from '../schema/generated/typeDefs.generated';
import { validateProfilePicture } from '../lib/profilePicture';
import { buildDataExport } from '../lib/dataExport';

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
    Logger.warn('Failed to parse stored loyaltyCard JSON', { length: raw.length });
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
    Logger.warn('Failed to parse stored loyaltyCards JSON', { length: raw.length });
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
          if (result.reason instanceof NotificationSkipError) {
            // Expected for an old notification whose journey is already gone;
            // dropping it with a WARN keeps it out of the error alarm.
            Logger.warn('Notification skipped', {
              notificationId: n.id,
              notificationType: n.type,
              reason: result.reason.message,
            });
            return [];
          }
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
    Logger.appendKeys({ userId: parent.id });
    try {
      return await loadJourneyMonitors(parent.id, args, context);
    } finally {
      Logger.removeKeys(['userId']);
    }
  },
};

async function loadJourneyMonitors(
  userId: string,
  args: { limit?: number | null },
  context: GraphQLContext
): Promise<JourneyMonitor[]> {
  const { Items: dbJourneys } = await context.entities.TrainPriceMonitorTable.build(QueryCommand)
    .entities(context.entities.Journey)
    .query({ partition: `USER#${userId}`, range: { beginsWith: 'JOURNEY#' } })
    .send();

  if (!dbJourneys) {
    return [];
  }

  const journeys: JourneyMonitor[] = (dbJourneys as StoredJourney[]).map(getJourneyMonitor);
  journeys.sort(
    (a: JourneyMonitor, b: JourneyMonitor) =>
      (a.journey?.departure?.getTime() ?? Infinity) - (b.journey?.departure?.getTime() ?? Infinity)
  );

  const limit = args.limit ?? undefined;
  if (limit !== undefined) {
    return journeys.slice(0, limit);
  }
  return journeys;
}

export const userQuery: NonNullable<QueryResolvers['user']> = async (parent, args, context): Promise<User | null> => {
  const { Item: dbUser } = await context.entities.User.build(GetItemCommand).key({ id: args.id }).send();
  if (!dbUser) {
    // New accounts are created by the frontend right after signup, so a missing
    // row is a normal state, not an error. Throwing here made the frontend treat
    // the existence check as a failure on every first login.
    return null;
  }
  assertUserAccess(context, dbUser as StoredUser);
  return dbUser as unknown as User;
};

export const userProfilePicturePresignedUrlQuery: NonNullable<
  QueryResolvers['userProfilePicturePresignedUrl']
> = async (_, { id }: { id: string }, context: GraphQLContext) => {
  const dbUser = await requireUserAccess(context, id);
  let url: string | undefined = undefined;
  if (dbUser.profilePicture) {
    url = await context.s3.getPresignedUrl(profileImageBucketName, dbUser.profilePicture);
  }
  const presignedUrl: PresignedUrl = {
    id: id,
    url: url,
  };
  return presignedUrl;
};

export const exportMyDataQuery: NonNullable<QueryResolvers['exportMyData']> = async (
  _,
  { id }: { id: string },
  context: GraphQLContext
) => {
  const dbUser = await requireUserAccess(context, id);

  const [{ Items: dbJourneys }, { Items: dbNotifications }] = await Promise.all([
    context.entities.TrainPriceMonitorTable.build(QueryCommand)
      .entities(context.entities.Journey)
      .query({ partition: `USER#${id}`, range: { beginsWith: 'JOURNEY#' } })
      .options({ maxPages: Infinity })
      .send(),
    context.entities.TrainPriceMonitorTable.build(QueryCommand)
      .entities(context.entities.Notification)
      .query({ partition: `USER#${id}`, range: { beginsWith: 'NOTIFICATION#' } })
      .options({ maxPages: Infinity })
      .send(),
  ]);

  const profilePictureUrl = dbUser.profilePicture
    ? await context.s3.getPresignedUrl(profileImageBucketName, dbUser.profilePicture)
    : undefined;

  Logger.info('Exported user data', {
    userId: id,
    journeys: dbJourneys?.length ?? 0,
    notifications: dbNotifications?.length ?? 0,
  });

  return buildDataExport({
    user: dbUser as unknown as Record<string, unknown>,
    journeys: (dbJourneys ?? []) as Record<string, unknown>[],
    notifications: (dbNotifications ?? []) as Record<string, unknown>[],
    profilePictureUrl,
    exportedAt: new Date(),
  });
};

export const updateUserProfilePicture: NonNullable<MutationResolvers['updateUserProfilePicture']> = async (
  _,
  { id, image }: { id: string; image: File },
  context: GraphQLContext
) => {
  const dbUserCur = await requireUserAccess(context, id);
  const body = new Uint8Array(await image.arrayBuffer());
  const { contentType, extension } = validateProfilePicture(body);
  const filename = `${id}.${extension}`;

  try {
    await context.s3.upload(profileImageBucketName, filename, body, contentType);
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
  const auth = requireAuth(context);
  if (auth.customId !== id) {
    throw new GraphQLError('Cannot create a user for another identity', { extensions: { code: 'FORBIDDEN' } });
  }

  try {
    await context.entities.User.build(PutItemCommand)
      .item({
        id,
        givenName,
        familyName: familyName ?? undefined,
        email,
        // The binding is written by the backend from the verified token, never
        // taken from the GraphQL arguments.
        cognitoSub: auth.sub,
      })
      .options({ condition: { attr: 'id', exists: false } })
      .send();
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      const { Item: existing } = await context.entities.User.build(GetItemCommand).key({ id }).send();
      if (existing && (existing as StoredUser).cognitoSub === auth.sub) {
        Logger.info(`User with id ${id} already exists and is bound to this identity`);
        context.cache.invalidate([{ typename: 'User' }]);
        return existing as unknown as User;
      }
      // A row with this public id belongs to another Cognito identity (or predates
      // the binding). Never attach it to the caller: run the backfill instead.
      throw new GraphQLError('User already exists for another identity', {
        extensions: { code: 'FORBIDDEN' },
      });
    }
    Logger.error(`Failed to create user with id ${id}: ${error}`);
    throw error;
  }

  // Only necessary while the SES account is in the sandbox, where every
  // recipient must be a verified identity (see docs/privacy/email-and-ses.md).
  if (context.ses.sandbox) {
    await context.ses.createEmailIdentity(email);
  }

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
  await requireUserAccess(context, id);
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
  await requireUserAccess(context, args.userId);

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
  const dbUserCur = await requireUserAccess(context, id);
  Logger.appendKeys({ userId: id });
  try {
    if (dbUserCur.profilePicture) {
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

    if (context.ses.sandbox && dbUserCur.email) {
      await context.ses.deleteEmailIdentity(dbUserCur.email);
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
  } finally {
    Logger.removeKeys(['userId']);
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
    expires: new Date(dbJourney.expires),
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
