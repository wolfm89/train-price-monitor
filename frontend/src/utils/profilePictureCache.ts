/** Presigned profile-picture URLs expire with the STS credentials used to sign them. */
export const PROFILE_PICTURE_CACHE_TTL_MS = 60 * 60 * 1000;

export interface ProfilePictureCacheStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function keys(customId: string): { imageUrlKey: string; imageUrlTimestampKey: string } {
  return {
    imageUrlKey: `image_url_${customId}`,
    imageUrlTimestampKey: `image_url_timestamp_${customId}`,
  };
}

export interface ProfilePictureOperationLike {
  operation?: {
    variables?: Record<string, unknown>;
  };
}

/**
 * True when a query result belongs to the given user.
 *
 * urql preserves the previous result while variables change (and while the
 * query is paused), so the data alone cannot be trusted after an account switch.
 * The operation variables identify which user the URL was fetched for.
 */
export function isProfilePictureResultForUser(
  result: ProfilePictureOperationLike,
  customId: string | undefined
): boolean {
  if (!customId) return false;
  return result.operation?.variables?.['id'] === customId;
}

export function readCachedProfilePicture(
  customId: string | undefined,
  storage: ProfilePictureCacheStorage,
  now: number = Date.now()
): string | undefined {
  if (!customId) return undefined;
  const { imageUrlKey, imageUrlTimestampKey } = keys(customId);
  const url = storage.getItem(imageUrlKey);
  const timestamp = storage.getItem(imageUrlTimestampKey);
  if (!url || !timestamp) return undefined;
  const age = now - Number(timestamp);
  if (!Number.isFinite(age) || age < 0 || age >= PROFILE_PICTURE_CACHE_TTL_MS) return undefined;
  return url;
}

export function writeCachedProfilePicture(
  customId: string | undefined,
  url: string,
  storage: ProfilePictureCacheStorage,
  now: number = Date.now()
): void {
  if (!customId) return;
  const { imageUrlKey, imageUrlTimestampKey } = keys(customId);
  storage.setItem(imageUrlKey, url);
  storage.setItem(imageUrlTimestampKey, now.toString());
}

export function clearCachedProfilePicture(customId: string | undefined, storage: ProfilePictureCacheStorage): void {
  if (!customId) return;
  const { imageUrlKey, imageUrlTimestampKey } = keys(customId);
  storage.removeItem(imageUrlKey);
  storage.removeItem(imageUrlTimestampKey);
}
