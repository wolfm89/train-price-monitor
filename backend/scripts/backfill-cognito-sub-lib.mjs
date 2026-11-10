// Pure planning helpers for the cognitoSub backfill. Kept separate from the
// AWS calls so the duplicate/email rules can be exercised without credentials.

export function attributesOf(user) {
  return Object.fromEntries((user.Attributes ?? []).map((attribute) => [attribute.Name, attribute.Value]));
}

function normalize(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * `custom:id` is client-chosen and not unique, so it is not enough on its own.
 * Require the verified Cognito email (and, when both sides have them, the
 * immutable names) to match the stored User row before binding.
 */
export function identityMatches(row, attributes) {
  const rowEmail = normalize(row?.email);
  const cognitoEmail = normalize(attributes?.email);
  if (!rowEmail || !cognitoEmail || rowEmail !== cognitoEmail) return false;

  const rowGivenName = normalize(row?.givenName);
  const cognitoGivenName = normalize(attributes?.given_name);
  if (rowGivenName && cognitoGivenName && rowGivenName !== cognitoGivenName) return false;

  const rowFamilyName = normalize(row?.familyName);
  const cognitoFamilyName = normalize(attributes?.family_name);
  if (rowFamilyName && cognitoFamilyName && rowFamilyName !== cognitoFamilyName) return false;

  return true;
}

export function groupUsersByCustomId(users) {
  const groups = new Map();
  for (const user of users) {
    const attributes = attributesOf(user);
    const customId = attributes['custom:id'];
    if (!customId) continue;
    const group = groups.get(customId) ?? [];
    group.push({ user, attributes, sub: attributes.sub });
    groups.set(customId, group);
  }
  return groups;
}

/**
 * Builds the complete binding plan before anything is written.
 *
 * A custom:id shared by two Cognito users is ambiguous: either one could be the
 * legitimate owner, so none of them may be bound. Existing bindings, missing
 * rows, missing identities and email/name mismatches are reported as conflicts
 * and prevent the caller from applying any write.
 */
export function planBindings(users, rowsByCustomId) {
  const result = {
    bindings: [],
    alreadyBound: [],
    missingRow: [],
    conflicts: [],
    ambiguous: [],
    skipped: [],
  };

  for (const user of users) {
    const attributes = attributesOf(user);
    if (!attributes['custom:id']) {
      result.skipped.push({ username: user.Username, reason: 'missing custom:id' });
    }
  }

  const groups = groupUsersByCustomId(users);
  for (const [customId, group] of groups) {
    if (group.length > 1) {
      result.ambiguous.push({
        customId,
        users: group.map(({ user, sub }) => ({ username: user.Username, sub })),
      });
      continue;
    }

    const { user, attributes, sub } = group[0];
    if (!sub) {
      result.skipped.push({ customId, username: user.Username, reason: 'missing sub' });
      continue;
    }

    const row = rowsByCustomId.get(customId);
    if (!row) {
      result.missingRow.push({ customId, sub, username: user.Username });
      continue;
    }

    if (row.cognitoSub) {
      if (row.cognitoSub === sub) {
        result.alreadyBound.push({ customId, sub, username: user.Username });
      } else {
        result.conflicts.push({
          customId,
          sub,
          username: user.Username,
          reason: `row is bound to ${row.cognitoSub}`,
        });
      }
      continue;
    }

    if (!identityMatches(row, attributes)) {
      result.conflicts.push({
        customId,
        sub,
        username: user.Username,
        reason: 'email/name mismatch between the User row and Cognito',
      });
      continue;
    }

    result.bindings.push({ customId, sub, username: user.Username });
  }

  return result;
}
