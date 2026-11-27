import { gzipSync } from 'node:zlib';
import { handler } from '../lambda/db-proxy/index';

jest.mock('../../shared/db-fetch', () => ({
  fetch: jest.fn(),
  activeTlsProfileName: jest.fn(() => 'chrome'),
}));

const dbFetch = jest.requireMock<{ fetch: jest.Mock; activeTlsProfileName: jest.Mock }>('../../shared/db-fetch');
const fetchMock = dbFetch.fetch;

function proxyResponse(body: string, status = 200): unknown {
  return {
    status,
    statusText: `${status} ${status === 200 ? 'OK' : 'Error'}`,
    headers: { get: (): string => 'application/json' },
    text: async (): Promise<string> => body,
  };
}

describe('DB proxy handler', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    dbFetch.activeTlsProfileName.mockReturnValue('chrome');
    delete process.env.DB_TOTAL_BUDGET_MS;
    delete process.env.DB_REQUEST_TIMEOUT_MS;
    delete process.env.DB_TLS_PROFILE;
  });

  test('returns a plain body when the caller does not advertise gzip', async () => {
    fetchMock.mockResolvedValue(proxyResponse('{"ok":true}'));

    const result = await handler({ url: 'https://example.test' });

    expect(result.encoding).toBeUndefined();
    expect(result.body).toBe('{"ok":true}');
    expect(result.contentType).toBe('application/json');
    expect(result.usedProfile).toBe('chrome');
  });

  test('gzips the body only when the caller advertises gzip', async () => {
    fetchMock.mockResolvedValue(proxyResponse('{"ok":true}'));

    const result = await handler({ url: 'https://example.test', acceptEncoding: 'gzip' });

    expect(result.encoding).toBe('gzip');
    expect(result.body).toBe(gzipSync(Buffer.from('{"ok":true}', 'utf8')).toString('base64'));
  });

  test('caps the inner DB request at 15 s and restores the environment', async () => {
    fetchMock.mockImplementation(async () => {
      expect(process.env.DB_TOTAL_BUDGET_MS).toBe('15000');
      expect(process.env.DB_REQUEST_TIMEOUT_MS).toBe('15000');
      return proxyResponse('{}');
    });

    await handler({ url: 'https://example.test', timeoutMs: 60_000 });

    expect(process.env.DB_TOTAL_BUDGET_MS).toBeUndefined();
    expect(process.env.DB_REQUEST_TIMEOUT_MS).toBeUndefined();
  });

  test('floors a tiny caller timeout at 1 s', async () => {
    fetchMock.mockImplementation(async () => {
      expect(process.env.DB_REQUEST_TIMEOUT_MS).toBe('1000');
      return proxyResponse('{}');
    });

    await handler({ url: 'https://example.test', timeoutMs: 1 });
  });

  test('uses the caller profile hint only for this invocation', async () => {
    process.env.DB_TLS_PROFILE = 'legacy';
    fetchMock.mockImplementation(async () => {
      expect(process.env.DB_TLS_PROFILE).toBe('chrome');
      return proxyResponse('{}');
    });

    await handler({ url: 'https://example.test', profile: 'chrome' });

    expect(process.env.DB_TLS_PROFILE).toBe('legacy');
  });

  test('ignores an invalid profile hint', async () => {
    fetchMock.mockImplementation(async () => {
      expect(process.env.DB_TLS_PROFILE).toBeUndefined();
      return proxyResponse('{}');
    });

    await handler({ url: 'https://example.test', profile: 'not a profile' });
  });
});
