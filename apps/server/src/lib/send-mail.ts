import { updateWritingStyleMatrix } from '../services/writing-style-service';
import { recordMailboxAction, writeOutboxState } from './mailbox-activity';
import type { IEmailSendBatch, IOutgoingMessage } from '../types';
import { getZeroAgent, getZeroDB } from './server-utils';
import { toAttachmentFiles } from './attachments';
import { serializedFileSchema } from './schemas';
import type { ZeroEnv } from '../env';
import { z } from 'zod';

const senderSchema = z.object({
  name: z.string().optional(),
  email: z.string(),
});

export const sendMailInputSchema = z.object({
  to: z.array(senderSchema),
  subject: z.string(),
  message: z.string(),
  attachments: z.array(serializedFileSchema).optional().default([]),
  headers: z.record(z.string()).optional().default({}),
  cc: z.array(senderSchema).optional(),
  bcc: z.array(senderSchema).optional(),
  threadId: z.string().optional(),
  fromEmail: z.string().optional(),
  draftId: z.string().optional(),
  isForward: z.boolean().optional(),
  originalMessage: z.string().optional(),
  scheduleAt: z.string().optional(),
});

export type SendMailInput = z.infer<typeof sendMailInputSchema>;

export type SendMailboxEmailOptions = {
  env: ZeroEnv;
  userId: string;
  connectionId: string;
  input: SendMailInput;
  waitUntil?: (promise: Promise<unknown>) => void;
};

function getScheduleTarget(scheduleAt?: string, now = Date.now()) {
  if (!scheduleAt) return { targetTime: now + 15_000 } as const;

  const parsedTime = Date.parse(scheduleAt);
  if (isNaN(parsedTime)) return { error: 'Invalid schedule date format' } as const;
  if (parsedTime <= now) return { error: 'Schedule time must be in the future' } as const;
  return { targetTime: parsedTime } as const;
}

export async function sendMailboxEmail({
  env,
  userId,
  connectionId,
  input,
  waitUntil,
}: SendMailboxEmailOptions) {
  const { draftId, scheduleAt, attachments, ...mail } = input;
  const agent = await getZeroAgent(connectionId, waitUntil ? { waitUntil } : undefined);

  const db = await getZeroDB(userId);
  const userSettings = await db.findUserSettings();
  const undoSendEnabled = userSettings?.settings?.undoSendEnabled ?? false;
  const shouldSchedule = !!scheduleAt || undoSendEnabled;
  const defer = (promise: Promise<unknown>) => waitUntil?.(promise);

  const afterTask = async () => {
    try {
      console.warn('Saving writing style matrix...');
      await updateWritingStyleMatrix(connectionId, input.message);
      console.warn('Saved writing style matrix.');
    } catch (error) {
      console.error('Failed to save writing style matrix', error);
    }
  };

  if (shouldSchedule) {
    const messageId = crypto.randomUUID();
    const schedule = getScheduleTarget(scheduleAt);
    if ('error' in schedule) return { success: false, error: schedule.error } as const;

    const { targetTime } = schedule;
    const rawDelaySeconds = Math.floor((targetTime - Date.now()) / 1000);
    const pendingTtl = Math.max(86400, rawDelaySeconds + 86400);
    const maxQueueDelay = 43200;
    const isLongTerm = rawDelaySeconds > maxQueueDelay;
    const {
      pending_emails_status: statusKV,
      pending_emails_payload: payloadKV,
      scheduled_emails: scheduledKV,
      send_email_queue,
    } = env;

    try {
      await writeOutboxState(statusKV, messageId, {
        status: 'pending',
        sendAt: targetTime,
        createdAt: Date.now(),
        attempts: 0,
      });
    } catch (error) {
      console.error(`Failed to write pending status to KV for message ${messageId}`, error);
      return { success: false, error: 'Failed to schedule email status' } as const;
    }

    const mailPayload = {
      ...mail,
      draftId,
      attachments,
      connectionId,
    };

    try {
      await payloadKV.put(messageId, JSON.stringify(mailPayload), {
        expirationTtl: pendingTtl,
      });
    } catch (error) {
      console.error(`Failed to write email payload to KV for message ${messageId}`, error);
      return { success: false, error: 'Failed to schedule email payload' } as const;
    }

    if (isLongTerm) {
      try {
        await scheduledKV.put(
          messageId,
          JSON.stringify({ messageId, connectionId, sendAt: targetTime }),
          { expirationTtl: Math.min(Math.ceil(rawDelaySeconds + 3600), 31556952) },
        );
      } catch (error) {
        console.error(`Failed to write long-term schedule to KV for message ${messageId}`, error);
        return { success: false, error: 'Failed to schedule email (long-term)' } as const;
      }
    } else {
      const delaySeconds = rawDelaySeconds;
      const queueBody: IEmailSendBatch = { messageId, connectionId, sendAt: targetTime };
      try {
        await send_email_queue.send(queueBody, { delaySeconds });
      } catch (error) {
        console.error(`Failed to enqueue email send for message ${messageId}`, error);
        return { success: false, error: 'Failed to enqueue email send' } as const;
      }
    }

    await recordMailboxAction(env, {
      userId,
      connectionId,
      messageId,
      action: 'send email',
      status: 'pending',
      detail: scheduleAt ? 'Scheduled' : 'Undo-send window',
    });
    defer(afterTask());

    if (isLongTerm) {
      return { success: true, scheduled: true, messageId, sendAt: targetTime } as const;
    }
    return { success: true, queued: true, messageId, sendAt: targetTime } as const;
  }

  const mailWithAttachments = {
    ...mail,
    attachments: toAttachmentFiles(attachments),
  } as unknown as IOutgoingMessage;

  let result;
  try {
    result = draftId
      ? await agent.stub.sendDraft(draftId, mailWithAttachments)
      : await agent.stub.create(mailWithAttachments);
  } catch (error) {
    defer(
      recordMailboxAction(env, {
        userId,
        connectionId,
        threadId: input.threadId,
        action: input.threadId ? 'reply' : 'send email',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
  defer(
    recordMailboxAction(env, {
      userId,
      connectionId,
      threadId: input.threadId,
      action: input.threadId ? 'reply' : 'send email',
      status: 'succeeded',
    }),
  );

  defer(afterTask());
  return {
    success: true,
    ...(result?.id == null ? {} : { messageId: result.id }),
    ...(result?.threadId == null ? {} : { threadId: result.threadId }),
  } as const;
}

export const sendMailInternals = { getScheduleTarget };
