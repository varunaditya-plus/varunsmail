const ACCOUNT_COLORS = ['#2563EB', '#7C3AED', '#DB2777', '#EA580C', '#059669', '#0891B2'];
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

export function getAccountColor(connectionId: string) {
  let hash = 0;
  for (let index = 0; index < connectionId.length; index++) {
    hash = (hash * 31 + connectionId.charCodeAt(index)) >>> 0;
  }
  return ACCOUNT_COLORS[hash % ACCOUNT_COLORS.length]!;
}

export function isSharedGmailLabel(labelId: string) {
  return SHARED_GMAIL_LABELS.has(labelId);
}
