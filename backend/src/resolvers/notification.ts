import { NotificationResolvers } from '../schema/generated/resolvers.generated';
import { NOTIFICATION_TYPES } from './notificationTypes';

export const notificationResolvers: NotificationResolvers = {
  __resolveType(data) {
    if (data.type === NOTIFICATION_TYPES.PRICE_ALERT.name) {
      return 'PriceAlertNotification';
    }
    if (data.type === NOTIFICATION_TYPES.JOURNEY_EXPIRED.name) {
      return 'JourneyExpiryNotification';
    }
    return null; // GraphQLError is thrown
  },
};
