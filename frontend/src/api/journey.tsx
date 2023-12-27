import { gql } from 'urql';

export const JourneySearchQuery = gql`
  query ($departure: DateTime!, $from: String!, $to: String!) {
    journeys(departure: $departure, from: $from, to: $to) {
      from
      to
      departure
      arrival
      refreshToken
      means
      price
    }
  }
`;

export const WatchJourney = gql`
  mutation ($userId: ID!, $journey: JourneyWatchInput!) {
    watchJourney(userId: $userId, journey: $journey) {
      refreshToken
    }
  }
`;
