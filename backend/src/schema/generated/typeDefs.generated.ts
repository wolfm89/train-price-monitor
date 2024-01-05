export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
  Int: { input: number; output: number };
  Float: { input: number; output: number };
  DateTime: { input: any; output: any };
  File: { input: File; output: File };
};

export type Journey = {
  __typename?: 'Journey';
  arrival?: Maybe<Scalars['DateTime']['output']>;
  departure?: Maybe<Scalars['DateTime']['output']>;
  from?: Maybe<Scalars['String']['output']>;
  means?: Maybe<Array<Maybe<Scalars['String']['output']>>>;
  price?: Maybe<Scalars['Float']['output']>;
  refreshToken: Scalars['String']['output'];
  to?: Maybe<Scalars['String']['output']>;
};

export type JourneyExpiryNotification = Notification & {
  __typename?: 'JourneyExpiryNotification';
  id: Scalars['ID']['output'];
  journey: Journey;
  read: Scalars['Boolean']['output'];
  timestamp: Scalars['DateTime']['output'];
  type: Scalars['ID']['output'];
  userId: Scalars['ID']['output'];
};

export type JourneyMonitor = {
  __typename?: 'JourneyMonitor';
  expires: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  journey?: Maybe<Journey>;
  limitPrice: Scalars['Float']['output'];
  userId: Scalars['ID']['output'];
};

export type Location = {
  __typename?: 'Location';
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
  type: Scalars['String']['output'];
};

export type Mutation = {
  __typename?: 'Mutation';
  activateUser?: Maybe<User>;
  createUser?: Maybe<User>;
  monitorJourney?: Maybe<JourneyMonitor>;
  updateJourneyMonitor?: Maybe<JourneyMonitor>;
  updateJourneyMonitors?: Maybe<Scalars['Int']['output']>;
  updateUserProfilePicture?: Maybe<User>;
};

export type MutationActivateUserArgs = {
  id: Scalars['ID']['input'];
};

export type MutationCreateUserArgs = {
  email: Scalars['String']['input'];
  familyName: Scalars['String']['input'];
  givenName: Scalars['String']['input'];
  id: Scalars['ID']['input'];
};

export type MutationMonitorJourneyArgs = {
  expires: Scalars['DateTime']['input'];
  limitPrice: Scalars['Float']['input'];
  refreshToken: Scalars['String']['input'];
  userId: Scalars['ID']['input'];
};

export type MutationUpdateJourneyMonitorArgs = {
  journeyId: Scalars['ID']['input'];
  userId: Scalars['ID']['input'];
};

export type MutationUpdateUserProfilePictureArgs = {
  id: Scalars['ID']['input'];
  image: Scalars['File']['input'];
};

export type Notification = {
  id: Scalars['ID']['output'];
  read: Scalars['Boolean']['output'];
  timestamp: Scalars['DateTime']['output'];
  type: Scalars['ID']['output'];
  userId: Scalars['ID']['output'];
};

export type PresignedUrl = {
  __typename?: 'PresignedUrl';
  id: Scalars['ID']['output'];
  url?: Maybe<Scalars['String']['output']>;
};

export type PriceAlertNotification = Notification & {
  __typename?: 'PriceAlertNotification';
  id: Scalars['ID']['output'];
  journeyMonitor: JourneyMonitor;
  read: Scalars['Boolean']['output'];
  timestamp: Scalars['DateTime']['output'];
  type: Scalars['ID']['output'];
  userId: Scalars['ID']['output'];
};

export type Query = {
  __typename?: 'Query';
  journeys?: Maybe<Array<Maybe<Journey>>>;
  locations?: Maybe<Array<Maybe<Location>>>;
  user?: Maybe<User>;
  userProfilePicturePresignedUrl?: Maybe<PresignedUrl>;
};

export type QueryJourneysArgs = {
  departure: Scalars['DateTime']['input'];
  from: Scalars['String']['input'];
  to: Scalars['String']['input'];
};

export type QueryLocationsArgs = {
  query: Scalars['String']['input'];
};

export type QueryUserArgs = {
  id: Scalars['ID']['input'];
};

export type QueryUserProfilePicturePresignedUrlArgs = {
  id: Scalars['ID']['input'];
};

export type User = {
  __typename?: 'User';
  activated: Scalars['Boolean']['output'];
  email: Scalars['String']['output'];
  familyName: Scalars['String']['output'];
  givenName: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  journeyMonitors?: Maybe<Array<Maybe<JourneyMonitor>>>;
  notifications?: Maybe<Array<Maybe<Notification>>>;
  profilePicture?: Maybe<Scalars['String']['output']>;
};

export type UserJourneyMonitorsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};

export type UserNotificationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};
