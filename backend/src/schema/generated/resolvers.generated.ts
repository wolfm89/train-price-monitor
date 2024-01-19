import { GraphQLResolveInfo, GraphQLScalarType, GraphQLScalarTypeConfig } from 'graphql';
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };

export type ResolverTypeWrapper<T> = Promise<T> | T;

export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<TResult, TParent = {}, TContext = {}, TArgs = {}> =
  | ResolverFn<TResult, TParent, TContext, TArgs>
  | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

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

export type SubscriptionResolver<TResult, TKey extends string, TParent = {}, TContext = {}, TArgs = {}> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<TTypes, TParent = {}, TContext = {}> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo
) => Maybe<TTypes> | Promise<Maybe<TTypes>>;

export type IsTypeOfResolverFn<T = {}, TContext = {}> = (
  obj: T,
  context: TContext,
  info: GraphQLResolveInfo
) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<TResult = {}, TParent = {}, TContext = {}, TArgs = {}> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

/** Mapping of interface types */
export type ResolversInterfaceTypes<RefType extends Record<string, unknown>> = {
  Notification: JourneyExpiryNotification | PriceAlertNotification;
};

/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = {
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
  DateTime: ResolverTypeWrapper<Scalars['DateTime']['output']>;
  File: ResolverTypeWrapper<Scalars['File']['output']>;
  Float: ResolverTypeWrapper<Scalars['Float']['output']>;
  ID: ResolverTypeWrapper<Scalars['ID']['output']>;
  Int: ResolverTypeWrapper<Scalars['Int']['output']>;
  Journey: ResolverTypeWrapper<Journey>;
  JourneyExpiryNotification: ResolverTypeWrapper<JourneyExpiryNotification>;
  JourneyMonitor: ResolverTypeWrapper<JourneyMonitor>;
  Location: ResolverTypeWrapper<Location>;
  Mutation: ResolverTypeWrapper<{}>;
  Notification: ResolverTypeWrapper<ResolversInterfaceTypes<ResolversTypes>['Notification']>;
  PresignedUrl: ResolverTypeWrapper<PresignedUrl>;
  PriceAlertNotification: ResolverTypeWrapper<PriceAlertNotification>;
  Query: ResolverTypeWrapper<{}>;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
  User: ResolverTypeWrapper<User>;
};

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = {
  Boolean: Scalars['Boolean']['output'];
  DateTime: Scalars['DateTime']['output'];
  File: Scalars['File']['output'];
  Float: Scalars['Float']['output'];
  ID: Scalars['ID']['output'];
  Int: Scalars['Int']['output'];
  Journey: Journey;
  JourneyExpiryNotification: JourneyExpiryNotification;
  JourneyMonitor: JourneyMonitor;
  Location: Location;
  Mutation: {};
  Notification: ResolversInterfaceTypes<ResolversParentTypes>['Notification'];
  PresignedUrl: PresignedUrl;
  PriceAlertNotification: PriceAlertNotification;
  Query: {};
  String: Scalars['String']['output'];
  User: User;
};

export interface DateTimeScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['DateTime'], any> {
  name: 'DateTime';
}

export interface FileScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['File'], any> {
  name: 'File';
}

export type JourneyResolvers<
  ContextType = any,
  ParentType extends ResolversParentTypes['Journey'] = ResolversParentTypes['Journey']
> = {
  arrival?: Resolver<Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  departure?: Resolver<Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  from?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  means?: Resolver<Maybe<Array<Maybe<ResolversTypes['String']>>>, ParentType, ContextType>;
  price?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  refreshToken?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  to?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type JourneyExpiryNotificationResolvers<
  ContextType = any,
  ParentType extends ResolversParentTypes['JourneyExpiryNotification'] = ResolversParentTypes['JourneyExpiryNotification']
> = {
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  journey?: Resolver<ResolversTypes['Journey'], ParentType, ContextType>;
  read?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  sent?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  timestamp?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type JourneyMonitorResolvers<
  ContextType = any,
  ParentType extends ResolversParentTypes['JourneyMonitor'] = ResolversParentTypes['JourneyMonitor']
> = {
  expires?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  journey?: Resolver<Maybe<ResolversTypes['Journey']>, ParentType, ContextType>;
  limitPrice?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type LocationResolvers<
  ContextType = any,
  ParentType extends ResolversParentTypes['Location'] = ResolversParentTypes['Location']
> = {
  id?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type MutationResolvers<
  ContextType = any,
  ParentType extends ResolversParentTypes['Mutation'] = ResolversParentTypes['Mutation']
> = {
  createUser?: Resolver<
    Maybe<ResolversTypes['User']>,
    ParentType,
    ContextType,
    RequireFields<MutationCreateUserArgs, 'email' | 'familyName' | 'givenName' | 'id'>
  >;
  deleteJourneyMonitor?: Resolver<
    Maybe<ResolversTypes['JourneyMonitor']>,
    ParentType,
    ContextType,
    RequireFields<MutationDeleteJourneyMonitorArgs, 'journeyId' | 'userId'>
  >;
  markNotificationAsRead?: Resolver<
    Maybe<ResolversTypes['Notification']>,
    ParentType,
    ContextType,
    RequireFields<MutationMarkNotificationAsReadArgs, 'notificationId' | 'userId'>
  >;
  monitorJourney?: Resolver<
    Maybe<ResolversTypes['JourneyMonitor']>,
    ParentType,
    ContextType,
    RequireFields<MutationMonitorJourneyArgs, 'expires' | 'limitPrice' | 'refreshToken' | 'userId'>
  >;
  sendEmailNotification?: Resolver<
    Maybe<ResolversTypes['Notification']>,
    ParentType,
    ContextType,
    RequireFields<MutationSendEmailNotificationArgs, 'notificationId' | 'userId'>
  >;
  updateJourneyMonitor?: Resolver<
    Maybe<ResolversTypes['JourneyMonitor']>,
    ParentType,
    ContextType,
    RequireFields<MutationUpdateJourneyMonitorArgs, 'journeyId' | 'userId'>
  >;
  updateJourneyMonitors?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  updateUserProfilePicture?: Resolver<
    Maybe<ResolversTypes['User']>,
    ParentType,
    ContextType,
    RequireFields<MutationUpdateUserProfilePictureArgs, 'id' | 'image'>
  >;
  updateUserSettings?: Resolver<
    Maybe<ResolversTypes['User']>,
    ParentType,
    ContextType,
    RequireFields<MutationUpdateUserSettingsArgs, 'emailNotificationsEnabled' | 'id'>
  >;
};

export type NotificationResolvers<
  ContextType = any,
  ParentType extends ResolversParentTypes['Notification'] = ResolversParentTypes['Notification']
> = {
  __resolveType: TypeResolveFn<'JourneyExpiryNotification' | 'PriceAlertNotification', ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  read?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  sent?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  timestamp?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  type?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  userId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
};

export type PresignedUrlResolvers<
  ContextType = any,
  ParentType extends ResolversParentTypes['PresignedUrl'] = ResolversParentTypes['PresignedUrl']
> = {
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type PriceAlertNotificationResolvers<
  ContextType = any,
  ParentType extends ResolversParentTypes['PriceAlertNotification'] = ResolversParentTypes['PriceAlertNotification']
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
  ContextType = any,
  ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query']
> = {
  journeys?: Resolver<
    Maybe<Array<Maybe<ResolversTypes['Journey']>>>,
    ParentType,
    ContextType,
    RequireFields<QueryJourneysArgs, 'departure' | 'from' | 'to'>
  >;
  locations?: Resolver<
    Maybe<Array<Maybe<ResolversTypes['Location']>>>,
    ParentType,
    ContextType,
    RequireFields<QueryLocationsArgs, 'query'>
  >;
  user?: Resolver<Maybe<ResolversTypes['User']>, ParentType, ContextType, RequireFields<QueryUserArgs, 'id'>>;
  userProfilePicturePresignedUrl?: Resolver<
    Maybe<ResolversTypes['PresignedUrl']>,
    ParentType,
    ContextType,
    RequireFields<QueryUserProfilePicturePresignedUrlArgs, 'id'>
  >;
};

export type UserResolvers<
  ContextType = any,
  ParentType extends ResolversParentTypes['User'] = ResolversParentTypes['User']
> = {
  email?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  emailNotificationsEnabled?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  familyName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  givenName?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  journeyMonitors?: Resolver<
    Maybe<Array<Maybe<ResolversTypes['JourneyMonitor']>>>,
    ParentType,
    ContextType,
    Partial<UserJourneyMonitorsArgs>
  >;
  notifications?: Resolver<
    Maybe<Array<Maybe<ResolversTypes['Notification']>>>,
    ParentType,
    ContextType,
    Partial<UserNotificationsArgs>
  >;
  profilePicture?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type Resolvers<ContextType = any> = {
  DateTime?: GraphQLScalarType;
  File?: GraphQLScalarType;
  Journey?: JourneyResolvers<ContextType>;
  JourneyExpiryNotification?: JourneyExpiryNotificationResolvers<ContextType>;
  JourneyMonitor?: JourneyMonitorResolvers<ContextType>;
  Location?: LocationResolvers<ContextType>;
  Mutation?: MutationResolvers<ContextType>;
  Notification?: NotificationResolvers<ContextType>;
  PresignedUrl?: PresignedUrlResolvers<ContextType>;
  PriceAlertNotification?: PriceAlertNotificationResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
  User?: UserResolvers<ContextType>;
};
