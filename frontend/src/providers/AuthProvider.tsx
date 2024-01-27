import { createContext, useState, useEffect, useCallback } from 'react';
import * as auth from '../utils/auth';
import { UserData } from '../utils/auth';
import { useQuery } from 'urql';
import { UserProfilePictureUrlQuery } from '../api/user';
import useAlert from '../hooks/useAlert';
import { AlertSeverity } from './AlertProvider';

interface AuthContextType {
  user: UserData | null;
  isLoading: boolean;
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
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [userProfilePictureUrl, setUserProfilePictureUrl] = useState<string | undefined>(undefined);
  const [userProfilePictureUrlResult, reexecuteUserProfilePictureUrlQuery] = useQuery({
    query: UserProfilePictureUrlQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user?.['custom:id'],
  });

  const getCurrentUser = async () => {
    try {
      const user = await auth.getCurrentUser();
      setUser(user);
    } catch (err) {
      // not logged in
      console.log(err);
      setUser(null);
    }
  };

  useEffect(() => {
    getCurrentUser()
      .then(() => setIsLoading(false))
      .catch(() => setIsLoading(false));
  }, []);

  const signIn = async (email: string, password: string) => {
    await auth.signIn(email, password);
    await getCurrentUser();
  };

  const signOut = async () => {
    await auth.signOut();
    const imageUrlKey = `image_url_${user?.['custom:id']}`;
    const imageUrlTimestampKey = `image_url_timestamp_${user?.['custom:id']}`;
    localStorage.removeItem(imageUrlKey);
    localStorage.removeItem(imageUrlTimestampKey);
    setUser(null);
  };

  const deleteUser = async () => {
    await auth.deleteUser();
    const imageUrlKey = `image_url_${user?.['custom:id']}`;
    const imageUrlTimestampKey = `image_url_timestamp_${user?.['custom:id']}`;
    localStorage.removeItem(imageUrlKey);
    localStorage.removeItem(imageUrlTimestampKey);
    setUser(null);
  };

  const fetchAndCacheUserProfilePictureUrl = useCallback(async () => {
    reexecuteUserProfilePictureUrlQuery({ requestPolicy: 'network-only' });
  }, [reexecuteUserProfilePictureUrlQuery]);

  useEffect(() => {
    if (!user) {
      return;
    }
    const imageUrlKey = `image_url_${user?.['custom:id']}`;
    const imageUrlTimestampKey = `image_url_timestamp_${user?.['custom:id']}`;

    const imageUrl = localStorage.getItem(imageUrlKey);
    const imageUrlTimestamp = localStorage.getItem(imageUrlTimestampKey);

    // 24 hours in milliseconds
    const oneDay = 24 * 60 * 60 * 1000;
    const now = new Date().getTime();

    if (imageUrl && imageUrlTimestamp && now - Number(imageUrlTimestamp) < oneDay) {
      setUserProfilePictureUrl(imageUrl);
    } else {
      fetchAndCacheUserProfilePictureUrl();
    }
  }, [user, fetchAndCacheUserProfilePictureUrl]);

  useEffect(() => {
    if (userProfilePictureUrlResult.data) {
      const newUrl = userProfilePictureUrlResult.data.userProfilePicturePresignedUrl.url;
      setUserProfilePictureUrl(newUrl);
      const imageUrlKey = `image_url_${user?.['custom:id']}`;
      const imageUrlTimestampKey = `image_url_timestamp_${user?.['custom:id']}`;
      const now = new Date().getTime();
      localStorage.setItem(imageUrlKey, newUrl);
      localStorage.setItem(imageUrlTimestampKey, now.toString());
    } else if (userProfilePictureUrlResult.error) {
      console.error('Error fetching user profile picture URL:', userProfilePictureUrlResult.error);
      addAlert('Error fetching user profile picture URL.', AlertSeverity.Error);
    }
  }, [userProfilePictureUrlResult, user, addAlert]);

  const authValue: AuthContextType = {
    user,
    isLoading,
    signIn,
    signOut,
    userProfilePictureUrl,
    refetchUserProfilePictureUrl: fetchAndCacheUserProfilePictureUrl,
    deleteUser,
  };

  return <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>;
}

export { AuthProvider, AuthContext };
