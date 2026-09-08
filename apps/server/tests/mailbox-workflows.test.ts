import {
  classifyBundleKind,
  isBundleReleaseDue,
  isDefinitiveNotFoundError,
  matchesBundleMatcher,
  mergeLabelChanges,
  nextBundleDelivery,
  ruleLabelChange,
  runProviderFirst,
  screeningLabelChange,
  senderExistedBeforeScreening,
  shouldCancelReplyReminder,
  shouldReleaseHeldBundle,
  threadHasLabel,
  isRuleApplicable,
  validateFocusOrder,
  type WorkflowMessage,
} from '../src/lib/mailbox-workflows-core';
import { describe, expect, it, vi } from 'vitest';

const message = (
  id: string,
  sender: string,
  tags: string[] = [],
  extra: Partial<WorkflowMessage> = {},
): WorkflowMessage => ({
  id,
  subject: 'Hello',
  sender: { email: sender },
  receivedOn: new Date(`2026-09-09T10:0${id.length}:00Z`).toISOString(),
  tags: tags.map((tag) => ({ id: tag, name: tag })),
  ...extra,
});

describe('reply reminders', () => {
  it('cancels only for an external reply after the watched sent message', () => {
    const messages = [
      message('old', 'person@example.com'),
      message('sent', 'owner@example.com', ['SENT']),
      message('draft', 'owner@example.com', ['DRAFT'], { isDraft: true }),
      message('reply', 'person@example.com'),
    ];

    expect(shouldCancelReplyReminder(messages, 'sent', 'owner@example.com')).toBe(true);
    expect(shouldCancelReplyReminder(messages, 'missing', 'owner@example.com')).toBe(false);
    expect(shouldCancelReplyReminder(messages.slice(0, 3), 'sent', 'owner@example.com')).toBe(
      false,
    );
  });
});

describe('sender screening and rules', () => {
  it('maps every screening decision to Gmail labels', () => {
    expect(screeningLabelChange('pending')).toEqual({
      addLabels: ['Varunsmail/Screener'],
      removeLabels: ['INBOX'],
    });
    expect(screeningLabelChange('allow').addLabels).toContain('INBOX');
    expect(screeningLabelChange('archive').removeLabels).toContain('INBOX');
    expect(screeningLabelChange('block').addLabels).toContain('TRASH');
    expect(screeningLabelChange('spam').addLabels).toContain('SPAM');
  });

  it('combines rule actions with terminal removals taking precedence', () => {
    expect(
      mergeLabelChanges(
        ruleLabelChange({ action: 'important' }),
        ruleLabelChange({ action: 'label', labelId: 'Label_42' }),
        ruleLabelChange({ action: 'archive' }),
        { addLabels: ['INBOX'], removeLabels: [] },
      ),
    ).toEqual({
      addLabels: ['IMPORTANT', 'Label_42'],
      removeLabels: ['INBOX'],
    });
  });

  it('never persists workflow state before Gmail accepts the mutation', async () => {
    const steps: string[] = [];
    await runProviderFirst(
      async () => {
        steps.push('gmail');
      },
      async () => {
        steps.push('d1');
      },
    );
    expect(steps).toEqual(['gmail', 'd1']);

    const persist = vi.fn();
    await expect(
      runProviderFirst(async () => {
        throw new Error('provider failed');
      }, persist),
    ).rejects.toThrow('provider failed');
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps pre-existing senders trusted within the same Gmail thread', () => {
    const enabledAt = new Date('2026-09-09T10:00:00Z');
    const current = message('new', 'person@example.com', [], {
      receivedOn: '2026-09-09T11:00:00Z',
    });
    expect(
      senderExistedBeforeScreening(
        [message('old', 'person@example.com', [], { receivedOn: '2026-09-08T11:00:00Z' }), current],
        current,
        'owner@example.com',
        enabledAt,
      ),
    ).toBe(true);
  });

  it('applies rules only to mail received after the rule was created', () => {
    const createdAt = new Date('2026-09-09T10:00:00Z');
    expect(isRuleApplicable(createdAt, '2026-09-09T10:00:01Z')).toBe(true);
    expect(isRuleApplicable(createdAt, '2026-09-09T09:59:59Z')).toBe(false);
  });

  it('disables label rules only for a definitive provider not-found response', () => {
    expect(isDefinitiveNotFoundError({ response: { status: 404 } })).toBe(true);
    expect(
      isDefinitiveNotFoundError({
        code: 'UNKNOWN_ERROR',
        originalError: { code: 404 },
      }),
    ).toBe(true);
    expect(isDefinitiveNotFoundError({ response: { status: 429 } })).toBe(false);
    expect(isDefinitiveNotFoundError({ status: 500 })).toBe(false);
    expect(isDefinitiveNotFoundError(new Error('Label not found'))).toBe(false);
  });
});

describe('mail bundles', () => {
  it('classifies receipts before newsletters and notifications', () => {
    expect(
      classifyBundleKind(
        message('1', 'no-reply@shop.example', ['CATEGORY_PROMOTIONS'], {
          subject: 'Your payment receipt',
          listUnsubscribe: '<mailto:unsubscribe@example.com>',
        }),
      ),
    ).toBe('receipt');
    expect(
      classifyBundleKind(message('2', 'news@example.com', [], { listUnsubscribe: 'url' })),
    ).toBe('newsletter');
    expect(classifyBundleKind(message('3', 'notifications@example.com'))).toBe('notification');
  });

  it('scopes sender matchers to the selected Gmail connection', () => {
    const incoming = message('1', 'sender@example.com');
    const matcher = {
      connectionId: 'account-a',
      kind: 'sender' as const,
      value: 'SENDER@example.com',
    };
    expect(matchesBundleMatcher(incoming, 'account-a', matcher)).toBe(true);
    expect(matchesBundleMatcher(incoming, 'account-b', matcher)).toBe(false);
  });

  it('releases at the next Europe/Madrid local delivery time across a day boundary', () => {
    const queued = new Date('2026-09-08T19:30:00Z');
    const delivery = nextBundleDelivery(queued, ['08:00', '20:00'], 'Europe/Madrid');
    expect(delivery?.toISOString()).toBe('2026-09-09T06:00:00.000Z');
    expect(
      isBundleReleaseDue(
        queued,
        ['08:00', '20:00'],
        'Europe/Madrid',
        new Date('2026-09-09T05:59:59Z'),
      ),
    ).toBe(false);
    expect(
      isBundleReleaseDue(
        queued,
        ['08:00', '20:00'],
        'Europe/Madrid',
        new Date('2026-09-09T06:00:00Z'),
      ),
    ).toBe(true);
  });

  it('releases held mail when a scheduled bundle is disabled or made immediate', () => {
    const current = { deliveryMode: 'scheduled' as const };
    expect(shouldReleaseHeldBundle(current, { deliveryMode: 'scheduled', enabled: false })).toBe(
      true,
    );
    expect(shouldReleaseHeldBundle(current, { deliveryMode: 'immediate', enabled: true })).toBe(
      true,
    );
    expect(shouldReleaseHeldBundle(current, { deliveryMode: 'scheduled', enabled: true })).toBe(
      false,
    );
  });

  it('skips a nonexistent local digest time during the spring DST jump', () => {
    const delivery = nextBundleDelivery(
      new Date('2026-03-28T23:00:00Z'),
      ['02:30'],
      'Europe/Madrid',
    );
    expect(delivery?.toISOString()).toBe('2026-03-30T00:30:00.000Z');
  });
});

describe('focus queue', () => {
  it('keeps Focus when an older message carries the Gmail label', () => {
    const messages = [
      message('old', 'person@example.com', ['Label_42']),
      message('reply', 'person@example.com'),
    ];

    expect(threadHasLabel(messages, 'Varunsmail/Focus', 'Label_42')).toBe(true);
    expect(threadHasLabel(messages, 'Varunsmail/Focus', 'Label_99')).toBe(false);
  });

  it('requires every connection-scoped thread exactly once', () => {
    const current = [
      { connectionId: 'a', threadId: 'same-id' },
      { connectionId: 'b', threadId: 'same-id' },
    ];
    expect(validateFocusOrder(current, [...current].reverse())).toBe(true);
    expect(validateFocusOrder(current, [current[0], current[0]])).toBe(false);
    expect(validateFocusOrder(current, [current[0]])).toBe(false);
  });
});
