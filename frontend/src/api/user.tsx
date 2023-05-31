import { gql } from 'urql';

export const UpdateProfilePicture = gql`
  mutation ($id: ID!, $image: File!) {
    updateProfilePicture(userId: $id, image: $image) {
      id
      givenName
      familyName
    }
  }
`;

export const CreateUser = gql`
  mutation ($email: String!, $familyName: String!, $givenName: String!) {
    createUser(email: $email, familyName: $familyName, givenName: $givenName) {
      id
    }
  }
`;
