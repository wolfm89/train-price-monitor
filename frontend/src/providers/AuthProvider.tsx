import React, { createContext, useState, useEffect, useCallback } from 'react';
import * as auth from '../utils/auth';
import { UserData } from '../utils/auth';
import { useQuery } from 'urql';
import { UserProfilePictureUrlQuery } from '../api/user';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from './AlertProvider';
import {
  clearCachedProfilePicture,
  isProfilePictureResultForUser,
  readCachedProfilePicture,
  writeCachedProfilePicture,
} from '../utils/profilePictureCache';

interface CachedProfilePicture {
  userId: string;
  url?: string;
}

interface AuthContextType {
  user: UserData | null;
  isInitialCheckDone: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  userProfilePictureUrl: string | undefined;
  refetchUserProfilePictureUrl: () => void;
  deleteUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

function AuthProvider({ children }: { children: React.ReactNode }) {
  const { addAlert } = useAlert();
  const [user, setUser] = useState<UserData | null>(null);
  const [isInitialCheckDone, setIsInitialCheckDone] = useState<boolean>(false);
  // The picture is tied to the user it was fetched for. Deriving the exposed URL
  // from that owner means a slow query or a cached URL from the previous account
  // can never flash the old avatar after a sign-out or account switch.
  const [profilePicture, setProfilePicture] = useState<CachedProfilePicture | null>(null);
  const [userProfilePictureUrlResult, reexecuteUserProfilePictureUrlQuery] = useQuery({
    query: UserProfilePictureUrlQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'],
  });

  const customId = user?.['custom:id'];
  const userProfilePictureUrl = customId && profilePicture?.userId === customId ? profilePicture.url : undefined;

  const getCurrentUser = async () => {
    try {
      const user = await auth.getCurrentUser();
      setUser(user);
    } catch (err) {
      // not logged in
      // eslint-disable-next-line no-console
      console.log(err);
      setUser(null);
    } finally {
      setIsInitialCheckDone(true);
    }
  };

  useEffect(() => {
    getCurrentUser();
  }, []);

  const signIn = async (email: string, password: string) => {
    await auth.signIn(email, password);
    await getCurrentUser();
  };

  const signOut = async () => {
    const signedOutUserId = user?.['custom:id'];
    await auth.signOut();
    clearCachedProfilePicture(signedOutUserId, localStorage);
    setProfilePicture(null);
    setUser(null);
  };

  const deleteUser = async () => {
    const deletedUserId = user?.['custom:id'];
    await auth.deleteUser();
    clearCachedProfilePicture(deletedUserId, localStorage);
    setProfilePicture(null);
    setUser(null);
  };

  const fetchAndCacheUserProfilePictureUrl = useCallback(async () => {
    reexecuteUserProfilePictureUrlQuery({ requestPolicy: 'network-only' });
  }, [reexecuteUserProfilePictureUrlQuery]);

  useEffect(() => {
    if (!customId) {
      setProfilePicture(null);
      return;
    }

    const cachedUrl = readCachedProfilePicture(customId, localStorage);
    if (cachedUrl) {
      setProfilePicture({ userId: customId, url: cachedUrl });
    } else {
      setProfilePicture({ userId: customId, url: undefined });
      fetchAndCacheUserProfilePictureUrl();
    }
  }, [customId, fetchAndCacheUserProfilePictureUrl]);

  useEffect(() => {
    // urql keeps the previous result's data while a new operation is in flight,
    // and across the paused sign-out state. Without this guard an A → B switch
    // would label A's URL with B's id and cache it under B's keys.
    if (!customId || !isProfilePictureResultForUser(userProfilePictureUrlResult, customId)) {
      return;
    }
    if (userProfilePictureUrlResult.data) {
      const newUrl = userProfilePictureUrlResult.data.userProfilePicturePresignedUrl?.url;
      if (newUrl) {
        setProfilePicture({ userId: customId, url: newUrl });
        writeCachedProfilePicture(customId, newUrl, localStorage);
      } else {
        setProfilePicture({ userId: customId, url: undefined });
        clearCachedProfilePicture(customId, localStorage);
      }
    } else if (userProfilePictureUrlResult.error) {
      // eslint-disable-next-line no-console
      console.error('Error fetching user profile picture URL:', userProfilePictureUrlResult.error);
      addAlert('Error fetching user profile picture URL.', AlertSeverity.Error);
    }
  }, [userProfilePictureUrlResult, customId, addAlert]);

  const authValue: AuthContextType = {
    user,
    isInitialCheckDone,
    signIn,
    signOut,
    userProfilePictureUrl,
    refetchUserProfilePictureUrl: fetchAndCacheUserProfilePictureUrl,
    deleteUser,
  };

  return <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>;
}

export { AuthProvider, AuthContext };
