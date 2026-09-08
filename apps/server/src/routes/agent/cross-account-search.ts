import { stripHtml } from 'string-strip-html';

export type SearchAccount = {
  id: string;
  email: string;
  name: string | null;
};

type SearchResponse = {
  threadIds: string[];
  source: 'autorag' | 'raw';
  error?: string;
};

type SearchMessage = {
  subject?: string;
  sender?: { name?: string; email?: string };
  receivedOn?: string;
  decodedBody?: string;
  body?: string;
};

type SearchThread = { latest?: SearchMessage; messages?: SearchMessage[] };

type SearchDependencies = {
  search: (
    connectionId: string,
    params: { query: string; folder: string; maxResults: number },
  ) => Promise<SearchResponse>;
  loadThread: (connectionId: string, threadId: string) => Promise<SearchThread>;
};

function selectCandidates(
  results: { account: SearchAccount; threadIds: string[]; source: 'autorag' | 'raw' }[],
  maxResults: number,
) {
  const candidates: {
    account: SearchAccount;
    threadId: string;
    source: 'autorag' | 'raw';
  }[] = [];
  const seen = new Set<string>();

  for (let rank = 0; candidates.length < maxResults; rank += 1) {
    let found = false;
    for (const result of results) {
      const threadId = result.threadIds[rank];
      if (!threadId) continue;
      found = true;
      const key = `${result.account.id}:${threadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ account: result.account, threadId, source: result.source });
      if (candidates.length === maxResults) break;
    }
    if (!found) break;
  }

  return candidates;
}

function searchTerms(query: string) {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
}

function findMatchingMessage(thread: SearchThread, query: string) {
  const messages = thread.messages?.length ? thread.messages : thread.latest ? [thread.latest] : [];
  const terms = searchTerms(query);
  let best = messages.at(-1);
  let bestScore = -1;

  for (const message of messages) {
    const content = `${message.subject ?? ''} ${stripHtml(message.decodedBody || message.body || '').result}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (content.includes(term) ? 1 : 0), 0);
    if (score >= bestScore) {
      best = message;
      bestScore = score;
    }
  }

  return best;
}

function getExcerpt(message: SearchMessage | undefined, query: string) {
  const body = stripHtml(message?.decodedBody || message?.body || '').result
    .replace(/\s+/g, ' ')
    .trim();
  const indexes = searchTerms(query)
    .map((term) => body.toLowerCase().indexOf(term))
    .filter((index) => index >= 0);
  const start = indexes.length ? Math.max(0, Math.min(...indexes) - 160) : 0;
  return body.slice(start, start + 800);
}

export async function searchAcrossAccounts(
  accounts: SearchAccount[],
  params: { query: string; folder: string; maxResults: number },
  dependencies: SearchDependencies,
) {
  const searchResults = await Promise.allSettled(
    accounts.map(async (account) => {
      const result = await dependencies.search(account.id, params);
      if (result.error) throw new Error(result.error);
      return { account, ...result };
    }),
  );

  const successful = searchResults.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  const failures = searchResults.flatMap((result, index) =>
    result.status === 'rejected'
      ? [{
          connectionId: accounts[index].id,
          accountEmail: accounts[index].email,
          reason: 'Search unavailable',
        }]
      : [],
  );
  const candidates = selectCandidates(successful, params.maxResults);
  const loaded = await Promise.allSettled(
    candidates.map(async ({ account, threadId, source }) => {
      const thread = await dependencies.loadThread(account.id, threadId);
      const match = findMatchingMessage(thread, params.query);
      return {
        threadId,
        connectionId: account.id,
        accountEmail: account.email,
        accountName: account.name,
        subject: match?.subject || thread.latest?.subject || '(No subject)',
        sender: {
          name: match?.sender?.name || thread.latest?.sender?.name || '',
          email: match?.sender?.email || thread.latest?.sender?.email || '',
        },
        receivedOn: match?.receivedOn || thread.latest?.receivedOn || '',
        excerpt: getExcerpt(match, params.query),
        provenance: source === 'autorag' ? 'semantic' : 'provider',
        unavailable: false,
      };
    }),
  );
  const sources = loaded.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const { account, threadId, source } = candidates[index];
    return {
      threadId,
      connectionId: account.id,
      accountEmail: account.email,
      accountName: account.name,
      subject: '(Thread unavailable)',
      sender: { name: '', email: '' },
      receivedOn: '',
      excerpt: '',
      provenance: source === 'autorag' ? 'semantic' : 'provider',
      unavailable: true,
    };
  });

  return {
    query: params.query,
    sources,
    searchedAccounts: successful.length,
    totalAccounts: accounts.length,
    failures,
    unavailableSources: sources.filter((source) => source.unavailable).length,
  };
}
