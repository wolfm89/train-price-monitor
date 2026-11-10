export interface MutationResultLike {
  data?: unknown;
  error?: unknown;
}

export function hasMutationError(result: MutationResultLike | null | undefined): boolean {
  return Boolean(result?.error);
}

export interface AccountDeletionSteps {
  /** Deletes the User row, journeys and notifications in DynamoDB. */
  deleteBackendData: () => Promise<MutationResultLike | null | undefined>;
  /** Deletes the Cognito login after the data is gone. */
  deleteCognitoUser: () => Promise<void>;
}

export type AccountDeletionOutcome = { ok: true } | { ok: false; stage: 'backend' | 'cognito'; error: unknown };

/**
 * Deletes the account in the only safe order: backend data first, Cognito login
 * second.
 *
 * urql mutations resolve with `{ error }` instead of rejecting, so awaiting the
 * backend mutation is not enough. If the backend reports an error (or throws),
 * the Cognito user must survive; otherwise the journeys and notifications would
 * be orphaned and the refresher would keep polling and emailing them. Extracted
 * from ProfilePage so this ordering is covered by tests.
 */
export async function deleteAccountSafely({
  deleteBackendData,
  deleteCognitoUser,
}: AccountDeletionSteps): Promise<AccountDeletionOutcome> {
  let result: MutationResultLike | null | undefined;
  try {
    result = await deleteBackendData();
  } catch (error) {
    return { ok: false, stage: 'backend', error };
  }

  if (result?.error) {
    return { ok: false, stage: 'backend', error: result.error };
  }

  try {
    await deleteCognitoUser();
  } catch (error) {
    return { ok: false, stage: 'cognito', error };
  }

  return { ok: true };
}
