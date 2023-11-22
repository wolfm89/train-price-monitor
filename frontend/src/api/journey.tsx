import { gql } from 'urql';

export const JourneySearchQuery = gql`
  query ($departure: DateTime!, $from: String!, $to: String!) {
    journeys(departure: $departure, from: $from, to: $to) {
      departure
      arrival
      means
      price
    }
  }
`;
