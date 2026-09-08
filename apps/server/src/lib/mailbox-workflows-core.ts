export type WorkflowMessage = {
  id: string;
  subject?: string;
  sender: { name?: string; email: string };
  receivedOn: string;
  isDraft?: boolean;
  listUnsubscribe?: string;
  tags?: { id: string; name: string }[];
};

export type LabelChange = { addLabels: string[]; removeLabels: string[] };

export type BundleMatcherInput = {
  connectionId?: string | null;
  kind: 'newsletter' | 'receipt' | 'notification' | 'sender';
  value?: string | null;
};

const RECEIPT_SUBJECT = /\b(receipt|invoice|order|payment|paid|purchase|transaction)\b/i;
const AUTOMATED_SENDER = /(?:^|[._+-])(no-?reply|notifications?)(?:@|[._+-])/i;

export function normalizeSenderEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isIncomingMessage(message: WorkflowMessage, mailboxEmail: string) {
  const labels = new Set(message.tags?.flatMap(({ id, name }) => [id, name]) ?? []);
  return (
    !message.isDraft &&
    !labels.has('DRAFT') &&
    !labels.has('SENT') &&
    normalizeSenderEmail(message.sender.email) !== normalizeSenderEmail(mailboxEmail)
  );
}

export function threadHasLabel(messages: WorkflowMessage[], labelName: string, labelId?: string) {
  return messages.some((message) =>
    message.tags?.some(
      ({ id, name }) =>
        id === labelName ||
        name === labelName ||
        (!!labelId && (id === labelId || name === labelId)),
    ),
  );
}

export function isDefinitiveNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
    originalError?: unknown;
    cause?: unknown;
  };
  if (
    [candidate.status, candidate.code, candidate.response?.status].some(
      (status) => Number(status) === 404,
    )
  ) {
    return true;
  }
  return (
    isDefinitiveNotFoundError(candidate.originalError) || isDefinitiveNotFoundError(candidate.cause)
  );
}

export function findLatestIncomingMessage(messages: WorkflowMessage[], mailboxEmail: string) {
  return messages.findLast((message) => isIncomingMessage(message, mailboxEmail));
}

export function shouldCancelReplyReminder(
  messages: WorkflowMessage[],
  sentMessageId: string,
  mailboxEmail: string,
) {
  const watchedIndex = messages.findIndex(({ id }) => id === sentMessageId);
  if (watchedIndex < 0) return false;
  return messages
    .slice(watchedIndex + 1)
    .some((message) => isIncomingMessage(message, mailboxEmail));
}

export function senderExistedBeforeScreening(
  messages: WorkflowMessage[],
  current: WorkflowMessage,
  mailboxEmail: string,
  enabledAt: Date,
) {
  const sender = normalizeSenderEmail(current.sender.email);
  return messages.some((message) => {
    const receivedAt = new Date(message.receivedOn).getTime();
    return (
      message.id !== current.id &&
      isIncomingMessage(message, mailboxEmail) &&
      normalizeSenderEmail(message.sender.email) === sender &&
      Number.isFinite(receivedAt) &&
      receivedAt <= enabledAt.getTime()
    );
  });
}

export function isRuleApplicable(createdAt: Date, receivedOn: string) {
  const receivedAt = new Date(receivedOn).getTime();
  return Number.isFinite(receivedAt) && receivedAt > createdAt.getTime();
}

export function classifyBundleKind(message: WorkflowMessage) {
  const labels = new Set(message.tags?.flatMap(({ id, name }) => [id, name]) ?? []);
  if (RECEIPT_SUBJECT.test(message.subject ?? '') || labels.has('billing'))
    return 'receipt' as const;
  if (message.listUnsubscribe || labels.has('CATEGORY_PROMOTIONS')) return 'newsletter' as const;
  if (labels.has('CATEGORY_UPDATES') || AUTOMATED_SENDER.test(message.sender.email)) {
    return 'notification' as const;
  }
}

export function matchesBundleMatcher(
  message: WorkflowMessage,
  connectionId: string,
  matcher: BundleMatcherInput,
) {
  if (matcher.connectionId && matcher.connectionId !== connectionId) return false;
  if (matcher.kind === 'sender') {
    return normalizeSenderEmail(matcher.value ?? '') === normalizeSenderEmail(message.sender.email);
  }
  return classifyBundleKind(message) === matcher.kind;
}

export function mergeLabelChanges(...changes: LabelChange[]) {
  const addLabels = new Set(changes.flatMap((change) => change.addLabels));
  const removeLabels = new Set(changes.flatMap((change) => change.removeLabels));
  for (const label of removeLabels) addLabels.delete(label);
  return { addLabels: [...addLabels], removeLabels: [...removeLabels] };
}

export function screeningLabelChange(decision: 'pending' | 'allow' | 'archive' | 'block' | 'spam') {
  if (decision === 'pending') {
    return { addLabels: ['Varunsmail/Screener'], removeLabels: ['INBOX'] };
  }
  if (decision === 'allow') {
    return { addLabels: ['INBOX'], removeLabels: ['Varunsmail/Screener'] };
  }
  if (decision === 'block') {
    return { addLabels: ['TRASH'], removeLabels: ['INBOX', 'Varunsmail/Screener'] };
  }
  if (decision === 'spam') {
    return { addLabels: ['SPAM'], removeLabels: ['INBOX', 'Varunsmail/Screener'] };
  }
  return { addLabels: [], removeLabels: ['INBOX', 'Varunsmail/Screener'] };
}

export function ruleLabelChange(rule: {
  action: 'archive' | 'label' | 'important';
  labelId?: string | null;
}) {
  if (rule.action === 'archive') return { addLabels: [], removeLabels: ['INBOX'] };
  if (rule.action === 'important') return { addLabels: ['IMPORTANT'], removeLabels: [] };
  return { addLabels: rule.labelId ? [rule.labelId] : [], removeLabels: [] };
}

type DateParts = { year: number; month: number; day: number; hour: number; minute: number };

function zonedParts(date: Date, timezone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

function zonedDate(parts: DateParts, timezone: string) {
  const expected = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let timestamp = expected;
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = zonedParts(new Date(timestamp), timezone);
    const actualTimestamp = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const correction = expected - actualTimestamp;
    if (!correction) break;
    timestamp += correction;
  }
  return new Date(timestamp);
}

export function nextBundleDelivery(after: Date, deliveryTimes: string[], timezone: string) {
  if (!deliveryTimes.length) return;
  const start = zonedParts(after, timezone);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  const times = [...new Set(deliveryTimes)].sort();
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const localDay = new Date(startDay + dayOffset * 86_400_000);
    for (const time of times) {
      const [hour, minute] = time.split(':').map(Number);
      const candidate = zonedDate(
        {
          year: localDay.getUTCFullYear(),
          month: localDay.getUTCMonth() + 1,
          day: localDay.getUTCDate(),
          hour,
          minute,
        },
        timezone,
      );
      const actual = zonedParts(candidate, timezone);
      if (
        actual.year !== localDay.getUTCFullYear() ||
        actual.month !== localDay.getUTCMonth() + 1 ||
        actual.day !== localDay.getUTCDate() ||
        actual.hour !== hour ||
        actual.minute !== minute
      ) {
        continue;
      }
      if (candidate.getTime() > after.getTime()) return candidate;
    }
  }
}

export function isBundleReleaseDue(
  queuedAt: Date,
  deliveryTimes: string[],
  timezone: string,
  now: Date,
) {
  const delivery = nextBundleDelivery(new Date(queuedAt.getTime() - 1), deliveryTimes, timezone);
  return !!delivery && delivery.getTime() <= now.getTime();
}

export function shouldReleaseHeldBundle(
  current: { deliveryMode: 'immediate' | 'scheduled' },
  next: { deliveryMode: 'immediate' | 'scheduled'; enabled?: boolean },
) {
  return (
    current.deliveryMode === 'scheduled' &&
    (next.deliveryMode === 'immediate' || next.enabled === false)
  );
}

export function validateFocusOrder(
  existing: { connectionId: string; threadId: string }[],
  requested: { connectionId: string; threadId: string }[],
) {
  const key = ({ connectionId, threadId }: { connectionId: string; threadId: string }) =>
    `${connectionId}\u0000${threadId}`;
  const expected = new Set(existing.map(key));
  const next = requested.map(key);
  return (
    next.length === expected.size &&
    new Set(next).size === next.length &&
    next.every((id) => expected.has(id))
  );
}

export async function runProviderFirst<T>(
  mutateProvider: () => Promise<void>,
  persist: () => Promise<T>,
) {
  await mutateProvider();
  return persist();
}
