export type ThreadCursor = {
  receivedOn: string;
  threadId: string;
};

export function encodeThreadCursor(cursor: ThreadCursor) {
  return JSON.stringify([cursor.receivedOn, cursor.threadId]);
}

export function decodeThreadCursor(value?: string): ThreadCursor | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { receivedOn: parsed[0], threadId: parsed[1] };
    }
  } catch {
    // Timestamp-only cursors were emitted before thread IDs became part of the keyset.
  }

  return { receivedOn: value, threadId: '\uffff' };
}
