import { GraphQLContext } from '../context';
import { GetItemCommand, UpdateItemCommand } from '../model/trainPriceMonitor';
import { MutationResolvers, NotificationResolvers } from '../schema/generated/resolvers.generated';
import Logger from '../lib/logger';
import {
  JourneyExpiryNotification,
  JourneyStaleNotification,
  PriceAlertNotification,
} from '../schema/generated/typeDefs.generated';
import { NOTIFICATION_TYPES } from './notificationTypes';

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
  // Add user and notification ID to persistent log attributes
  Logger.addPersistentLogAttributes({ userId: args.userId, notificationId: args.notificationId });

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
};

export const sendEmailNotification: NonNullable<MutationResolvers['sendEmailNotification']> = async (
  _parent,
  { userId, notificationId },
  context: GraphQLContext
): Promise<JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification> => {
  // Add user and notification ID to persistent log attributes
  Logger.addPersistentLogAttributes({ userId, notificationId });

  // Retrieve the notification from the database
  const { Item: dbNotification } = await context.entities.Notification.build(GetItemCommand)
    .key({ userId, id: notificationId })
    .send();

  // Check if the notification exists
  if (!dbNotification) {
    throw new Error('Notification not found in database');
  }

  // Check if the notification is already sent
  if (dbNotification.sent) {
    Logger.info(`Notification is already sent`);
    return dbNotification as unknown as JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification;
  }

  // Get the user from the database
  const { Item: dbUser } = await context.entities.User.build(GetItemCommand).key({ id: userId }).send();
  if (!dbUser) {
    throw new Error('User not found in database');
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
  const emailNotificationInfo = await NOTIFICATION_TYPES[dbNotification.type].formatEmail(
    context,
    dbUser as unknown as import('../schema/generated/typeDefs.generated').User,
    data
  );
  await context.ses.sendEmailNotification(emailNotificationInfo);

  // Update the notification in the database
  const { Attributes: notification } = await context.entities.Notification.build(UpdateItemCommand)
    .item({ userId, id: notificationId, sent: true })
    .options({ returnValues: 'ALL_NEW' })
    .send();

  context.cache.invalidate([{ typename: 'Notification' }]);
  Logger.info(`Marked notification as sent`);

  return notification as unknown as JourneyExpiryNotification | JourneyStaleNotification | PriceAlertNotification;
};
