import { describe, expect, it, vi } from 'vitest';

import { runMcpIdempotentOperation, type McpIdempotencyStore } from './mcp-idempotency';

const key = { userId: 'owner', idempotencyKey: 'send-1234', operation: 'email_send' };

function createStore() {
  let record: { requestHash: string; result: string | null } | null = null;
  const store: McpIdempotencyStore = {
    start: vi.fn(async ({ requestHash }) => {
      if (record) return false;
      record = { requestHash, result: null };
      return true;
    }),
    find: vi.fn(async () => record),
    complete: vi.fn(async (_key, result) => {
      if (!record || record.result) return false;
      record.result = result;
      return true;
    }),
    remove: vi.fn(async () => {
      record = null;
    }),
  };
  return { store, getRecord: () => record };
}

describe('MCP send idempotency', () => {
  it('returns the saved result without performing an identical send twice', async () => {
    const { store } = createStore();
    const perform = vi.fn(async () => ({ success: true, messageId: 'message' }));

    const first = await runMcpIdempotentOperation(store, key, { subject: 'Test' }, perform);
    const replay = await runMcpIdempotentOperation(store, key, { subject: 'Test' }, perform);

    expect(first).toEqual(replay);
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse with a different request before performing it', async () => {
    const { store } = createStore();
    const perform = vi.fn(async () => ({ success: true }));
    await runMcpIdempotentOperation(store, key, { subject: 'First' }, perform);

    await expect(
      runMcpIdempotentOperation(store, key, { subject: 'Second' }, perform),
    ).rejects.toThrow('different message');
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('makes a confirmed pre-delivery rejection retryable', async () => {
    const { store } = createStore();
    const rejected = vi.fn(async () => ({ success: false, error: 'Queue unavailable' }));

    await expect(
      runMcpIdempotentOperation(store, key, { subject: 'Test' }, rejected),
    ).resolves.toMatchObject({ success: false });
    const accepted = vi.fn(async () => ({ success: true, messageId: 'message' }));
    await runMcpIdempotentOperation(store, key, { subject: 'Test' }, accepted);

    expect(rejected).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledOnce();
  });

  it('makes a failure before delivery is attempted retryable', async () => {
    const { store } = createStore();
    const failed = vi.fn(async () => {
      throw new Error('Preflight failed');
    });

    await expect(runMcpIdempotentOperation(store, key, {}, failed)).rejects.toThrow(
      'Preflight failed',
    );
    await expect(
      runMcpIdempotentOperation(store, key, {}, async () => ({ success: true })),
    ).resolves.toEqual({ success: true });
  });

  it('retains the reservation when delivery may have started', async () => {
    const { store, getRecord } = createStore();
    const attempted = vi.fn(async (markDeliveryAttempted: () => void) => {
      markDeliveryAttempted();
      throw new Error('Provider response was lost');
    });

    await expect(runMcpIdempotentOperation(store, key, {}, attempted)).rejects.toThrow(
      'Provider response was lost',
    );
    expect(getRecord()).toMatchObject({ result: null });
    await expect(runMcpIdempotentOperation(store, key, {}, attempted)).rejects.toThrow(
      'already accepted or is still in progress',
    );
    expect(attempted).toHaveBeenCalledOnce();
  });

  it('does not reopen a send when saving the accepted result fails', async () => {
    const { store, getRecord } = createStore();
    vi.mocked(store.complete).mockRejectedValueOnce(new Error('D1 unavailable'));
    const perform = vi.fn(async (markDeliveryAttempted: () => void) => {
      markDeliveryAttempted();
      return { success: true, messageId: 'message' };
    });

    await expect(runMcpIdempotentOperation(store, key, {}, perform)).rejects.toThrow(
      'D1 unavailable',
    );
    expect(getRecord()).toMatchObject({ result: null });
    await expect(runMcpIdempotentOperation(store, key, {}, perform)).rejects.toThrow(
      'already accepted or is still in progress',
    );
    expect(perform).toHaveBeenCalledOnce();
  });

  it('treats a zero-row result update as outcome-unknown', async () => {
    const { store, getRecord } = createStore();
    vi.mocked(store.complete).mockResolvedValueOnce(false);
    const perform = vi.fn(async (markDeliveryAttempted: () => void) => {
      markDeliveryAttempted();
      return { success: true, messageId: 'message' };
    });

    await expect(runMcpIdempotentOperation(store, key, {}, perform)).rejects.toThrow(
      'result could not be recorded',
    );
    expect(getRecord()).toMatchObject({ result: null });
  });
});
