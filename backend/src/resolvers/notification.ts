import { GraphQLContext } from '../context';
import { GetItemCommand, UpdateItemCommand } from '../model/trainPriceMonitor';
import { MutationResolvers, NotificationResolvers } from '../schema/generated/resolvers.generated';
import Logger from '../lib/logger';
import {
  JourneyExpiryNotification,
  JourneyStaleNotification,
  PriceAlertNotification,
} from '../schema/generated/typeDefs.generated';
import { NOTIFICATION_TYPES, NotificationSkipError } from './notificationTypes';
import { requireInternal, requireUserAccess } from '../lib/auth';

export const notificationResolvers: NotificationResolvers = {
  __resolveType(data) {
    if (data.type === NOTIFICATION_TYPES.PRICE_ALERT.name) {
      return 'PriceAlertNotification';
    }
    if (data.type === NOTIFICATION_TYPES.JOURNEY_EXPIRED.name) {
      return 'JourneyExpiryNotification';
    }
    if (data.type === NOTIFICATION_TYPES.JOURNEY_STALE.name) {
      return 'JourneyStaleNotification';
    }
    return null;
  },
};

export const markNotificationAsRead: NonNullable<MutationResolvers['markNotificationAsRead']> = async (
  _parent,
  args,
  context: GraphQLContext
): Promise<JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification> => {
  await requireUserAccess(context, args.userId);

  Logger.appendKeys({ userId: args.userId, notificationId: args.notificationId });
  try {
    // Retrieve the notification from the database
    const { Item: dbNotification } = await context.entities.Notification.build(GetItemCommand)
      .key({ userId: args.userId, id: args.notificationId })
      .send();

    // Check if the notification exists
    if (!dbNotification) {
      throw new Error('Notification not found in database');
    }

    // Check if the notification is already read
    if (dbNotification.read) {
      Logger.info(`Notification is already read`);
      return dbNotification as unknown as JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification;
    }

    // Update the notification in the database
    const { Attributes: notification } = await context.entities.Notification.build(UpdateItemCommand)
      .item({ userId: args.userId, id: args.notificationId, read: true })
      .options({ returnValues: 'ALL_NEW' })
      .send();

    context.cache.invalidate([{ typename: 'Notification' }]);
    Logger.info(`Marked notification as read`);

    return notification as unknown as JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification;
  } finally {
    Logger.removeKeys(['userId', 'notificationId']);
  }
};

export const sendEmailNotification: NonNullable<MutationResolvers['sendEmailNotification']> = async (
  _parent,
  { userId, notificationId },
  context: GraphQLContext
): Promise<JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification | null> => {
  // The SQS worker is the only caller. Exposing this on the public API would let
  // any authenticated user trigger arbitrary emails for another partition.
  requireInternal(context);

  Logger.appendKeys({ userId, notificationId });
  try {
    // Retrieve the notification from the database
    const { Item: dbNotification } = await context.entities.Notification.build(GetItemCommand)
      .key({ userId, id: notificationId })
      .send();

    // A queued email whose notification was deleted (journey expired or deleted)
    // is an expected no-op, not a transient failure: ack it instead of retrying
    // into the DLQ.
    if (!dbNotification) {
      Logger.warn('Notification not found, skipping email');
      return null;
    }

    // Check if the notification is already sent
    if (dbNotification.sent) {
      Logger.info(`Notification is already sent`);
      return dbNotification as unknown as JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification;
    }

    // Get the user from the database
    const { Item: dbUser } = await context.entities.User.build(GetItemCommand).key({ id: userId }).send();
    if (!dbUser) {
      Logger.warn('User not found, skipping email');
      return null;
    }

    // Send the email
    let data: Record<string, unknown> = {};
    if (dbNotification.data) {
      try {
        data = typeof dbNotification.data === 'string' ? JSON.parse(dbNotification.data) : dbNotification.data;
      } catch {
        data = {};
      }
    }

    let emailNotificationInfo;
    try {
      emailNotificationInfo = await NOTIFICATION_TYPES[dbNotification.type].formatEmail(
        context,
        dbUser as unknown as import('../schema/generated/typeDefs.generated').User,
        data
      );
    } catch (error) {
      if (error instanceof NotificationSkipError) {
        Logger.warn('Notification email skipped', { reason: error.message });
        return null;
      }
      throw error;
    }

    if (!emailNotificationInfo) {
      Logger.warn('Notification email skipped: formatter returned no content');
      return null;
    }

    await context.ses.sendEmailNotification(emailNotificationInfo);

    // Update the notification in the database
    const { Attributes: notification } = await context.entities.Notification.build(UpdateItemCommand)
      .item({ userId, id: notificationId, sent: true })
      .options({ returnValues: 'ALL_NEW' })
      .send();

    context.cache.invalidate([{ typename: 'Notification' }]);
    Logger.info(`Marked notification as sent`);

    return notification as unknown as JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification;
  } finally {
    Logger.removeKeys(['userId', 'notificationId']);
  }
};
