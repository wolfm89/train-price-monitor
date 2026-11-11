import { describe, expect, it } from 'vitest';
import {
  clearCachedProfilePicture,
  createMemoryStorage,
  isProfilePictureResultForUser,
  PROFILE_PICTURE_CACHE_TTL_MS,
  purgeLegacyProfilePictureCache,
  readCachedProfilePicture,
  writeCachedProfilePicture,
} from './profilePictureCache';
import type { ProfilePictureCacheStorage } from './profilePictureCache';

function memoryStorage(): ProfilePictureCacheStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

describe('profile picture cache', () => {
  it('round-trips a URL for the same user', () => {
    const storage = memoryStorage();
    writeCachedProfilePicture('user-1', 'https://example.test/a.png', storage, 1_000);

    expect(readCachedProfilePicture('user-1', storage, 2_000)).toBe('https://example.test/a.png');
    expect(storage.entries.has('image_url_user-1')).toBe(true);
    expect(storage.entries.has('image_url_timestamp_user-1')).toBe(true);
  });

  it('expires a presigned URL after the cache TTL', () => {
    const storage = memoryStorage();
    writeCachedProfilePicture('user-1', 'https://example.test/a.png', storage, 1_000);

    expect(readCachedProfilePicture('user-1', storage, 1_000 + PROFILE_PICTURE_CACHE_TTL_MS)).toBeUndefined();
  });

  it('never returns another user’s cached URL', () => {
    const storage = memoryStorage();
    writeCachedProfilePicture('user-1', 'https://example.test/a.png', storage, 1_000);

    expect(readCachedProfilePicture('user-2', storage, 2_000)).toBeUndefined();
  });

  it('clears both keys on sign-out', () => {
    const storage = memoryStorage();
    writeCachedProfilePicture('user-1', 'https://example.test/a.png', storage, 1_000);
    clearCachedProfilePicture('user-1', storage);

    expect(storage.entries.size).toBe(0);
    expect(readCachedProfilePicture('user-1', storage, 2_000)).toBeUndefined();
  });

  it('ignores missing ids and garbage timestamps', () => {
    const storage = memoryStorage();
    writeCachedProfilePicture(undefined, 'https://example.test/a.png', storage, 1_000);
    expect(storage.entries.size).toBe(0);
    expect(readCachedProfilePicture(undefined, storage, 2_000)).toBeUndefined();

    writeCachedProfilePicture('user-1', 'https://example.test/a.png', storage, 1_000);
    storage.setItem('image_url_timestamp_user-1', 'not-a-number');
    expect(readCachedProfilePicture('user-1', storage, 2_000)).toBeUndefined();
  });
});

describe('createMemoryStorage', () => {
  it('keeps entries only in the instance', () => {
    const first = createMemoryStorage();
    const second = createMemoryStorage();
    writeCachedProfilePicture('user-1', 'https://example.test/a.png', first, 1_000);

    expect(readCachedProfilePicture('user-1', first, 2_000)).toBe('https://example.test/a.png');
    expect(readCachedProfilePicture('user-1', second, 2_000)).toBeUndefined();
  });
});

describe('purgeLegacyProfilePictureCache', () => {
  it('removes every legacy URL and timestamp but nothing else', () => {
    localStorage.clear();
    localStorage.setItem('image_url_user-1', 'https://example.test/a.png');
    localStorage.setItem('image_url_timestamp_user-1', '1000');
    localStorage.setItem('image_url_user-2', 'https://example.test/b.png');
    localStorage.setItem('CognitoIdentityServiceProvider.client.LastAuthUser', 'someone');

    purgeLegacyProfilePictureCache(localStorage);

    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('CognitoIdentityServiceProvider.client.LastAuthUser')).toBe('someone');
    localStorage.clear();
  });
});

describe('isProfilePictureResultForUser', () => {
  const resultFor = (userId: string) => ({ operation: { variables: { id: userId } } });

  it('accepts a result whose operation belongs to the current user', () => {
    expect(isProfilePictureResultForUser(resultFor('user-1'), 'user-1')).toBe(true);
  });

  it('rejects the previous account’s result during an account switch', () => {
    expect(isProfilePictureResultForUser(resultFor('user-1'), 'user-2')).toBe(false);
  });

  it('rejects a result without operation variables', () => {
    expect(isProfilePictureResultForUser({}, 'user-1')).toBe(false);
    expect(isProfilePictureResultForUser({ operation: {} }, 'user-1')).toBe(false);
  });

  it('rejects everything when no user is signed in', () => {
    expect(isProfilePictureResultForUser(resultFor('user-1'), undefined)).toBe(false);
  });
});
