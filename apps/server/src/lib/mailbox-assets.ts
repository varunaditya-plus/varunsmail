import { and, eq } from 'drizzle-orm';
import { load } from 'cheerio';

import type { IGetThreadResponse } from './driver/types';
import { connection } from '../db/schema';
import type { ZeroEnv } from '../env';
import { createDb } from '../db';

export type MailboxAssetKind = 'all' | 'attachment' | 'link';

type MailboxAssetBase = {
  id: string;
  connectionId: string;
  accountEmail: string;
  threadId: string;
  messageId: string;
  subject: string;
  senderName: string;
  senderEmail: string;
  receivedAt: string;
};

export type MailboxAttachmentAsset = MailboxAssetBase & {
  kind: 'attachment';
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type MailboxLinkAsset = MailboxAssetBase & {
  kind: 'link';
  url: string;
  title: string;
  host: string;
};

export type MailboxAsset = MailboxAttachmentAsset | MailboxLinkAsset;

export type ListMailboxAssetsInput = {
  kind?: MailboxAssetKind;
  connectionId?: string;
  query?: string;
  cursor?: string;
  limit?: number;
};

const MAX_SCANNED_THREADS = 250;

const timestamp = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const compareAssets = (a: MailboxAsset, b: MailboxAsset) => {
  const dateOrder = timestamp(b.receivedAt) - timestamp(a.receivedAt);
  if (dateOrder) return dateOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

function safeLink(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) return;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return;
    return { url: parsed.href, host: parsed.hostname.replace(/^www\./, '') };
  } catch {
    return;
  }
}

function messageLinks(...sources: string[]) {
  const links = new Map<string, { url: string; host: string; title: string }>();
  for (const source of sources) {
    if (!source) continue;
    const $ = load(source);
    $('a[href]').each((_, element) => {
      const link = safeLink($(element).attr('href') ?? '');
      if (!link || links.has(link.url)) return;
      const title = $(element).text().replace(/\s+/g, ' ').trim().slice(0, 160);
      links.set(link.url, { ...link, title: title || link.host });
    });
    const text = $.root().text();
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      const link = safeLink(match[0].replace(/[),.;!?\]}]+$/, ''));
      if (link && !links.has(link.url)) links.set(link.url, { ...link, title: link.host });
    }
  }
  return [...links.values()];
}

function encodeCursor(asset: MailboxAsset) {
  return btoa(JSON.stringify([timestamp(asset.receivedAt), asset.id]));
}

function decodeCursor(cursor: string) {
  try {
    const value = JSON.parse(atob(cursor));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== 'number' ||
      typeof value[1] !== 'string'
    ) {
      throw new Error();
    }
    return { timestamp: value[0], id: value[1] };
  } catch {
    throw new Error('Invalid mailbox asset cursor');
  }
}

function matchesQuery(asset: MailboxAsset, query: string) {
  if (!query) return true;
  const values = [
    asset.accountEmail,
    asset.subject,
    asset.senderName,
    asset.senderEmail,
    asset.kind === 'attachment' ? asset.filename : asset.title,
    asset.kind === 'attachment' ? asset.mimeType : asset.url,
  ];
  return values.some((value) => value.toLowerCase().includes(query));
}

async function readThreadAssets(
  env: ZeroEnv,
  mailbox: { id: string; email: string },
  key: string,
) {
  const attachments = new Map<string, MailboxAttachmentAsset>();
  const links = new Map<string, MailboxLinkAsset>();
  const prefix = `${mailbox.id}/`;
  const object = await env.THREADS_BUCKET.get(key);
  if (!object) return { attachments: [], links: [] };
  let thread: IGetThreadResponse;
  try {
    thread = await object.json<IGetThreadResponse>();
  } catch {
    return { attachments: [], links: [] };
  }
  const threadId = key.slice(prefix.length, -'.json'.length);
  for (const message of thread.messages ?? []) {
    const base = {
      connectionId: mailbox.id,
      accountEmail: mailbox.email,
      threadId,
      messageId: message.id,
      subject: message.subject || '(No subject)',
      senderName: message.sender?.name ?? '',
      senderEmail: message.sender?.email ?? '',
      receivedAt: message.receivedOn ?? '',
    };
    for (const attachment of message.attachments ?? []) {
      const id = `attachment:${mailbox.id}:${message.id}:${attachment.attachmentId}`;
      attachments.set(id, {
        ...base,
        id,
        kind: 'attachment',
        attachmentId: attachment.attachmentId,
        filename: attachment.filename || 'Untitled attachment',
        mimeType: attachment.mimeType || 'application/octet-stream',
        size: Math.max(0, attachment.size || 0),
      });
    }
    const extractedLinks = messageLinks(
      message.decodedBody ?? '',
      message.processedHtml ?? '',
      message.body ?? '',
    );
    for (let linkIndex = 0; linkIndex < extractedLinks.length; linkIndex++) {
      const link = extractedLinks[linkIndex]!;
      const candidate: MailboxLinkAsset = {
        ...base,
        ...link,
        id: `link:${mailbox.id}:${message.id}:${linkIndex}`,
        kind: 'link',
      };
      const existing = links.get(link.url);
      if (!existing || compareAssets(candidate, existing) < 0) links.set(link.url, candidate);
    }
  }

  return { attachments: [...attachments.values()], links: [...links.values()] };
}

async function listThreadObjects(env: ZeroEnv, mailbox: { id: string; email: string }) {
  const objects: { key: string; uploaded: number; mailbox: typeof mailbox }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.THREADS_BUCKET.list({ prefix: `${mailbox.id}/`, cursor, limit: 1000 });
    objects.push(
      ...page.objects
        .filter(({ key }) => key.endsWith('.json'))
        .map(({ key, uploaded }) => ({ key, uploaded: uploaded.getTime(), mailbox })),
    );
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

export async function listMailboxAssets(
  env: ZeroEnv,
  userId: string,
  input: ListMailboxAssetsInput = {},
) {
  const { db } = createDb(env.DB);
  const mailboxes = await db.query.connection.findMany({
    where: input.connectionId
      ? and(eq(connection.userId, userId), eq(connection.id, input.connectionId))
      : eq(connection.userId, userId),
    columns: { id: true, email: true },
  });
  if (input.connectionId && !mailboxes.length) throw new Error('Mailbox connection not found');

  const objects = (await Promise.all(mailboxes.map((mailbox) => listThreadObjects(env, mailbox))))
    .flat()
    .sort((a, b) => b.uploaded - a.uploaded);
  const selectedObjects = objects.slice(0, MAX_SCANNED_THREADS);
  const collections = [];
  for (let offset = 0; offset < selectedObjects.length; offset += 25) {
    collections.push(
      ...(await Promise.all(
        selectedObjects
          .slice(offset, offset + 25)
          .map(({ mailbox, key }) => readThreadAssets(env, mailbox, key)),
      )),
    );
  }
  const kind = input.kind ?? 'all';
  const query = input.query?.trim().toLowerCase() ?? '';
  const attachments = collections.flatMap((collection) => collection.attachments);
  const links = new Map<string, MailboxLinkAsset>();
  for (const collection of collections) {
    for (const link of collection.links) {
      const existing = links.get(link.url);
      if (!existing || compareAssets(link, existing) < 0) links.set(link.url, link);
    }
  }
  const assets = [
    ...(kind === 'link' ? [] : attachments),
    ...(kind === 'attachment' ? [] : links.values()),
  ]
    .filter((asset) => matchesQuery(asset, query))
    .sort(compareAssets);
  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
  const start = cursor
    ? assets.findIndex((asset) => {
        const assetTimestamp = timestamp(asset.receivedAt);
        return (
          assetTimestamp < cursor.timestamp ||
          (assetTimestamp === cursor.timestamp && asset.id > cursor.id)
        );
      })
    : 0;
  const offset = start < 0 ? assets.length : start;
  const limit = Math.max(1, Math.min(100, input.limit ?? 40));
  const items = assets.slice(offset, offset + limit);

  return {
    items,
    nextCursor:
      offset + items.length < assets.length && items.length ? encodeCursor(items.at(-1)!) : null,
    total: assets.length,
    scannedThreads: selectedObjects.length,
    isPartial: objects.length > selectedObjects.length,
  };
}
