import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findUserSettings: vi.fn(),
  recordMailboxAction: vi.fn(),
  sendDraft: vi.fn(),
  updateWritingStyleMatrix: vi.fn(),
  writeOutboxState: vi.fn(),
}));

vi.mock('./server-utils', () => ({
  getZeroAgent: vi.fn(async () => ({
    stub: { create: mocks.create, sendDraft: mocks.sendDraft },
  })),
  getZeroDB: vi.fn(async () => ({ findUserSettings: mocks.findUserSettings })),
}));
vi.mock('./mailbox-activity', () => ({
  recordMailboxAction: mocks.recordMailboxAction,
  writeOutboxState: mocks.writeOutboxState,
}));
vi.mock('../services/writing-style-service', () => ({
  updateWritingStyleMatrix: mocks.updateWritingStyleMatrix,
}));

import { sendMailboxEmail, sendMailInternals } from './send-mail';
import type { ZeroEnv } from '../env';

const { getScheduleTarget } = sendMailInternals;

describe('send schedule validation', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z');

  it('uses the undo-send window when no schedule is provided', () => {
    expect(getScheduleTarget(undefined, now)).toEqual({ targetTime: now + 15_000 });
  });

  it('rejects malformed and non-future schedules', () => {
    expect(getScheduleTarget('not-a-date', now)).toEqual({
      error: 'Invalid schedule date format',
    });
    expect(getScheduleTarget('2026-09-09T12:00:00.000Z', now)).toEqual({
      error: 'Schedule time must be in the future',
    });
    expect(getScheduleTarget('2026-09-09T11:59:59.999Z', now)).toEqual({
      error: 'Schedule time must be in the future',
    });
  });

  it('accepts a valid future schedule unchanged', () => {
    const scheduleAt = '2026-09-09T12:00:00.001Z';
    expect(getScheduleTarget(scheduleAt, now)).toEqual({ targetTime: Date.parse(scheduleAt) });
  });
});

describe('send result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserSettings.mockResolvedValue({ settings: { undoSendEnabled: false } });
    mocks.recordMailboxAction.mockResolvedValue(undefined);
    mocks.updateWritingStyleMatrix.mockResolvedValue(undefined);
  });

  it('returns the provider message and thread IDs for an immediate send', async () => {
    mocks.create.mockResolvedValue({ id: 'message-1', threadId: 'thread-1' });

    await expect(
      sendMailboxEmail({
        env: {} as ZeroEnv,
        userId: 'user-1',
        connectionId: 'connection-1',
        input: {
          to: [{ email: 'recipient@example.com' }],
          subject: 'Subject',
          message: '<p>Message</p>',
          attachments: [],
          headers: {},
        },
      }),
    ).resolves.toEqual({ success: true, messageId: 'message-1', threadId: 'thread-1' });
  });

  it('marks delivery attempted immediately before calling the provider', async () => {
    const events: string[] = [];
    const markDeliveryAttempted = vi.fn(() => events.push('marked'));
    mocks.create.mockImplementation(async () => {
      events.push('provider');
      return { id: 'message-1' };
    });

    await sendMailboxEmail({
      env: {} as ZeroEnv,
      userId: 'user-1',
      connectionId: 'connection-1',
      input: {
        to: [{ email: 'recipient@example.com' }],
        subject: 'Subject',
        message: '<p>Message</p>',
        attachments: [],
        headers: {},
      },
      markDeliveryAttempted,
    });

    expect(markDeliveryAttempted).toHaveBeenCalledOnce();
    expect(events).toEqual(['marked', 'provider']);
  });

  it('leaves a pre-accept scheduling failure retryable', async () => {
    mocks.findUserSettings.mockResolvedValue({ settings: { undoSendEnabled: true } });
    mocks.writeOutboxState.mockRejectedValue(new Error('KV unavailable'));
    const markDeliveryAttempted = vi.fn();

    await expect(
      sendMailboxEmail({
        env: { pending_emails_status: {} } as ZeroEnv,
        userId: 'user-1',
        connectionId: 'connection-1',
        input: {
          to: [{ email: 'recipient@example.com' }],
          subject: 'Subject',
          message: '<p>Message</p>',
          attachments: [],
          headers: {},
        },
        markDeliveryAttempted,
      }),
    ).resolves.toMatchObject({ success: false });
    expect(markDeliveryAttempted).not.toHaveBeenCalled();
  });
});
