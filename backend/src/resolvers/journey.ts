import { Journey as HafasJourney } from 'hafas-client';
import { GraphQLContext } from '../context';
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ScanCommand,
  QueryCommand,
} from '../model/trainPriceMonitor';
import Logger from '../lib/logger';
import { MutationResolvers, QueryResolvers } from '../schema/generated/resolvers.generated';
import { v4 as uuidv4 } from 'uuid';
import { JourneyMonitor, JourneysResult } from '../schema/generated/typeDefs.generated';
import { NOTIFICATION_TYPES } from './notificationTypes';

/**
 * Resolves the 'journeys' query to fetch available journeys from the Hafas API.
 * @param _parent - The parent object.
 * @param args - The arguments provided in the query.
 * @param context - The GraphQL context.
 * @returns A JourneysResult with journeys and pagination refs.
 */
export const journeysQuery: NonNullable<QueryResolvers['journeys']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<JourneysResult> => {
  // Query journeys using Hafas API
  const result = await context.dbHafas.queryJourneys(args.from, args.to, args.departure, {
    earlierThan: args.earlierThan ?? undefined,
    laterThan: args.laterThan ?? undefined,
  });

  // Check if no journeys were found
  if (!result || !result.journeys || result.journeys.length === 0) {
    Logger.info(`No journeys found from ${args.from} to ${args.to} at ${args.departure.toISOString()}`);
    return { journeys: [], earlierRef: null, laterRef: null };
  }

  // Map and format the journeys for response
  const journeys = result.journeys
    .filter((journey) => !journey.legs.some((leg) => leg.cancelled))
    .map((journey) => {
      return {
        fromId: journey.legs[0].origin!.id!,
        toId: journey.legs[journey.legs.length - 1].destination!.id!,
        departure: new Date(journey.legs[0].plannedDeparture!),
        arrival: new Date(journey.legs[journey.legs.length - 1].plannedArrival!),
        refreshToken: journey.refreshToken!,
        price: journey.price?.amount,
        means: getMeans(journey),
      };
    });

  return {
    journeys,
    earlierRef: result.earlierRef ?? null,
    laterRef: result.laterRef ?? null,
  };
};

/**
 * Resolves the 'monitorJourney' mutation to add a new journey monitor for a user.
 * @param _parent - The parent object.
 * @param args - The arguments provided in the mutation.
 * @param context - The GraphQL context.
 * @returns The ID of the newly created journey monitor.
 */
export const monitorJourney: NonNullable<MutationResolvers['monitorJourney']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<JourneyMonitor> => {
  // Retrieve user from the database
  const { Item: dbUser } = await context.entities.User.build(GetItemCommand).key({ id: args.userId }).send();
  if (!dbUser) {
    throw new Error(`User with id ${args.userId} not found`);
  }

  // Generate a new journey monitor ID using UUID
  const journeyMonitorId = uuidv4();

  // Save the journey monitor in the database
  await context.entities.Journey.build(PutItemCommand)
    .item({
      id: journeyMonitorId,
      userId: args.userId,
      limitPrice: args.limitPrice,
      refreshToken: args.refreshToken,
      expires: args.expires,
      fromId: args.fromId,
      toId: args.toId,
      departure: args.departure,
    })
    .send();

  context.cache.invalidate([{ typename: 'JourneyMonitor' }]);

  return {
    id: journeyMonitorId,
    userId: args.userId,
    limitPrice: args.limitPrice,
    expires: args.expires,
    journey: { refreshToken: args.refreshToken },
  };
};

/**
 * Resolves the 'updateJourneyMonitors' mutation to update all stored journeys.
 * @param _parent - The parent object.
 * @param _args - The arguments provided in the mutation.
 * @param context - The GraphQL context.
 * @returns The number of journeys updated.
 */
export const updateJourneyMonitors: NonNullable<MutationResolvers['updateJourneyMonitors']> = async (
  _parent,
  _args,
  context: GraphQLContext
): Promise<number> => {
  // Query all journeys from the database
  const { Items: allJourneys } = await context.entities.TrainPriceMonitorTable.build(ScanCommand)
    .entities(context.entities.Journey)
    .send();

  // Count the number of journeys
  const numberOfJourneys = allJourneys?.length ?? 0;

  Logger.info(`Found ${numberOfJourneys} journeys to update`);

  if (allJourneys) {
    for (const journey of allJourneys) {
      // Skip expired journeys
      if (new Date(journey.expires) < new Date()) {
        Logger.info('Skipping expired journey in update scan', { journeyId: journey.id });
        continue;
      }

      try {
        await context.sqs.sendUpdateJourneyMessage(journey.userId, journey.id);
      } catch (error) {
        Logger.error('Failed to send update message for journey', {
          journeyId: journey.id,
          userId: journey.userId,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  return numberOfJourneys;
};

/**
 * Resolves the 'updateJourneyMonitor' mutation to update a specific journey.
 * @param _parent - The parent object.
 * @param args - The arguments provided in the mutation.
 * @param context - The GraphQL context.
 * @returns The updated journey monitor.
 */
export const updateJourneyMonitor: NonNullable<MutationResolvers['updateJourneyMonitor']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<JourneyMonitor> => {
  // Add user and journey ID to persistent log attributes
  Logger.addPersistentLogAttributes({ userId: args.userId, journeyId: args.journeyId });

  // Retrieve the journey from the database
  const dbJourney = await context.entities.Journey.build(GetItemCommand)
    .key({ userId: args.userId, id: args.journeyId })
    .send();

  // Check if the journey exists
  if (!dbJourney.Item) {
    throw new Error('Journey not found in database');
  }

  const journeyMonitor: JourneyMonitor = {
    id: dbJourney.Item.id,
    userId: dbJourney.Item.userId,
    limitPrice: dbJourney.Item.limitPrice,
    expires: dbJourney.Item.expires,
    journey: { refreshToken: dbJourney.Item.refreshToken },
  };

  // Check if the journey has expired
  if (new Date(dbJourney.Item.expires) < new Date()) {
    Logger.info(`Journey has expired`);

    // Delete the journey from the database
    await context.entities.Journey.build(DeleteItemCommand).key({ userId: args.userId, id: args.journeyId }).send();
    context.cache.invalidate([{ typename: 'JourneyMonitor' }]);
    Logger.info(`Deleted journey from database`);

    // Send a notification to the user that the journey has expired
    const notificationId = uuidv4();
    await context.entities.Notification.build(PutItemCommand)
      .item({
        id: notificationId,
        userId: args.userId,
        type: NOTIFICATION_TYPES.JOURNEY_EXPIRED.name,
        read: false,
        sent: false,
        timestamp: new Date().toISOString(),
        data: JSON.stringify({ refreshToken: dbJourney.Item.refreshToken }),
      })
      .send();
    context.cache.invalidate([{ typename: 'Notification' }]);

    // Clean up any existing PRICE_ALERT notifications for this journey
    await deletePriceAlertNotificationsForJourney(context, args.userId, args.journeyId);

    await sendNotificationEmailIfEnabled(context, args.userId, notificationId);

    return journeyMonitor;
  }

  // Check if notification already exists (PRICE_ALERT or JOURNEY_STALE for this journey)
  const existingNotifications = await context.entities.TrainPriceMonitorTable.build(QueryCommand)
    .entities(context.entities.Notification)
    .query({ partition: `USER#${args.userId}`, range: { beginsWith: 'NOTIFICATION#' } })
    .send();

  const notificationsArray = existingNotifications?.Items ?? [];
  if (
    notificationsArray.some((item: { data?: string; type?: string }) => {
      if (item.type !== NOTIFICATION_TYPES.PRICE_ALERT.name || !item.data) return false;
      try {
        return JSON.parse(item.data).journeyId === args.journeyId;
      } catch {
        return false;
      }
    })
  ) {
    Logger.info(`PRICE_ALERT notification already exists for journey`);
    return journeyMonitor;
  }

  // Get new price for journey and compare to limit price
  let journey: HafasJourney | undefined;

  try {
    journey = await context.dbHafas.requeryJourney(dbJourney.Item.refreshToken);
  } catch (error) {
    Logger.error('Error requerying journey', {
      journeyId: args.journeyId,
      error: error instanceof Error ? error.message : error,
    });
    throw error;
  }

  if (!journey) {
    // Token is stale — attempt recovery using stored station IDs and departure
    Logger.warn('Refresh token stale, attempting recovery', { journeyId: args.journeyId });

    const fromStationId = dbJourney.Item.fromId as string | undefined;
    const toStationId = dbJourney.Item.toId as string | undefined;
    const storedDeparture = dbJourney.Item.departure as string | undefined;

    if (!fromStationId || !toStationId || !storedDeparture) {
      Logger.warn('Missing station IDs or departure for recovery, skipping', { journeyId: args.journeyId });
    } else {
      const departure = new Date(storedDeparture);

      try {
        const result = await context.dbHafas.queryJourneys(fromStationId, toStationId, departure, { results: 5 });

        // Filter by matching origin/destination station IDs, then pick the candidate whose
        // planned departure is closest to the stored departure time to avoid reattaching to a
        // different service on the same route.
        const candidates = result.journeys?.filter(
          (j) => j.legs[0]?.origin?.id === fromStationId && j.legs[j.legs.length - 1]?.destination?.id === toStationId
        );
        const matchingJourney = candidates?.reduce<(typeof candidates)[number] | undefined>((best, j) => {
          const jDep = new Date(j.legs[0]?.plannedDeparture ?? j.legs[0]?.departure ?? 0).getTime();
          const jDiff = Math.abs(jDep - departure.getTime());
          if (!best) return j;
          const bestDep = new Date(best.legs[0]?.plannedDeparture ?? best.legs[0]?.departure ?? 0).getTime();
          const bestDiff = Math.abs(bestDep - departure.getTime());
          return jDiff < bestDiff ? j : best;
        }, undefined);

        if (matchingJourney) {
          // Update token in DB
          await context.entities.Journey.build(UpdateItemCommand)
            .item({ userId: args.userId, id: args.journeyId, refreshToken: matchingJourney.refreshToken! })
            .send();
          journey = matchingJourney;
          Logger.info('Successfully recovered journey with new token', { journeyId: args.journeyId });
        }
      } catch (recoveryError) {
        Logger.error('Journey recovery failed', {
          journeyId: args.journeyId,
          error: recoveryError instanceof Error ? recoveryError.message : recoveryError,
        });
      }
    }
  }

  if (!journey) {
    // Recovery failed — journey may be cancelled or rescheduled. Notify user.
    Logger.warn('Journey recovery failed completely, creating notification', { journeyId: args.journeyId });

    // Check if a JOURNEY_STALE notification already exists for this journey
    const hasExistingStaleNotification = notificationsArray.some((item: { data?: string; type?: string }) => {
      if (item.type !== NOTIFICATION_TYPES.JOURNEY_STALE.name || !item.data) return false;
      try {
        return JSON.parse(item.data).journeyId === args.journeyId;
      } catch {
        return false;
      }
    });

    if (hasExistingStaleNotification) {
      Logger.info('JOURNEY_STALE notification already exists for journey, skipping');
      return journeyMonitor;
    }

    const notificationId = uuidv4();
    await context.entities.Notification.build(PutItemCommand)
      .item({
        id: notificationId,
        userId: args.userId,
        type: NOTIFICATION_TYPES.JOURNEY_STALE.name,
        read: false,
        sent: false,
        timestamp: new Date().toISOString(),
        data: JSON.stringify({
          journeyId: args.journeyId,
          fromId: dbJourney.Item.fromId,
          toId: dbJourney.Item.toId,
        }),
      })
      .send();
    context.cache.invalidate([{ typename: 'Notification' }]);

    await sendNotificationEmailIfEnabled(context, args.userId, notificationId);

    return journeyMonitor; // Return gracefully, don't throw
  }
  const newPrice = journey.price?.amount;

  if (!newPrice) {
    Logger.info(`No price found for journey`);
  } else if (newPrice >= dbJourney.Item.limitPrice) {
    // If new price is higher than limit price, send notification
    Logger.info(`New price ${newPrice} for journey is higher than limit price ${dbJourney.Item.limitPrice}`);

    // Save a notification in the database
    const notificationId = uuidv4();
    await context.entities.Notification.build(PutItemCommand)
      .item({
        id: notificationId,
        userId: args.userId,
        type: NOTIFICATION_TYPES.PRICE_ALERT.name,
        read: false,
        sent: false,
        timestamp: new Date().toISOString(),
        data: JSON.stringify({ journeyId: args.journeyId }),
      })
      .send();
    context.cache.invalidate([{ typename: 'Notification' }]);

    await sendNotificationEmailIfEnabled(context, args.userId, notificationId);

    // Log information about the updated journey
    Logger.info(`Sent notification for journey`);
  } else {
    Logger.info(`New price ${newPrice} for journey is still lower than limit price ${dbJourney.Item.limitPrice}`);
  }

  return journeyMonitor;
};

async function deletePriceAlertNotificationsForJourney(context: GraphQLContext, userId: string, journeyId: string) {
  const { Items: priceAlertNotifications } = await context.entities.TrainPriceMonitorTable.build(QueryCommand)
    .entities(context.entities.Notification)
    .query({ partition: `USER#${userId}`, range: { beginsWith: 'NOTIFICATION#' } })
    .options({
      filters: {
        Notification: { attr: 'type', eq: NOTIFICATION_TYPES.PRICE_ALERT.name },
      },
    })
    .send();

  const toDelete = priceAlertNotifications?.filter((item: { data?: string }) => {
    if (!item.data) return false;
    try {
      return JSON.parse(item.data).journeyId === journeyId;
    } catch {
      return false;
    }
  });

  if (toDelete && toDelete.length > 0) {
    await Promise.all(
      toDelete.map((notification) =>
        context.entities.Notification.build(DeleteItemCommand).key({ userId, id: notification.id }).send()
      )
    );
    context.cache.invalidate([{ typename: 'Notification' }]);
    Logger.info(`Deleted ${toDelete.length} PRICE_ALERT notifications for journey`);
  }
}

async function sendNotificationEmailIfEnabled(context: GraphQLContext, userId: string, notificationId: string) {
  // Get setting for email notifications for user from database
  const { Item: dbUser } = await context.entities.User.build(GetItemCommand).key({ id: userId }).send();

  if (!dbUser) {
    throw new Error(`User with id ${userId} not found`);
  }
  if (dbUser.emailNotificationsEnabled) {
    // Send email notification to user
    await context.sqs.sendEmailNotificationMessage(userId, notificationId);
  }
}

export function getMeans(journey: HafasJourney): string[] {
  return journey.legs.map((leg) => (leg.line ? leg.line.productName! : leg.walking ? 'walk' : ''));
}

/**
 * Resolves the 'deleteJourneyMonitor' mutation to delete a specific journey.
 * @param _parent - The parent object.
 * @param args - The arguments provided in the mutation (userId and journeyId).
 * @param context - The GraphQL context.
 * @returns The deleted journey monitor.
 */
export const deleteJourneyMonitor: NonNullable<MutationResolvers['deleteJourneyMonitor']> = async (
  _parent,
  { userId, journeyId }: { userId: string; journeyId: string },
  context: GraphQLContext
): Promise<JourneyMonitor> => {
  // Add user and journey ID to persistent log attributes
  Logger.addPersistentLogAttributes({ userId: userId, journeyId: journeyId });

  // Retrieve the journey from the database
  const dbJourney = await context.entities.Journey.build(GetItemCommand).key({ userId: userId, id: journeyId }).send();

  // Check if the journey exists
  if (!dbJourney.Item) {
    throw new Error('Journey not found in database');
  }

  const journeyMonitor: JourneyMonitor = {
    id: dbJourney.Item.id,
    userId: dbJourney.Item.userId,
    limitPrice: dbJourney.Item.limitPrice,
    expires: dbJourney.Item.expires,
    journey: { refreshToken: dbJourney.Item.refreshToken },
  };

  // Delete all notifications for the journey (with data containing the journey ID)
  const { Items: notifications } = await context.entities.TrainPriceMonitorTable.build(QueryCommand)
    .entities(context.entities.Notification)
    .query({ partition: `USER#${userId}`, range: { beginsWith: 'NOTIFICATION#' } })
    .send();

  const journeyNotifications = notifications?.filter((item: { data?: string }) => {
    if (!item.data) return false;
    try {
      return JSON.parse(item.data).journeyId === journeyId;
    } catch {
      return false;
    }
  });

  if (journeyNotifications) {
    for (const notification of journeyNotifications) {
      await context.entities.Notification.build(DeleteItemCommand).key({ userId: userId, id: notification.id }).send();
    }
    context.cache.invalidate([{ typename: 'Notification' }]);
    Logger.info(`Deleted ${journeyNotifications.length} notifications for journey`);
  }

  // Delete the journey from the database
  await context.entities.Journey.build(DeleteItemCommand).key({ userId: userId, id: journeyId }).send();
  context.cache.invalidate([{ typename: 'JourneyMonitor' }]);
  Logger.info(`Deleted journey from database`);

  return journeyMonitor;
};
