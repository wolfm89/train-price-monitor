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

export enum AgeGroup {
  Adult = 'ADULT',
  Baby = 'BABY',
  Child = 'CHILD',
  Senior = 'SENIOR',
  Youth = 'YOUTH',
}

export type Journey = {
  __typename?: 'Journey';
  arrival?: Maybe<Scalars['DateTime']['output']>;
  departure?: Maybe<Scalars['DateTime']['output']>;
  fromId?: Maybe<Scalars['String']['output']>;
  means?: Maybe<Array<Maybe<Scalars['String']['output']>>>;
  price?: Maybe<Scalars['Float']['output']>;
  refreshToken: Scalars['String']['output'];
  toId?: Maybe<Scalars['String']['output']>;
};

export type JourneyExpiryNotification = Notification & {
  __typename?: 'JourneyExpiryNotification';
  from: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  read: Scalars['Boolean']['output'];
  sent: Scalars['Boolean']['output'];
  timestamp: Scalars['DateTime']['output'];
  to: Scalars['String']['output'];
  type: Scalars['ID']['output'];
  userId: Scalars['ID']['output'];
};

export type JourneyMonitor = {
  __typename?: 'JourneyMonitor';
  expires: Scalars['DateTime']['output'];
  from?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  journey?: Maybe<Journey>;
  limitPrice: Scalars['Float']['output'];
  to?: Maybe<Scalars['String']['output']>;
  userId: Scalars['ID']['output'];
};

export type JourneySearchOptions = {
  ageGroup?: InputMaybe<AgeGroup>;
  bike?: InputMaybe<Scalars['Boolean']['input']>;
  deutschlandTicketDiscount?: InputMaybe<Scalars['Boolean']['input']>;
  firstClass?: InputMaybe<Scalars['Boolean']['input']>;
  loyaltyCards?: InputMaybe<Array<LoyaltyCardInput>>;
  products?: InputMaybe<ProductFilter>;
  results?: InputMaybe<Scalars['Int']['input']>;
  transferTime?: InputMaybe<Scalars['Int']['input']>;
  transfers?: InputMaybe<Scalars['Int']['input']>;
};

export type JourneyStaleNotification = Notification & {
  __typename?: 'JourneyStaleNotification';
  from: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  journeyId: Scalars['ID']['output'];
  read: Scalars['Boolean']['output'];
  sent: Scalars['Boolean']['output'];
  timestamp: Scalars['DateTime']['output'];
  to: Scalars['String']['output'];
  type: Scalars['ID']['output'];
  userId: Scalars['ID']['output'];
};

export type JourneysResult = {
  __typename?: 'JourneysResult';
  earlierRef?: Maybe<Scalars['String']['output']>;
  journeys?: Maybe<Array<Maybe<Journey>>>;
  laterRef?: Maybe<Scalars['String']['output']>;
};

export type Location = {
  __typename?: 'Location';
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
  type: Scalars['String']['output'];
};

export type LoyaltyCard = {
  __typename?: 'LoyaltyCard';
  class?: Maybe<Scalars['Int']['output']>;
  discount?: Maybe<Scalars['Int']['output']>;
  type: LoyaltyCardType;
};

export type LoyaltyCardInput = {
  class?: InputMaybe<Scalars['Int']['input']>;
  discount?: InputMaybe<Scalars['Int']['input']>;
  type: LoyaltyCardType;
};

export enum LoyaltyCardType {
  AtKlimaticket = 'AT_KLIMATICKET',
  Bahncard = 'BAHNCARD',
  Generalabonnement = 'GENERALABONNEMENT',
  Halbtaxabo = 'HALBTAXABO',
  Nl_40 = 'NL_40',
  Shcard = 'SHCARD',
  Voordeelurenabo = 'VOORDEELURENABO',
  Vorteilscard = 'VORTEILSCARD',
}

export type Mutation = {
  __typename?: 'Mutation';
  createUser?: Maybe<User>;
  deleteJourneyMonitor?: Maybe<JourneyMonitor>;
  deleteUser?: Maybe<User>;
  markNotificationAsRead?: Maybe<Notification>;
  monitorJourney?: Maybe<JourneyMonitor>;
  sendEmailNotification?: Maybe<Notification>;
  updateJourneyMonitor?: Maybe<JourneyMonitor>;
  updateJourneyMonitors?: Maybe<Scalars['Int']['output']>;
  updateTravelPreferences?: Maybe<User>;
  updateUserProfilePicture?: Maybe<User>;
  updateUserSettings?: Maybe<User>;
};

export type MutationCreateUserArgs = {
  email: Scalars['String']['input'];
  familyName?: InputMaybe<Scalars['String']['input']>;
  givenName: Scalars['String']['input'];
  id: Scalars['ID']['input'];
};

export type MutationDeleteJourneyMonitorArgs = {
  journeyId: Scalars['ID']['input'];
  userId: Scalars['ID']['input'];
};

export type MutationDeleteUserArgs = {
  id: Scalars['ID']['input'];
};

export type MutationMarkNotificationAsReadArgs = {
  notificationId: Scalars['ID']['input'];
  userId: Scalars['ID']['input'];
};

export type MutationMonitorJourneyArgs = {
  departure: Scalars['DateTime']['input'];
  expires: Scalars['DateTime']['input'];
  fromId: Scalars['String']['input'];
  limitPrice: Scalars['Float']['input'];
  options?: InputMaybe<JourneySearchOptions>;
  refreshToken: Scalars['String']['input'];
  toId: Scalars['String']['input'];
  userId: Scalars['ID']['input'];
};

export type MutationSendEmailNotificationArgs = {
  notificationId: Scalars['ID']['input'];
  userId: Scalars['ID']['input'];
};

export type MutationUpdateJourneyMonitorArgs = {
  journeyId: Scalars['ID']['input'];
  userId: Scalars['ID']['input'];
};

export type MutationUpdateTravelPreferencesArgs = {
  ageGroup?: InputMaybe<AgeGroup>;
  deutschlandTicketDiscount?: InputMaybe<Scalars['Boolean']['input']>;
  loyaltyCards?: InputMaybe<Array<LoyaltyCardInput>>;
  userId: Scalars['ID']['input'];
};

export type MutationUpdateUserProfilePictureArgs = {
  id: Scalars['ID']['input'];
  image: Scalars['File']['input'];
};

export type MutationUpdateUserSettingsArgs = {
  emailNotificationsEnabled: Scalars['Boolean']['input'];
  id: Scalars['ID']['input'];
};

export type Notification = {
  id: Scalars['ID']['output'];
  read: Scalars['Boolean']['output'];
  sent: Scalars['Boolean']['output'];
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
  sent: Scalars['Boolean']['output'];
  timestamp: Scalars['DateTime']['output'];
  type: Scalars['ID']['output'];
  userId: Scalars['ID']['output'];
};

export type ProductFilter = {
  bus?: InputMaybe<Scalars['Boolean']['input']>;
  ferry?: InputMaybe<Scalars['Boolean']['input']>;
  national?: InputMaybe<Scalars['Boolean']['input']>;
  nationalExpress?: InputMaybe<Scalars['Boolean']['input']>;
  regional?: InputMaybe<Scalars['Boolean']['input']>;
  regionalExpress?: InputMaybe<Scalars['Boolean']['input']>;
  suburban?: InputMaybe<Scalars['Boolean']['input']>;
  subway?: InputMaybe<Scalars['Boolean']['input']>;
  taxi?: InputMaybe<Scalars['Boolean']['input']>;
  tram?: InputMaybe<Scalars['Boolean']['input']>;
};

export type Query = {
  __typename?: 'Query';
  journeys?: Maybe<JourneysResult>;
  locations?: Maybe<Array<Maybe<Location>>>;
  user?: Maybe<User>;
  userProfilePicturePresignedUrl?: Maybe<PresignedUrl>;
};

export type QueryJourneysArgs = {
  departure: Scalars['DateTime']['input'];
  earlierThan?: InputMaybe<Scalars['String']['input']>;
  from: Scalars['String']['input'];
  laterThan?: InputMaybe<Scalars['String']['input']>;
  options?: InputMaybe<JourneySearchOptions>;
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
  ageGroup?: Maybe<AgeGroup>;
  deutschlandTicketDiscount?: Maybe<Scalars['Boolean']['output']>;
  email: Scalars['String']['output'];
  emailNotificationsEnabled: Scalars['Boolean']['output'];
  familyName?: Maybe<Scalars['String']['output']>;
  givenName: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  journeyMonitors?: Maybe<Array<Maybe<JourneyMonitor>>>;
  loyaltyCards?: Maybe<Array<LoyaltyCard>>;
  notifications?: Maybe<Array<Maybe<Notification>>>;
  profilePicture?: Maybe<Scalars['String']['output']>;
};

export type UserJourneyMonitorsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};

export type UserNotificationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  read?: InputMaybe<Scalars['Boolean']['input']>;
};
