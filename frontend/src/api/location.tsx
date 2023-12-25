import { gql } from 'urql';

export const LocationSearchQuery = gql`
  query ($query: String!) {
    locations(query: $query) {
      id
      name
    }
  }
`;
