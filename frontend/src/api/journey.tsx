import { gql } from 'urql';

export const JourneySearchQuery = gql`
  query ($departure: DateTime!, $from: String!, $to: String!, $earlierThan: String, $laterThan: String) {
    journeys(departure: $departure, from: $from, to: $to, earlierThan: $earlierThan, laterThan: $laterThan) {
      journeys {
        departure
        arrival
        refreshToken
        means
        price
      }
      earlierRef
      laterRef
    }
  }
`;

export const MonitorJourney = gql`
  mutation ($userId: ID!, $refreshToken: String!, $limitPrice: Float!, $expires: DateTime!) {
    monitorJourney(userId: $userId, refreshToken: $refreshToken, limitPrice: $limitPrice, expires: $expires) {
      id
    }
  }
`;

export const DeleteJourneyMonitor = gql`
  mutation ($userId: ID!, $journeyId: ID!) {
    deleteJourneyMonitor(userId: $userId, journeyId: $journeyId) {
      id
    }
  }
`;
