import { createContext, useState, useEffect } from 'react';
import * as auth from '../utils/auth';
import { UserData } from '../utils/auth';
import { UseQueryExecute, useQuery } from 'urql';
import { UserProfilePictureUrlQuery } from '../api/user';

interface AuthContextType {
  user: UserData | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  userProfilePictureUrl: string | undefined;
  reexecuteUserProfilePictureUrlQuery: UseQueryExecute;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [userProfilePictureUrlResult, reexecuteUserProfilePictureUrlQuery] = useQuery({
    query: UserProfilePictureUrlQuery,
    variables: { id: user?.['custom:id'] },
    pause: !user,
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
    setUser(null);
  };

  const authValue: AuthContextType = {
    user,
    isLoading,
    signIn,
    signOut,
    userProfilePictureUrl: userProfilePictureUrlResult?.data?.userProfilePicturePresignedUrl.url,
    reexecuteUserProfilePictureUrlQuery,
  };

  return <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>;
}

export { AuthProvider, AuthContext };
