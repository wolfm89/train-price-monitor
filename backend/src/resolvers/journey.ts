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
import {
  JourneyMonitor,
  JourneySearchOptions,
  JourneysResult,
  InputMaybe,
} from '../schema/generated/typeDefs.generated';
import { v4 as uuidv4 } from 'uuid';
import { NOTIFICATION_TYPES } from './notificationTypes';
import { PricingOptions } from '../managers/DbHafasManager';
import { LoyaltyCardData, validateLoyaltyCard } from '../lib/loyaltyCards';

/**
 * Converts GraphQL JourneySearchOptions to the internal PricingOptions format
 * used by DbHafasManager.
 */
function toPricingOptions(options?: InputMaybe<JourneySearchOptions>): PricingOptions | undefined {
  if (!options) return undefined;

  const pricingOpts: PricingOptions = {};

  if (options.firstClass !== undefined && options.firstClass !== null) {
    pricingOpts.firstClass = options.firstClass;
  }

  if (options.loyaltyCards && options.loyaltyCards.length > 0) {
    pricingOpts.loyaltyCards = options.loyaltyCards.map((card) => {
      const loyaltyCard: LoyaltyCardData = {
        type: card.type,
        discount: card.discount ?? undefined,
        class: card.class ?? undefined,
      };
      validateLoyaltyCard(loyaltyCard);
      return loyaltyCard;
    });
  }

  if (options.ageGroup) {
    pricingOpts.ageGroup = options.ageGroup;
  }

  if (options.deutschlandTicketDiscount !== undefined && options.deutschlandTicketDiscount !== null) {
    pricingOpts.deutschlandTicketDiscount = options.deutschlandTicketDiscount;
  }

  if (options.products) {
    const products: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(options.products)) {
      if (value !== null && value !== undefined) {
        products[key] = value;
      }
    }
    if (Object.keys(products).length > 0) {
      pricingOpts.products = products;
    }
  }

  if (options.transfers !== undefined && options.transfers !== null) {
    pricingOpts.transfers = options.transfers;
  }

  if (options.transferTime !== undefined && options.transferTime !== null) {
    pricingOpts.transferTime = options.transferTime;
  }

  if (options.bike !== undefined && options.bike !== null) {
    pricingOpts.bike = options.bike;
  }

  return Object.keys(pricingOpts).length > 0 ? pricingOpts : undefined;
}

/**
 * Extracts the pricing-relevant subset of options that should be snapshotted
 * onto a Journey entity for background price refresh correctness.
 */
function extractPricingSnapshot(options?: InputMaybe<JourneySearchOptions>): {
  firstClass?: boolean;
  loyaltyCards?: string;
  ageGroup?: string;
  deutschlandTicketDiscount?: boolean;
} {
  if (!options) return {};

  const snapshot: {
    firstClass?: boolean;
    loyaltyCards?: string;
    ageGroup?: string;
    deutschlandTicketDiscount?: boolean;
  } = {};

  if (options.firstClass !== undefined && options.firstClass !== null) {
    snapshot.firstClass = options.firstClass;
  }

  if (options.loyaltyCards && options.loyaltyCards.length > 0) {
    snapshot.loyaltyCards = JSON.stringify(
      options.loyaltyCards.map((card) => ({
        type: card.type,
        discount: card.discount ?? undefined,
        class: card.class ?? undefined,
      }))
    );
  }

  if (options.ageGroup) {
    snapshot.ageGroup = options.ageGroup;
  }

  if (options.deutschlandTicketDiscount !== undefined && options.deutschlandTicketDiscount !== null) {
    snapshot.deutschlandTicketDiscount = options.deutschlandTicketDiscount;
  }

  return snapshot;
}

/**
 * Reconstructs PricingOptions from a stored Journey entity's snapshotted fields.
 */
function loadStoredPricingOptions(dbJourney: {
  firstClass?: boolean;
  loyaltyCards?: string;
  ageGroup?: string;
  deutschlandTicketDiscount?: boolean;
}): PricingOptions | undefined {
  const opts: PricingOptions = {};

  if (dbJourney.firstClass !== undefined) {
    opts.firstClass = dbJourney.firstClass;
  }

  if (dbJourney.loyaltyCards) {
    try {
      opts.loyaltyCards = JSON.parse(dbJourney.loyaltyCards) as LoyaltyCardData[];
    } catch {
      Logger.warn('Failed to parse stored loyaltyCards JSON', { raw: dbJourney.loyaltyCards });
    }
  }

  if (dbJourney.ageGroup) {
    opts.ageGroup = dbJourney.ageGroup;
  }

  if (dbJourney.deutschlandTicketDiscount !== undefined) {
    opts.deutschlandTicketDiscount = dbJourney.deutschlandTicketDiscount;
  }

  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * Resolves the 'journeys' query to fetch available journeys from the Hafas API.
 */
export const journeysQuery: NonNullable<QueryResolvers['journeys']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<JourneysResult> => {
  const pricingOpts = toPricingOptions(args.options);

  const result = await context.dbHafas.queryJourneys(args.from, args.to, args.departure, {
    earlierThan: args.earlierThan ?? undefined,
    laterThan: args.laterThan ?? undefined,
    results: args.options?.results ?? undefined,
    ...pricingOpts,
  });

  if (!result || !result.journeys || result.journeys.length === 0) {
    Logger.info(`No journeys found from ${args.from} to ${args.to} at ${args.departure.toISOString()}`);
    return { journeys: [], earlierRef: null, laterRef: null };
  }

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
 * Snapshots pricing-relevant options onto the Journey entity so background
 * refreshes use the correct discount/class/age context.
 */
export const monitorJourney: NonNullable<MutationResolvers['monitorJourney']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<JourneyMonitor> => {
  const { Item: dbUser } = await context.entities.User.build(GetItemCommand).key({ id: args.userId }).send();
  if (!dbUser) {
    throw new Error(`User with id ${args.userId} not found`);
  }

  const journeyMonitorId = uuidv4();
  const pricingSnapshot = extractPricingSnapshot(args.options);

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
      ...pricingSnapshot,
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
 */
export const updateJourneyMonitors: NonNullable<MutationResolvers['updateJourneyMonitors']> = async (
  _parent,
  _args,
  context: GraphQLContext
): Promise<number> => {
  const { Items: allJourneys } = await context.entities.TrainPriceMonitorTable.build(ScanCommand)
    .entities(context.entities.Journey)
    .send();

  const numberOfJourneys = allJourneys?.length ?? 0;

  Logger.info(`Found ${numberOfJourneys} journeys to update`);

  if (allJourneys) {
    for (const journey of allJourneys) {
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
 * Loads stored pricing options from the Journey entity and passes them to
 * requeryJourney for correct discounted price calculation.
 */
export const updateJourneyMonitor: NonNullable<MutationResolvers['updateJourneyMonitor']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<JourneyMonitor> => {
  Logger.addPersistentLogAttributes({ userId: args.userId, journeyId: args.journeyId });

  const dbJourney = await context.entities.Journey.build(GetItemCommand)
    .key({ userId: args.userId, id: args.journeyId })
    .send();

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

  // Load stored pricing options for correct price calculation
  const storedPricingOptions = loadStoredPricingOptions(dbJourney.Item);

  if (new Date(dbJourney.Item.expires) < new Date()) {
    Logger.info(`Journey has expired`);

    await context.entities.Journey.build(DeleteItemCommand).key({ userId: args.userId, id: args.journeyId }).send();
    context.cache.invalidate([{ typename: 'JourneyMonitor' }]);
    Logger.info(`Deleted journey from database`);

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

  // Get new price for journey — now with stored pricing options
  let journey: HafasJourney | undefined;

  try {
    journey = await context.dbHafas.requeryJourney(dbJourney.Item.refreshToken, storedPricingOptions);
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
        const result = await context.dbHafas.queryJourneys(fromStationId, toStationId, departure, {
          results: 5,
          ...storedPricingOptions,
        });

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
    Logger.warn('Journey recovery failed completely, creating notification', { journeyId: args.journeyId });

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

    return journeyMonitor;
  }
  const newPrice = journey.price?.amount;

  if (!newPrice) {
    Logger.info(`No price found for journey`);
  } else if (newPrice >= dbJourney.Item.limitPrice) {
    Logger.info(`New price ${newPrice} for journey is higher than limit price ${dbJourney.Item.limitPrice}`);

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
  const { Item: dbUser } = await context.entities.User.build(GetItemCommand).key({ id: userId }).send();

  if (!dbUser) {
    throw new Error(`User with id ${userId} not found`);
  }
  if (dbUser.emailNotificationsEnabled) {
    await context.sqs.sendEmailNotificationMessage(userId, notificationId);
  }
}

export function getMeans(journey: HafasJourney): string[] {
  return journey.legs.map((leg) => (leg.line ? leg.line.productName! : leg.walking ? 'walk' : ''));
}

/**
 * Resolves the 'deleteJourneyMonitor' mutation to delete a specific journey.
 */
export const deleteJourneyMonitor: NonNullable<MutationResolvers['deleteJourneyMonitor']> = async (
  _parent,
  { userId, journeyId }: { userId: string; journeyId: string },
  context: GraphQLContext
): Promise<JourneyMonitor> => {
  Logger.addPersistentLogAttributes({ userId: userId, journeyId: journeyId });

  const dbJourney = await context.entities.Journey.build(GetItemCommand).key({ userId: userId, id: journeyId }).send();

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

  await context.entities.Journey.build(DeleteItemCommand).key({ userId: userId, id: journeyId }).send();
  context.cache.invalidate([{ typename: 'JourneyMonitor' }]);
  Logger.info(`Deleted journey from database`);

  return journeyMonitor;
};
