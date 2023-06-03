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
