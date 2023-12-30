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
  DateTime: any;
  File: File;
};

export type Journey = {
  __typename?: 'Journey';
  arrival: Scalars['DateTime'];
  departure: Scalars['DateTime'];
  from: Scalars['String'];
  means: Array<Maybe<Scalars['String']>>;
  price?: Maybe<Scalars['Float']>;
  refreshToken: Scalars['String'];
  to: Scalars['String'];
};

export type Location = {
  __typename?: 'Location';
  id: Scalars['String'];
  name: Scalars['String'];
  type: Scalars['String'];
};

export type Mutation = {
  __typename?: 'Mutation';
  activateUser?: Maybe<User>;
  createUser?: Maybe<User>;
  updateUserProfilePicture?: Maybe<User>;
  watchJourney?: Maybe<Scalars['ID']>;
};

export type MutationActivateUserArgs = {
  id: Scalars['ID'];
};

export type MutationCreateUserArgs = {
  email: Scalars['String'];
  familyName: Scalars['String'];
  givenName: Scalars['String'];
  id: Scalars['ID'];
};

export type MutationUpdateUserProfilePictureArgs = {
  id: Scalars['ID'];
  image: Scalars['File'];
};

export type MutationWatchJourneyArgs = {
  limitPrice: Scalars['Float'];
  refreshToken: Scalars['String'];
  userId: Scalars['ID'];
};

export type Notification = {
  __typename?: 'Notification';
  id: Scalars['ID'];
  journeyId?: Maybe<Scalars['ID']>;
  message: Scalars['String'];
  read: Scalars['Boolean'];
  timestamp: Scalars['DateTime'];
  userId: Scalars['ID'];
};

export type PresignedUrl = {
  __typename?: 'PresignedUrl';
  id: Scalars['ID'];
  url?: Maybe<Scalars['String']>;
};

export type Query = {
  __typename?: 'Query';
  journeys?: Maybe<Array<Maybe<Journey>>>;
  locations?: Maybe<Array<Maybe<Location>>>;
  user?: Maybe<User>;
  userProfilePicturePresignedUrl?: Maybe<PresignedUrl>;
};

export type QueryJourneysArgs = {
  departure: Scalars['DateTime'];
  from: Scalars['String'];
  to: Scalars['String'];
};

export type QueryLocationsArgs = {
  query: Scalars['String'];
};

export type QueryUserArgs = {
  id: Scalars['ID'];
};

export type QueryUserProfilePicturePresignedUrlArgs = {
  id: Scalars['ID'];
};

export type User = {
  __typename?: 'User';
  activated: Scalars['Boolean'];
  email: Scalars['String'];
  familyName: Scalars['String'];
  givenName: Scalars['String'];
  id: Scalars['ID'];
  notifications?: Maybe<Array<Maybe<Notification>>>;
  profilePicture?: Maybe<Scalars['String']>;
};

export type UserNotificationsArgs = {
  limit?: InputMaybe<Scalars['Int']>;
};
