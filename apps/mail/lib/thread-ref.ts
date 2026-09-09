export const ACCOUNT_COLOR_OPTIONS = [
  { name: 'Blue', value: '#2563EB' },
  { name: 'Violet', value: '#7C3AED' },
  { name: 'Pink', value: '#DB2777' },
  { name: 'Orange', value: '#EA580C' },
  { name: 'Green', value: '#059669' },
  { name: 'Cyan', value: '#0891B2' },
  { name: 'Red', value: '#DC2626' },
  { name: 'Gold', value: '#CA8A04' },
];
const SHARED_GMAIL_LABELS = new Set([
  'CHAT',
  'SENT',
  'INBOX',
  'IMPORTANT',
  'TRASH',
  'DRAFT',
  'SPAM',
  'STARRED',
  'UNREAD',
  'CATEGORY_FORUMS',
  'CATEGORY_UPDATES',
  'CATEGORY_PERSONAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
]);

export function threadKey(threadId: string, connectionId?: string | null) {
  return connectionId ? `${connectionId}:${threadId}` : threadId;
}

export function parseThreadKey(key: string, fallbackConnectionId?: string | null) {
  const separator = key.indexOf(':');
  if (separator === -1) return { threadId: key, connectionId: fallbackConnectionId ?? undefined };
  return {
    connectionId: key.slice(0, separator),
    threadId: key.slice(separator + 1),
  };
}

export function groupThreadKeys(keys: string[], fallbackConnectionId?: string | null) {
  const groups = new Map<string | undefined, string[]>();
  for (const key of keys) {
    const ref = parseThreadKey(key, fallbackConnectionId);
    const ids = groups.get(ref.connectionId) ?? [];
    ids.push(ref.threadId);
    groups.set(ref.connectionId, ids);
  }
  return groups;
}

export function getAccountColor(connectionId: string, accountColors?: Record<string, string>) {
  const customColor = accountColors?.[connectionId];
  if (customColor) return customColor;

  let hash = 0;
  for (let index = 0; index < connectionId.length; index++) {
    hash = (hash * 31 + connectionId.charCodeAt(index)) >>> 0;
  }
  return ACCOUNT_COLOR_OPTIONS[hash % ACCOUNT_COLOR_OPTIONS.length]!.value;
}

export function isSharedGmailLabel(labelId: string) {
  return SHARED_GMAIL_LABELS.has(labelId);
}
