import { describe, expect, it, vi } from 'vitest';
import { deleteAccountSafely, hasMutationError } from './accountDeletion';

describe('hasMutationError', () => {
  it('detects the error field urql resolves with', () => {
    expect(hasMutationError({ error: new Error('nope') })).toBe(true);
    expect(hasMutationError({ data: { id: 'user-1' } })).toBe(false);
    expect(hasMutationError(undefined)).toBe(false);
    expect(hasMutationError(null)).toBe(false);
  });
});

describe('deleteAccountSafely', () => {
  it('does not delete the Cognito login when the backend mutation reports an error', async () => {
    const deleteCognitoUser = vi.fn(async () => {});
    const outcome = await deleteAccountSafely({
      deleteBackendData: async () => ({ error: new Error('DynamoDB failed') }),
      deleteCognitoUser,
    });

    expect(outcome).toMatchObject({ ok: false, stage: 'backend' });
    expect(deleteCognitoUser).not.toHaveBeenCalled();
  });

  it('does not delete the Cognito login when the backend mutation throws', async () => {
    const deleteCognitoUser = vi.fn(async () => {});
    const outcome = await deleteAccountSafely({
      deleteBackendData: async () => {
        throw new Error('network down');
      },
      deleteCognitoUser,
    });

    expect(outcome).toMatchObject({ ok: false, stage: 'backend' });
    expect(deleteCognitoUser).not.toHaveBeenCalled();
  });

  it('deletes the Cognito login only after the backend data is gone', async () => {
    const calls: string[] = [];
    const outcome = await deleteAccountSafely({
      deleteBackendData: async () => {
        calls.push('backend');
        return { data: { id: 'user-1' } };
      },
      deleteCognitoUser: async () => {
        calls.push('cognito');
      },
    });

    expect(outcome).toEqual({ ok: true });
    expect(calls).toEqual(['backend', 'cognito']);
  });

  it('reports a Cognito failure as its own stage', async () => {
    const outcome = await deleteAccountSafely({
      deleteBackendData: async () => ({ data: { id: 'user-1' } }),
      deleteCognitoUser: async () => {
        throw new Error('Cognito refused');
      },
    });

    expect(outcome).toMatchObject({ ok: false, stage: 'cognito' });
  });
});
