export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: string;
  String: string;
  Boolean: boolean;
  Int: number;
  Float: number;
  File: File;
};

export type Mutation = {
  __typename?: 'Mutation';
  createUser?: Maybe<User>;
  updateProfilePicture?: Maybe<User>;
};

export type MutationCreateUserArgs = {
  email: Scalars['String'];
  familyName: Scalars['String'];
  givenName: Scalars['String'];
};

export type MutationUpdateProfilePictureArgs = {
  image: Scalars['File'];
  userId: Scalars['ID'];
};

export type Query = {
  __typename?: 'Query';
  user?: Maybe<User>;
};

export type QueryUserArgs = {
  id: Scalars['ID'];
};

export type User = {
  __typename?: 'User';
  email: Scalars['String'];
  familyName: Scalars['String'];
  givenName: Scalars['String'];
  id: Scalars['ID'];
  profilePicture?: Maybe<Scalars['String']>;
};
