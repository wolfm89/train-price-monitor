/**
 * Self-service export of everything stored for one user (GDPR Art. 15 access
 * and Art. 20 portability). Attributes stored as JSON strings are decoded so
 * the file is readable without knowing the storage format.
 */
export const DATA_EXPORT_FORMAT_VERSION = 1;

type StoredItem = Record<string, unknown>;

export interface DataExportInput {
  user: StoredItem;
  journeys: StoredItem[];
  notifications: StoredItem[];
  /** Presigned link to the stored picture; it expires after an hour. */
  profilePictureUrl?: string;
  exportedAt: Date;
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeFields(item: StoredItem, fields: string[]): StoredItem {
  const decoded: StoredItem = { ...item };
  for (const field of fields) {
    if (field in decoded) decoded[field] = decodeJson(decoded[field]);
  }
  return decoded;
}

function byStringField(field: string): (a: StoredItem, b: StoredItem) => number {
  return (a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
}

/** Shows the DynamoDB TTL (epoch seconds) as the date the item is due for deletion. */
function withDeletionDate(item: StoredItem): StoredItem {
  const { ttl, ...rest } = item;
  return typeof ttl === 'number' ? { ...rest, scheduledDeletion: new Date(ttl * 1000).toISOString() } : rest;
}

export function buildDataExport({
  user,
  journeys,
  notifications,
  profilePictureUrl,
  exportedAt,
}: DataExportInput): string {
  const document = {
    formatVersion: DATA_EXPORT_FORMAT_VERSION,
    service: 'Train Price Monitor',
    exportedAt: exportedAt.toISOString(),
    account: decodeFields(user, ['loyaltyCards']),
    profilePicture: user['profilePicture']
      ? { file: user['profilePicture'], temporaryDownloadUrl: profilePictureUrl ?? null }
      : null,
    journeyMonitors: [...journeys]
      .sort(byStringField('departure'))
      .map((journey) => withDeletionDate(decodeFields(journey, ['loyaltyCard', 'cachedMeans']))),
    notifications: [...notifications]
      .sort(byStringField('timestamp'))
      .map((notification) => withDeletionDate(decodeFields(notification, ['data']))),
  };
  return JSON.stringify(document, null, 2);
}
