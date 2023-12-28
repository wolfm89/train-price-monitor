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

export const WatchJourney = gql`
  mutation ($userId: ID!, $refreshToken: String!, $limitPrice: Float!) {
    watchJourney(userId: $userId, refreshToken: $refreshToken, limitPrice: $limitPrice)
  }
`;
