import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  ISignUpResult,
  CognitoUserAttribute,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';

const cognitoUserPoolConfig = {
  UserPoolId: process.env.REACT_APP_COGNITO_USER_POOL_ID!,
  ClientId: process.env.REACT_APP_COGNITO_CLIENT_ID!,
};

const userPool = new CognitoUserPool(cognitoUserPoolConfig);

export function signUp(
  id: string,
  givenName: string,
  familyName: string,
  email: string,
  password: string
): Promise<CognitoUser> {
  return new Promise((resolve, reject) => {
    const userAttributes: CognitoUserAttribute[] = [
      new CognitoUserAttribute({ Name: 'custom:id', Value: id }),
      new CognitoUserAttribute({ Name: 'email', Value: email.toLowerCase() }),
      new CognitoUserAttribute({ Name: 'given_name', Value: givenName }),
      new CognitoUserAttribute({ Name: 'family_name', Value: familyName }),
    ];

    userPool.signUp(
      email.toLowerCase(),
      password,
      userAttributes,
      [],
      (err: Error | undefined, result?: ISignUpResult) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result!.user);
      }
    );
  });
}

export function signIn(email: string, password: string): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    const authenticationDetails = new AuthenticationDetails({
      Username: email.toLowerCase(),
      Password: password,
    });

    const cognitoUser = new CognitoUser({
      Username: email.toLowerCase(),
      Pool: userPool,
    });

    cognitoUser.authenticateUser(authenticationDetails, {
      onSuccess: (session: CognitoUserSession) => {
        resolve(session);
      },
      onFailure: (err: Error) => {
        reject(err);
      },
    });
  });
}

export function forgotPassword(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cognitoUser = new CognitoUser({
      Username: email.toLowerCase(),
      Pool: userPool,
    });

    cognitoUser.forgotPassword({
      onSuccess: () => {
        resolve();
      },
      onFailure: (err: Error) => {
        reject(err);
      },
    });
  });
}

export function confirmPassword(email: string, confirmationCode: string, newPassword: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cognitoUser = new CognitoUser({
      Username: email.toLowerCase(),
      Pool: userPool,
    });

    cognitoUser.confirmPassword(confirmationCode, newPassword, {
      onSuccess: () => {
        resolve();
      },
      onFailure: (err: Error) => {
        reject(err);
      },
    });
  });
}

export function signOut(): void {
  const cognitoUser = userPool.getCurrentUser();
  if (cognitoUser) {
    cognitoUser.signOut();
  }
}

export type UserData = {
  [key: string]: string;
};

export async function getCurrentUser() {
  return new Promise<UserData>((resolve, reject) => {
    const cognitoUser = userPool.getCurrentUser();

    if (!cognitoUser) {
      return;
    }

    cognitoUser.getSession((err: Error, session: null) => {
      if (err) {
        reject(err);
        return;
      }
      cognitoUser.getUserAttributes((err, attributes) => {
        if (err) {
          reject(err);
          return;
        }
        const userData = attributes?.reduce((acc, attribute) => {
          acc[attribute.Name] = attribute.Value;
          return acc;
        }, {} as UserData);
        resolve({ ...userData, username: cognitoUser.getUsername() });
      });
    });
  });
}

export function getSession() {
  return new Promise<CognitoUserSession | null>((resolve, reject) => {
    const cognitoUser = userPool.getCurrentUser();
    if (!cognitoUser) {
      reject(new Error('No user found'));
      return;
    }
    cognitoUser.getSession((err: Error, session: null) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(session);
    });
  });
}

export function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cognitoUser = userPool.getCurrentUser();
    if (!cognitoUser) {
      reject(new Error('No user found'));
      return;
    }
    cognitoUser.getSession((getSessionErr: Error, session: CognitoUserSession | null) => {
      if (getSessionErr) {
        reject(getSessionErr);
        return;
      }

      cognitoUser.changePassword(oldPassword, newPassword, (changePasswordErr: Error | undefined) => {
        if (changePasswordErr) {
          reject(changePasswordErr);
          return;
        }
        resolve();
      });
    });
  });
}
