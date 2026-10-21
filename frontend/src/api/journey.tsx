import { gql } from 'urql';

export const JourneySearchQuery = gql`
  query (
    $departure: DateTime!
    $from: String!
    $to: String!
    $earlierThan: String
    $laterThan: String
    $options: JourneySearchOptions
  ) {
    journeys(
      departure: $departure
      from: $from
      to: $to
      earlierThan: $earlierThan
      laterThan: $laterThan
      options: $options
    ) {
      journeys {
        fromId
        toId
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

/**
 * Asking the API to establish the upstream DB session as soon as the search page
 * opens. A session lives inside a Lambda execution environment and takes ~8-10 s
 * to build (plus another ~10 s when the vendor hands out a blocked one), which
 * used to be paid by the user's first search. Picking stations and a date takes
 * longer than that, so the setup happens while they fill in the form.
 */
export const MonitorJourney = gql`
  mutation (
    $userId: ID!
    $refreshToken: String!
    $limitPrice: Float!
    $expires: DateTime!
    $fromId: String!
    $toId: String!
    $departure: DateTime!
    $options: JourneySearchOptions
  ) {
    monitorJourney(
      userId: $userId
      refreshToken: $refreshToken
      limitPrice: $limitPrice
      expires: $expires
      fromId: $fromId
      toId: $toId
      departure: $departure
      options: $options
    ) {
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
