// Which SES email identities belong to accounts that no longer exist.
//
// While the account is in the SES sandbox, createUser registers each user's
// address as an email identity. Until the API function was granted
// ses:DeleteEmailIdentity, deleteUser could not remove it again, so identities
// of deleted accounts piled up.

/**
 * Plans the deletion of EMAIL_ADDRESS identities that match no current user.
 * Domain identities and the addresses in `keep` (the sender) are never touched.
 * Addresses are compared case-insensitively.
 */
export function planIdentityCleanup(identities, userEmails, keep = []) {
  const current = new Set([...userEmails, ...keep].filter(Boolean).map((email) => email.toLowerCase()));
  const toDelete = [];
  let kept = 0;
  for (const identity of identities) {
    if (identity.IdentityType !== 'EMAIL_ADDRESS' || !identity.IdentityName) continue;
    if (current.has(identity.IdentityName.toLowerCase())) {
      kept++;
    } else {
      toDelete.push(identity.IdentityName);
    }
  }
  return { toDelete, kept };
}

/** j***@example.com — enough to sanity-check a run without printing whole addresses. */
export function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}
