import { gql } from 'urql';

export const JourneySearchQuery = gql`
  query ($departure: DateTime!, $from: String!, $to: String!) {
    journeys(departure: $departure, from: $from, to: $to) {
      departure
      arrival
      refreshToken
      means
      price
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
