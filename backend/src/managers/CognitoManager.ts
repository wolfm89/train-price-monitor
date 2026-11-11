import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersCommandOutput,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

export interface PendingSignup {
  username: string;
  createdAt?: Date;
}

/** Admin operations on the user pool; only the refresher function is allowed to call them. */
export class CognitoManager {
  private client: CognitoIdentityProviderClient;

  constructor(private readonly userPoolId: string | undefined) {
    this.client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
  }

  private requirePoolId(): string {
    if (!this.userPoolId) {
      throw new Error('COGNITO_USER_POOL_ID is not defined in process.env');
    }
    return this.userPoolId;
  }

  /** Sign-ups whose email address was never confirmed. Returns no attributes, only the username and creation time. */
  async listUnconfirmedSignups(): Promise<PendingSignup[]> {
    const userPoolId = this.requirePoolId();
    const signups: PendingSignup[] = [];
    let paginationToken: string | undefined;
    do {
      const page: ListUsersCommandOutput = await this.client.send(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Filter: 'cognito:user_status = "UNCONFIRMED"',
          AttributesToGet: [],
          PaginationToken: paginationToken,
        })
      );
      for (const user of page.Users ?? []) {
        if (user.Username) signups.push({ username: user.Username, createdAt: user.UserCreateDate });
      }
      paginationToken = page.PaginationToken;
    } while (paginationToken);
    return signups;
  }

  async deleteUser(username: string): Promise<void> {
    await this.client.send(new AdminDeleteUserCommand({ UserPoolId: this.requirePoolId(), Username: username }));
  }

  /** Fresh status read, so a sign-up confirmed since it was listed is not deleted. */
  async isStillUnconfirmed(username: string): Promise<boolean> {
    try {
      const user = await this.client.send(
        new AdminGetUserCommand({ UserPoolId: this.requirePoolId(), Username: username })
      );
      return user.UserStatus === 'UNCONFIRMED';
    } catch (error) {
      if (error instanceof UserNotFoundException) return false;
      throw error;
    }
  }
}
