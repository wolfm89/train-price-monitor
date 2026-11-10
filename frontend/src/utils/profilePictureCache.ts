/** Presigned profile-picture URLs expire with the STS credentials used to sign them. */
export const PROFILE_PICTURE_CACHE_TTL_MS = 60 * 60 * 1000;

/** Prefix of the keys older versions used to cache the URL in localStorage. */
const LEGACY_KEY_PREFIX = 'image_url_';

export interface ProfilePictureCacheStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/**
 * Page-lifetime storage for the cache. The presigned URL grants access to the
 * picture until it expires, so it is kept in memory rather than persisted in
 * localStorage, where it would outlive the session on a shared device.
 */
export function createMemoryStorage(): ProfilePictureCacheStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

/** Removes the URLs and timestamps that older versions left in localStorage. */
export function purgeLegacyProfilePictureCache(storage: Pick<Storage, 'length' | 'key' | 'removeItem'>): void {
  const legacyKeys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(LEGACY_KEY_PREFIX)) legacyKeys.push(key);
  }
  legacyKeys.forEach((key) => storage.removeItem(key));
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
