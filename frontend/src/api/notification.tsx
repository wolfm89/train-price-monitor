import { gql } from 'urql';

export const MarkNotificationAsRead = gql`
  mutation ($userId: ID!, $notificationId: ID!) {
    markNotificationAsRead(userId: $userId, notificationId: $notificationId) {
      id
    }
  }
`;
