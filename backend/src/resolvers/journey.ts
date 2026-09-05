import { Journey as HafasJourney } from 'hafas-client';
import { GraphQLContext } from '../context';
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ScanCommand,
  QueryCommand,
  StoredJourney,
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
 * Stop starting new journey refreshes past this point in a run, leaving headroom
 * for the one in flight to finish before the refresher's 120 s Lambda timeout.
 */
const REFRESH_ABORT_THRESHOLD_MS = 90_000;

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

  if (options.loyaltyCard) {
    const loyaltyCard: LoyaltyCardData = {
      type: options.loyaltyCard.type,
      discount: options.loyaltyCard.discount ?? undefined,
      class: options.loyaltyCard.class ?? undefined,
    };
    validateLoyaltyCard(loyaltyCard);
    pricingOpts.loyaltyCard = loyaltyCard;
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
  bike?: boolean;
  loyaltyCard?: string;
  ageGroup?: string;
  deutschlandTicketDiscount?: boolean;
} {
  if (!options) return {};

  const snapshot: {
    firstClass?: boolean;
    bike?: boolean;
    loyaltyCard?: string;
    ageGroup?: string;
    deutschlandTicketDiscount?: boolean;
  } = {};

  if (options.firstClass !== undefined && options.firstClass !== null) {
    snapshot.firstClass = options.firstClass;
  }

  if (options.loyaltyCard) {
    snapshot.loyaltyCard = JSON.stringify({
      type: options.loyaltyCard.type,
      discount: options.loyaltyCard.discount ?? undefined,
      class: options.loyaltyCard.class ?? undefined,
    });
  }

  if (options.ageGroup) {
    snapshot.ageGroup = options.ageGroup;
  }

  if (options.deutschlandTicketDiscount !== undefined && options.deutschlandTicketDiscount !== null) {
    snapshot.deutschlandTicketDiscount = options.deutschlandTicketDiscount;
  }

  if (options.bike !== undefined && options.bike !== null) {
    snapshot.bike = options.bike;
  }

  return snapshot;
}

import { loadStoredPricingOptions } from '../lib/pricingOptions';

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
      expires: args.expires instanceof Date ? args.expires.toISOString() : args.expires,
      fromId: args.fromId,
      toId: args.toId,
      departure: args.departure instanceof Date ? args.departure.toISOString() : args.departure,
      ...pricingSnapshot,
    })
    .send();

  context.cache.invalidate([{ typename: 'JourneyMonitor' }]);

  return {
    id: journeyMonitorId,
    userId: args.userId,
    limitPrice: args.limitPrice,
    expires: args.expires,
    unavailable: false,
    journey: { refreshToken: args.refreshToken },
  };
};

/**
 * Resolves the 'updateJourneyMonitors' mutation to update all stored journeys.
 *
 * Journeys are refreshed inline rather than fanned out over SQS. Each SQS
 * message became its own Lambda invocation with its own Chromium cold start,
 * so refreshing N journeys paid the ~4 s browser startup N times; handling them
 * in one invocation pays it once and makes the per-journey cost roughly 3x
 * cheaper as the number of monitored journeys grows. It also removes the
 * retry-to-DLQ path that previously accumulated poison messages whenever DB was
 * unreachable.
 */
export const updateJourneyMonitors: NonNullable<MutationResolvers['updateJourneyMonitors']> = async (
  _parent,
  _args,
  context: GraphQLContext
): Promise<number> => {
  const startedAt = Date.now();

  const { Items: allJourneys } = await context.entities.TrainPriceMonitorTable.build(ScanCommand)
    .entities(context.entities.Journey)
    .send();

  const journeys = (allJourneys ?? []) as StoredJourney[];

  // Oldest snapshot first, so if the run is cut short the least fresh journeys
  // are the ones that got refreshed rather than always the same arbitrary few.
  journeys.sort((a, b) => (a.lastCheckedAt ?? '').localeCompare(b.lastCheckedAt ?? ''));

  Logger.info(`Found ${journeys.length} journeys to update`);

  let refreshed = 0;

  for (const journey of journeys) {
    // Leave room to finish the journey in flight before the Lambda timeout.
    // Anything skipped is simply picked up by the next scheduled run.
    if (Date.now() - startedAt > REFRESH_ABORT_THRESHOLD_MS) {
      Logger.warn('Approaching timeout, deferring remaining journeys to the next run', {
        remaining: journeys.length - refreshed,
      });
      break;
    }

    try {
      // Expired journeys are refreshed too, not skipped: refreshJourneyMonitor
      // is what deletes them and notifies the user, so skipping them here left
      // them stored forever.
      await refreshJourneyMonitor(context, journey.userId, journey.id);
      refreshed++;
    } catch (error) {
      Logger.error('Failed to refresh journey', {
        journeyId: journey.id,
        userId: journey.userId,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  return journeys.length;
};

/**
 * Resolves the 'updateJourneyMonitor' mutation to update a specific journey.
 * Loads stored pricing options from the Journey entity and passes them to
 * requeryJourney for correct discounted price calculation.
 */
/**
 * Refreshes a single stored journey: re-queries DB, writes the price snapshot
 * the read path serves, and raises expiry/stale/price-alert notifications.
 *
 * Extracted from the `updateJourneyMonitor` mutation so the hourly scan can
 * call it directly instead of fanning out one SQS message (and therefore one
 * browser cold start) per journey.
 */
async function refreshJourneyMonitor(
  context: GraphQLContext,
  userId: string,
  journeyId: string
): Promise<JourneyMonitor> {
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
    unavailable: false,
    journey: { refreshToken: dbJourney.Item.refreshToken },
  };

  // Load stored pricing options for correct price calculation
  const storedPricingOptions = loadStoredPricingOptions(dbJourney.Item);

  if (new Date(dbJourney.Item.expires) < new Date()) {
    Logger.info(`Journey has expired`);

    await context.entities.Journey.build(DeleteItemCommand).key({ userId: userId, id: journeyId }).send();
    context.cache.invalidate([{ typename: 'JourneyMonitor' }]);
    Logger.info(`Deleted journey from database`);

    const notificationId = uuidv4();
    await context.entities.Notification.build(PutItemCommand)
      .item({
        id: notificationId,
        userId: userId,
        type: NOTIFICATION_TYPES.JOURNEY_EXPIRED.name,
        read: false,
        sent: false,
        timestamp: new Date().toISOString(),
        data: JSON.stringify({ refreshToken: dbJourney.Item.refreshToken }),
      })
      .send();
    context.cache.invalidate([{ typename: 'Notification' }]);

    await deletePriceAlertNotificationsForJourney(context, userId, journeyId);

    await sendNotificationEmailIfEnabled(context, userId, notificationId);

    return journeyMonitor;
  }

  // Existing notifications gate only the *creation* of new ones. The price
  // snapshot further down is refreshed on every run regardless, so the
  // watchlist keeps showing the current price while an alert is still pending.
  const existingNotifications = await context.entities.TrainPriceMonitorTable.build(QueryCommand)
    .entities(context.entities.Notification)
    .query({ partition: `USER#${userId}`, range: { beginsWith: 'NOTIFICATION#' } })
    .send();

  const notificationsArray = existingNotifications?.Items ?? [];
  const hasNotificationForJourney = (type: string): boolean =>
    notificationsArray.some((item: { data?: string; type?: string }) => {
      if (item.type !== type || !item.data) return false;
      try {
        return JSON.parse(item.data).journeyId === journeyId;
      } catch {
        return false;
      }
    });

  // Get new price for journey — now with stored pricing options
  let journey: HafasJourney | undefined;

  try {
    journey = await context.dbHafas.requeryJourney(dbJourney.Item.refreshToken, storedPricingOptions);
  } catch (error) {
    Logger.error('Error requerying journey', {
      journeyId: journeyId,
      error: error instanceof Error ? error.message : error,
    });
    throw error;
  }

  if (!journey) {
    // Token is stale — attempt recovery using stored station IDs and departure
    Logger.warn('Refresh token stale, attempting recovery', { journeyId: journeyId });

    const fromStationId = dbJourney.Item.fromId as string | undefined;
    const toStationId = dbJourney.Item.toId as string | undefined;
    const storedDeparture = dbJourney.Item.departure as string | undefined;

    if (!fromStationId || !toStationId || !storedDeparture) {
      Logger.warn('Missing station IDs or departure for recovery, skipping', { journeyId: journeyId });
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
            .item({ userId: userId, id: journeyId, refreshToken: matchingJourney.refreshToken! })
            .send();
          journey = matchingJourney;
          Logger.info('Successfully recovered journey with new token', { journeyId: journeyId });
        }
      } catch (recoveryError) {
        Logger.error('Journey recovery failed', {
          journeyId: journeyId,
          error: recoveryError instanceof Error ? recoveryError.message : recoveryError,
        });
      }
    }
  }

  if (!journey) {
    Logger.warn('Journey recovery failed completely, creating notification', { journeyId: journeyId });

    const hasExistingStaleNotification = hasNotificationForJourney(NOTIFICATION_TYPES.JOURNEY_STALE.name);

    if (hasExistingStaleNotification) {
      Logger.info('JOURNEY_STALE notification already exists for journey, skipping');
      return journeyMonitor;
    }

    const notificationId = uuidv4();
    await context.entities.Notification.build(PutItemCommand)
      .item({
        id: notificationId,
        userId: userId,
        type: NOTIFICATION_TYPES.JOURNEY_STALE.name,
        read: false,
        sent: false,
        timestamp: new Date().toISOString(),
        data: JSON.stringify({
          journeyId: journeyId,
          fromId: dbJourney.Item.fromId,
          toId: dbJourney.Item.toId,
        }),
      })
      .send();
    context.cache.invalidate([{ typename: 'Notification' }]);

    await sendNotificationEmailIfEnabled(context, userId, notificationId);

    return journeyMonitor;
  }
  // Persist the snapshot that the read path serves. This is the only place DB
  // journey data enters DynamoDB, so the watchlist never needs a live lookup.
  const firstLeg = journey.legs[0];
  const lastLeg = journey.legs[journey.legs.length - 1];
  const cachedDeparture = firstLeg.plannedDeparture ?? firstLeg.departure;
  const cachedArrival = lastLeg.plannedArrival ?? lastLeg.arrival;

  await context.entities.Journey.build(UpdateItemCommand)
    .item({
      userId: userId,
      id: journeyId,
      refreshToken: journey.refreshToken ?? dbJourney.Item.refreshToken,
      cachedPrice: journey.price?.amount,
      cachedDeparture: cachedDeparture ? new Date(cachedDeparture).toISOString() : undefined,
      cachedArrival: cachedArrival ? new Date(cachedArrival).toISOString() : undefined,
      cachedMeans: JSON.stringify(getMeans(journey)),
      cachedFrom: firstLeg.origin?.name,
      cachedTo: lastLeg.destination?.name,
      lastCheckedAt: new Date().toISOString(),
    })
    .send();
  context.cache.invalidate([{ typename: 'JourneyMonitor' }]);

  journeyMonitor.unavailable = false;
  journeyMonitor.from = firstLeg.origin?.name ?? undefined;
  journeyMonitor.to = lastLeg.destination?.name ?? undefined;
  journeyMonitor.journey = {
    refreshToken: journey.refreshToken ?? dbJourney.Item.refreshToken,
    departure: cachedDeparture ? new Date(cachedDeparture) : undefined,
    arrival: cachedArrival ? new Date(cachedArrival) : undefined,
    means: getMeans(journey),
    price: journey.price?.amount,
  };

  const newPrice = journey.price?.amount;

  if (!newPrice) {
    Logger.info(`No price found for journey`);
  } else if (newPrice >= dbJourney.Item.limitPrice) {
    Logger.info(`New price ${newPrice} for journey is higher than limit price ${dbJourney.Item.limitPrice}`);

    if (hasNotificationForJourney(NOTIFICATION_TYPES.PRICE_ALERT.name)) {
      Logger.info(`PRICE_ALERT notification already exists for journey, skipping`);
      return journeyMonitor;
    }

    const notificationId = uuidv4();
    await context.entities.Notification.build(PutItemCommand)
      .item({
        id: notificationId,
        userId: userId,
        type: NOTIFICATION_TYPES.PRICE_ALERT.name,
        read: false,
        sent: false,
        timestamp: new Date().toISOString(),
        data: JSON.stringify({ journeyId: journeyId }),
      })
      .send();
    context.cache.invalidate([{ typename: 'Notification' }]);

    await sendNotificationEmailIfEnabled(context, userId, notificationId);

    Logger.info(`Sent notification for journey`);
  } else {
    Logger.info(`New price ${newPrice} for journey is still lower than limit price ${dbJourney.Item.limitPrice}`);
  }

  return journeyMonitor;
}

/**
 * Resolves the 'updateJourneyMonitor' mutation to update a specific journey.
 */
export const updateJourneyMonitor: NonNullable<MutationResolvers['updateJourneyMonitor']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<JourneyMonitor> => refreshJourneyMonitor(context, args.userId, args.journeyId);

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
    unavailable: false,
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
