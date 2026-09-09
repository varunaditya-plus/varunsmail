type OperationKey = {
  userId: string;
  idempotencyKey: string;
  operation: string;
};

export type McpIdempotencyStore = {
  start: (key: OperationKey & { requestHash: string }) => Promise<boolean>;
  find: (key: OperationKey) => Promise<{ requestHash: string; result: string | null } | null>;
  complete: (key: OperationKey, result: string) => Promise<boolean>;
  remove: (key: OperationKey) => Promise<void>;
};

async function hashRequest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function wasRejected(value: unknown) {
  return !!value && typeof value === 'object' && 'success' in value && value.success === false;
}

export function createMcpIdempotencyStore(database: D1Database): McpIdempotencyStore {
  return {
    async start({ userId, idempotencyKey, operation, requestHash }) {
      const inserted = await database
        .prepare(
          `INSERT OR IGNORE INTO mail0_mcp_idempotency
            (user_id, idempotency_key, operation, request_hash, result, created_at)
            VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .bind(userId, idempotencyKey, operation, requestHash, Date.now())
        .run();
      return inserted.meta.changes === 1;
    },
    async find({ userId, idempotencyKey, operation }) {
      return database
        .prepare(
          `SELECT request_hash AS requestHash, result FROM mail0_mcp_idempotency
           WHERE user_id = ? AND idempotency_key = ? AND operation = ?`,
        )
        .bind(userId, idempotencyKey, operation)
        .first<{ requestHash: string; result: string | null }>();
    },
    async complete({ userId, idempotencyKey, operation }, result) {
      const updated = await database
        .prepare(
          `UPDATE mail0_mcp_idempotency SET result = ?
           WHERE user_id = ? AND idempotency_key = ? AND operation = ? AND result IS NULL`,
        )
        .bind(result, userId, idempotencyKey, operation)
        .run();
      return updated.meta.changes === 1;
    },
    async remove({ userId, idempotencyKey, operation }) {
      await database
        .prepare(
          `DELETE FROM mail0_mcp_idempotency
           WHERE user_id = ? AND idempotency_key = ? AND operation = ? AND result IS NULL`,
        )
        .bind(userId, idempotencyKey, operation)
        .run();
    },
  };
}

export async function runMcpIdempotentOperation<T>(
  store: McpIdempotencyStore,
  key: OperationKey,
  input: unknown,
  perform: (markDeliveryAttempted: () => void) => Promise<T>,
) {
  const requestHash = await hashRequest(input);
  if (!(await store.start({ ...key, requestHash }))) {
    const existing = await store.find(key);
    if (!existing || existing.requestHash !== requestHash) {
      throw new Error('Idempotency key was already used with a different message');
    }
    if (!existing.result) {
      throw new Error('This send was already accepted or is still in progress');
    }
    return JSON.parse(existing.result) as T;
  }

  let deliveryAttempted = false;
  let operationResult: T;
  try {
    operationResult = await perform(() => {
      deliveryAttempted = true;
    });
  } catch (error) {
    if (!deliveryAttempted) await store.remove(key);
    throw error;
  }
  if (wasRejected(operationResult)) {
    if (!deliveryAttempted) {
      await store.remove(key);
      return operationResult;
    }
    throw new Error('The send may have been accepted, so it was not made retryable');
  }

  const completed = await store.complete(key, JSON.stringify(operationResult));
  if (!completed) {
    throw new Error('The send was accepted, but its result could not be recorded');
  }
  return operationResult;
}

export const mcpIdempotencyInternals = { hashRequest };
