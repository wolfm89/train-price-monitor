import { MutationResolvers, QueryResolvers, UserResolvers } from '../schema/generated/resolvers.generated';
import { User } from '../schema/generated/typeDefs.generated';
import { v4 as uuidv4 } from 'uuid';

export const userResolvers: UserResolvers = {
  id: (parent) => parent.id,
  givenName: (parent) => parent.givenName,
  familyName: (parent) => parent.familyName,
  email: (parent) => parent.email,
  profilePicture: (parent) => parent.profilePicture,
};

export const userQuery: NonNullable<QueryResolvers['user']> = async (parent, args) => {
  const user: User = {
    id: args.id,
    givenName: 'Bart',
    familyName: 'Simpsons',
    email: 'bart@simpsons.com',
    profilePicture: 'img/bart.jpg',
  };
  return user;
};

export const updateProfilePicture: NonNullable<MutationResolvers['updateProfilePicture']> = async (
  _,
  { userId, image }: { userId: string; image: File }
) => {
  const user: User = {
    id: userId,
    givenName: 'Bart',
    familyName: 'Simpsons',
    email: 'bart@simpsons.com',
    profilePicture: image.name,
  };
  return user;
};

export const createUser: NonNullable<MutationResolvers['createUser']> = async (
  _,
  { givenName, familyName, email }: { givenName: string; familyName: string; email: string }
) => {
  const user: User = {
    id: uuidv4(),
    givenName: givenName,
    familyName: familyName,
    email: email,
  };
  return user;
};
