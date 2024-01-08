import { gql } from 'urql';

export const UpdateUserProfilePicture = gql`
  mutation ($id: ID!, $image: File!) {
    updateUserProfilePicture(id: $id, image: $image) {
      id
      profilePicture
    }
  }
`;

export const CreateUser = gql`
  mutation ($id: ID!, $email: String!, $familyName: String!, $givenName: String!) {
    createUser(id: $id, email: $email, familyName: $familyName, givenName: $givenName) {
      id
    }
  }
`;

export const ActivateUser = gql`
  mutation ($id: ID!) {
    activateUser(id: $id) {
      id
      activated
    }
  }
`;

export const UserActivationStatusQuery = gql`
  query ($id: ID!) {
    user(id: $id) {
      activated
    }
  }
`;

export const UserProfilePictureUrlQuery = gql`
  query ($id: ID!) {
    userProfilePicturePresignedUrl(id: $id) {
      url
    }
  }
`;

export const UserNotificationsQuery = gql`
  query ($id: ID!, $notificationsLimit: Int, $read: Boolean) {
    user(id: $id) {
      id
      notifications(limit: $notificationsLimit, read: $read) {
        id
        type
        timestamp
        read
        ... on PriceAlertNotification {
          journeyMonitor {
            journey {
              from
              to
            }
          }
        }
        ... on JourneyExpiryNotification {
          journey {
            from
            to
          }
        }
      }
    }
  }
`;

export const UserJourneysQuery = gql`
  query ($id: ID!) {
    user(id: $id) {
      id
      journeyMonitors {
        id
        limitPrice
        journey {
          refreshToken
          from
          to
          departure
          arrival
          means
          price
        }
      }
    }
  }
`;
