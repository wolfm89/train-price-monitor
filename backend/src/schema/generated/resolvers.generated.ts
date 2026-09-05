import * as Types from './typeDefs.generated';
import { GraphQLResolveInfo, GraphQLScalarType, GraphQLScalarTypeConfig } from 'graphql';
import { User, Notification } from './typeDefs.generated';
import { GraphQLContext } from '../../context';
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };

export type ResolverTypeWrapper<T> = Promise<T> | T;

export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<
  TResult,
  TParent = Record<PropertyKey, never>,
  TContext = Record<PropertyKey, never>,
  TArgs = Record<PropertyKey, never>,
> = ResolverFn<TResult, TParent, TContext, TArgs> | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => Promise<TResult> | TResult;

export type SubscriptionSubscribeFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type SubscriptionResolveFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

export interface SubscriptionSubscriberObject<TResult, TKey extends string, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<{ [key in TKey]: TResult }, TParent, TContext, TArgs>;
  resolve?: SubscriptionResolveFn<TResult, { [key in TKey]: TResult }, TContext, TArgs>;
}

export interface SubscriptionResolverObject<TResult, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<any, TParent, TContext, TArgs>;
  resolve: SubscriptionResolveFn<TResult, any, TContext, TArgs>;
}

export type SubscriptionObject<TResult, TKey extends string, TParent, TContext, TArgs> =
  | SubscriptionSubscriberObject<TResult, TKey, TParent, TContext, TArgs>
  | SubscriptionResolverObject<TResult, TParent, TContext, TArgs>;

export type SubscriptionResolver<
  TResult,
  TKey extends string,
  TParent = Record<PropertyKey, never>,
  TContext = Record<PropertyKey, never>,
  TArgs = Record<PropertyKey, never>,
> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<TTypes, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo
) => Types.Maybe<TTypes> | Promise<Types.Maybe<TTypes>>;

export type IsTypeOfResolverFn<T = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (
  obj: T,
  context: TContext,
  info: GraphQLResolveInfo
) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<
  TResult = Record<PropertyKey, never>,
  TParent = Record<PropertyKey, never>,
  TContext = Record<PropertyKey, never>,
  TArgs = Record<PropertyKey, never>,
> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = {
  AgeGroup: Types.AgeGroup;
  Boolean: ResolverTypeWrapper<Types.Scalars['Boolean']['output']>;
  DateTime: ResolverTypeWrapper<Types.Scalars['DateTime']['output']>;
  File: ResolverTypeWrapper<Types.Scalars['File']['output']>;
  Float: ResolverTypeWrapper<Types.Scalars['Float']['output']>;
  ID: ResolverTypeWrapper<Types.Scalars['ID']['output']>;
  Int: ResolverTypeWrapper<Types.Scalars['Int']['output']>;
  Journey: ResolverTypeWrapper<Types.Journey>;
  JourneyExpiryNotification: ResolverTypeWrapper<Types.JourneyExpiryNotification>;
  JourneyMonitor: ResolverTypeWrapper<Types.JourneyMonitor>;
  JourneySearchOptions: Types.JourneySearchOptions;
  JourneyStaleNotification: ResolverTypeWrapper<Types.JourneyStaleNotification>;
  JourneysResult: ResolverTypeWrapper<Types.JourneysResult>;
  Location: ResolverTypeWrapper<Types.Location>;
  LoyaltyCard: ResolverTypeWrapper<Types.LoyaltyCard>;
  LoyaltyCardInput: Types.LoyaltyCardInput;
  LoyaltyCardType: Types.LoyaltyCardType;
  Mutation: ResolverTypeWrapper<Record<PropertyKey, never>>;
  Notification: ResolverTypeWrapper<Notification>;
  PresignedUrl: ResolverTypeWrapper<Types.PresignedUrl>;
  PriceAlertNotification: ResolverTypeWrapper<Types.PriceAlertNotification>;
  ProductFilter: Types.ProductFilter;
  Query: ResolverTypeWrapper<Record<PropertyKey, never>>;
  String: ResolverTypeWrapper<Types.Scalars['String']['output']>;
  User: ResolverTypeWrapper<User>;
};

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = {
  Boolean: Types.Scalars['Boolean']['output'];
  DateTime: Types.Scalars['DateTime']['output'];
  File: Types.Scalars['File']['output'];
  Float: Types.Scalars['Float']['output'];
  ID: Types.Scalars['ID']['output'];
  Int: Types.Scalars['Int']['output'];
  Journey: Types.Journey;
  JourneyExpiryNotification: Types.JourneyExpiryNotification;
  JourneyMonitor: Types.JourneyMonitor;
  JourneySearchOptions: Types.JourneySearchOptions;
  JourneyStaleNotification: Types.JourneyStaleNotification;
  JourneysResult: Types.JourneysResult;
  Location: Types.Location;
  LoyaltyCard: Types.LoyaltyCard;
  LoyaltyCardInput: Types.LoyaltyCardInput;
  Mutation: Record<PropertyKey, never>;
  Notification: Notification;
  PresignedUrl: Types.PresignedUrl;
  PriceAlertNotification: Types.PriceAlertNotification;
  ProductFilter: Types.ProductFilter;
  Query: Record<PropertyKey, never>;
  String: Types.Scalars['String']['output'];
  User: User;
};

export interface DateTimeScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['DateTime'], any> {
  name: 'DateTime';
}

export interface FileScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['File'], any> {
  name: 'File';
}

export type JourneyResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['Journey'] = ResolversParentTypes['Journey'],
> = {
  arrival?: Resolver<Types.Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  departure?: Resolver<Types.Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  fromId?: Resolver<Types.Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  means?: Resolver<Types.Maybe<Array<Types.Maybe<ResolversTypes['String']>>>, ParentType, ContextType>;
  price?: Resolver<Types.Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  refreshToken?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  toId?: Resolver<Types.Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type JourneyExpiryNotificationResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['JourneyExpiryNotification'] =
    ResolversParentTypes['JourneyExpiryNotification'],
> = {
  from?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  read?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  sent?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  timestamp?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  to?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type JourneyMonitorResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['JourneyMonitor'] = ResolversParentTypes['JourneyMonitor'],
> = {
  ageGroup?: Resolver<Types.Maybe<ResolversTypes['AgeGroup']>, ParentType, ContextType>;
  bike?: Resolver<Types.Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  deutschlandTicketDiscount?: Resolver<Types.Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  expires?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  firstClass?: Resolver<Types.Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  from?: Resolver<Types.Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  journey?: Resolver<Types.Maybe<ResolversTypes['Journey']>, ParentType, ContextType>;
  limitPrice?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  loyaltyCard?: Resolver<Types.Maybe<ResolversTypes['LoyaltyCard']>, ParentType, ContextType>;
  to?: Resolver<Types.Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  unavailable?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
};

export type JourneyStaleNotificationResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['JourneyStaleNotification'] =
    ResolversParentTypes['JourneyStaleNotification'],
> = {
  from?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  journeyId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  read?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  sent?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  timestamp?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  to?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type JourneysResultResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['JourneysResult'] = ResolversParentTypes['JourneysResult'],
> = {
  earlierRef?: Resolver<Types.Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  journeys?: Resolver<Types.Maybe<Array<Types.Maybe<ResolversTypes['Journey']>>>, ParentType, ContextType>;
  laterRef?: Resolver<Types.Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type LocationResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['Location'] = ResolversParentTypes['Location'],
> = {
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type LoyaltyCardResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['LoyaltyCard'] = ResolversParentTypes['LoyaltyCard'],
> = {
  class?: Resolver<Types.Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  discount?: Resolver<Types.Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  type?: Resolver<ResolversTypes['LoyaltyCardType'], ParentType, ContextType>;
};

export type MutationResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['Mutation'] = ResolversParentTypes['Mutation'],
> = {
  createUser?: Resolver<
    Types.Maybe<ResolversTypes['User']>,
    ParentType,
    ContextType,
    RequireFields<Types.MutationCreateUserArgs, 'email' | 'givenName' | 'id'>
  >;
  deleteJourneyMonitor?: Resolver<
    Types.Maybe<ResolversTypes['JourneyMonitor']>,
    ParentType,
    ContextType,
    RequireFields<Types.MutationDeleteJourneyMonitorArgs, 'journeyId' | 'userId'>
  >;
  deleteUser?: Resolver<
    Types.Maybe<ResolversTypes['User']>,
    ParentType,
    ContextType,
    RequireFields<Types.MutationDeleteUserArgs, 'id'>
  >;
  markNotificationAsRead?: Resolver<
    Types.Maybe<ResolversTypes['Notification']>,
    ParentType,
    ContextType,
    RequireFields<Types.MutationMarkNotificationAsReadArgs, 'notificationId' | 'userId'>
  >;
  monitorJourney?: Resolver<
    Types.Maybe<ResolversTypes['JourneyMonitor']>,
    ParentType,
    ContextType,
    RequireFields<
      Types.MutationMonitorJourneyArgs,
      'departure' | 'expires' | 'fromId' | 'limitPrice' | 'refreshToken' | 'toId' | 'userId'
    >
  >;
  sendEmailNotification?: Resolver<
    Types.Maybe<ResolversTypes['Notification']>,
    ParentType,
    ContextType,
    RequireFields<Types.MutationSendEmailNotificationArgs, 'notificationId' | 'userId'>
  >;
  updateJourneyMonitor?: Resolver<
    Types.Maybe<ResolversTypes['JourneyMonitor']>,
    ParentType,
    ContextType,
    RequireFields<Types.MutationUpdateJourneyMonitorArgs, 'journeyId' | 'userId'>
  >;
  updateJourneyMonitors?: Resolver<Types.Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  updateTravelPreferences?: Resolver<
    Types.Maybe<ResolversTypes['User']>,
    ParentType,
    ContextType,
    RequireFields<Types.MutationUpdateTravelPreferencesArgs, 'userId'>
  >;
  updateUserProfilePicture?: Resolver<
    Types.Maybe<ResolversTypes['User']>,
    ParentType,
    ContextType,
    RequireFields<Types.MutationUpdateUserProfilePictureArgs, 'id' | 'image'>
  >;
  updateUserSettings?: Resolver<
    Types.Maybe<ResolversTypes['User']>,
    ParentType,
    ContextType,
    RequireFields<Types.MutationUpdateUserSettingsArgs, 'emailNotificationsEnabled' | 'id'>
  >;
};

export type NotificationResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['Notification'] = ResolversParentTypes['Notification'],
> = {
  __resolveType: TypeResolveFn<
    'JourneyExpiryNotification' | 'JourneyStaleNotification' | 'PriceAlertNotification',
    ParentType,
    ContextType
  >;
};

export type PresignedUrlResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['PresignedUrl'] = ResolversParentTypes['PresignedUrl'],
> = {
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  url?: Resolver<Types.Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type PriceAlertNotificationResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['PriceAlertNotification'] = ResolversParentTypes['PriceAlertNotification'],
> = {
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  journeyMonitor?: Resolver<ResolversTypes['JourneyMonitor'], ParentType, ContextType>;
  read?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  sent?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  timestamp?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type QueryResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query'],
> = {
  journeys?: Resolver<
    Types.Maybe<ResolversTypes['JourneysResult']>,
    ParentType,
    ContextType,
    RequireFields<Types.QueryJourneysArgs, 'departure' | 'from' | 'to'>
  >;
  locations?: Resolver<
    Types.Maybe<Array<Types.Maybe<ResolversTypes['Location']>>>,
    ParentType,
    ContextType,
    RequireFields<Types.QueryLocationsArgs, 'query'>
  >;
  user?: Resolver<
    Types.Maybe<ResolversTypes['User']>,
    ParentType,
    ContextType,
    RequireFields<Types.QueryUserArgs, 'id'>
  >;
  userProfilePicturePresignedUrl?: Resolver<
    Types.Maybe<ResolversTypes['PresignedUrl']>,
    ParentType,
    ContextType,
    RequireFields<Types.QueryUserProfilePicturePresignedUrlArgs, 'id'>
  >;
};

export type UserResolvers<
  ContextType = GraphQLContext,
  ParentType extends ResolversParentTypes['User'] = ResolversParentTypes['User'],
> = {
  ageGroup?: Resolver<Types.Maybe<ResolversTypes['AgeGroup']>, ParentType, ContextType>;
  deutschlandTicketDiscount?: Resolver<Types.Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
  email?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  emailNotificationsEnabled?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  familyName?: Resolver<Types.Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  givenName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  journeyMonitors?: Resolver<
    Types.Maybe<Array<Types.Maybe<ResolversTypes['JourneyMonitor']>>>,
    ParentType,
    ContextType,
    Partial<Types.UserJourneyMonitorsArgs>
  >;
  loyaltyCards?: Resolver<Types.Maybe<Array<ResolversTypes['LoyaltyCard']>>, ParentType, ContextType>;
  notifications?: Resolver<
    Types.Maybe<Array<Types.Maybe<ResolversTypes['Notification']>>>,
    ParentType,
    ContextType,
    Partial<Types.UserNotificationsArgs>
  >;
  profilePicture?: Resolver<Types.Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type Resolvers<ContextType = GraphQLContext> = {
  DateTime?: GraphQLScalarType;
  File?: GraphQLScalarType;
  Journey?: JourneyResolvers<ContextType>;
  JourneyExpiryNotification?: JourneyExpiryNotificationResolvers<ContextType>;
  JourneyMonitor?: JourneyMonitorResolvers<ContextType>;
  JourneyStaleNotification?: JourneyStaleNotificationResolvers<ContextType>;
  JourneysResult?: JourneysResultResolvers<ContextType>;
  Location?: LocationResolvers<ContextType>;
  LoyaltyCard?: LoyaltyCardResolvers<ContextType>;
  Mutation?: MutationResolvers<ContextType>;
  Notification?: NotificationResolvers<ContextType>;
  PresignedUrl?: PresignedUrlResolvers<ContextType>;
  PriceAlertNotification?: PriceAlertNotificationResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
  User?: UserResolvers<ContextType>;
};
