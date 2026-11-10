import { GraphQLError } from 'graphql';
import type { GraphQLContext } from '../context';
import { GetItemCommand, StoredUser } from '../model/trainPriceMonitor';

/**
 * Identity claims carried by the Cognito ID token the frontend sends in the
 * `Authorization` header.
 *
 * API Gateway's Cognito authorizer has already verified the signature before
 * the Lambda runs, so decoding the payload here is only a way to read claims,
 * not a trust boundary. The SQS path never carries a request and is marked
 * internal instead.
 */
export interface AuthClaims {
  sub: string;
  /** The client-generated `custom:id` that keys the User row. */
  customId?: string;
}

/** Decodes the Cognito claims from an Authorization header, raw or `Bearer `. */
export function authClaimsFromRequest(request: Request | undefined): AuthClaims | null {
  if (!request) return null;

  const auth = request.headers.get('authorization');
  if (!auth) return null;

  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  const payloadPart = token.split('.')[1];
  if (!payloadPart) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as Record<string, unknown>;
    if (typeof payload['sub'] !== 'string') return null;

    return {
      sub: payload['sub'],
      customId: typeof payload['custom:id'] === 'string' ? payload['custom:id'] : undefined,
    };
  } catch {
    return null;
  }
}

/** Returns the authenticated claims or throws an UNAUTHENTICATED GraphQL error. */
export function requireAuth(context: GraphQLContext): AuthClaims {
  if (!context.auth) {
    throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  return context.auth;
}

/** Rejects the operation unless the caller is the SQS/EventBridge path. */
export function requireInternal(context: GraphQLContext): void {
  if (!context.isInternal) {
    throw new GraphQLError('This operation is internal only', { extensions: { code: 'FORBIDDEN' } });
  }
}

/**
 * Checks that the caller owns an already-loaded User row.
 *
 * Rows without `cognitoSub` are rejected instead of being bound to the first
 * caller that presents the matching `custom:id`: that would let an attacker who
 * copied a victim's public id claim the row. Existing rows are backfilled with
 * scripts/backfill-cognito-sub.mjs before enforcement is deployed.
 */
export function assertUserAccess(context: GraphQLContext, user: StoredUser): StoredUser {
  if (context.isInternal) return user;

  const auth = requireAuth(context);
  if (!user.cognitoSub) {
    throw new GraphQLError('User is not linked to a Cognito identity', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
  if (user.cognitoSub !== auth.sub) {
    throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
  }
  return user;
}

/** Loads the User row and checks that the caller owns it. */
export async function requireUserAccess(context: GraphQLContext, userId: string): Promise<StoredUser> {
  const { Item: dbUser } = await context.entities.User.build(GetItemCommand).key({ id: userId }).send();
  if (!dbUser) {
    throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
  }
  return assertUserAccess(context, dbUser as StoredUser);
}
