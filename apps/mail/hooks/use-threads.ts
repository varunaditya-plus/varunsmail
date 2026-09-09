import { backgroundQueueAtom, isThreadInBackgroundQueueAtom } from '@/store/backgroundQueue';
import { useInfiniteQuery, useQuery, useMutation } from '@tanstack/react-query';
import type { IGetThreadResponse } from '../../server/src/lib/driver/types';
import { useSearchValue } from '@/hooks/use-search-value';
import { isSharedGmailLabel, threadKey } from '@/lib/thread-ref';
import { useAliasMailbox } from '@/hooks/use-alias-mailbox';
import { useConnections } from '@/hooks/use-connections';
import { useTRPC } from '@/providers/query-provider';
import useSearchLabels from './use-labels-search';
import { useSession } from '@/lib/auth-client';
import { useAtom, useAtomValue } from 'jotai';
import { useSettings } from './use-settings';
import { useParams } from 'react-router';
import { useTheme } from 'next-themes';
import { useQueryState } from 'nuqs';
import { useMemo } from 'react';

export const useThreads = () => {
  const { folder } = useParams<{ folder: string }>();
  const [searchValue] = useSearchValue();
  const [backgroundQueue] = useAtom(backgroundQueueAtom);
  const isInQueue = useAtomValue(isThreadInBackgroundQueueAtom);
  const trpc = useTRPC();
  const { labels } = useSearchLabels();
  const {
    mailbox: aliasMailbox,
    isActive: isAliasMailboxActive,
    isResolving: isAliasMailboxResolving,
  } = useAliasMailbox();
  const [accountFilter] = useQueryState('accounts');
  const { data: connectionsData } = useConnections();
  const isUnifiedInbox = folder === 'unified';
  const isWorkflowView = ['screening', 'bundles', 'focus', 'rules'].includes(folder ?? '');
  const gmailConnectionIds = useMemo(
    () =>
      new Set(
        connectionsData?.connections
          .filter((connection) => connection.providerId === 'google')
          .map((connection) => connection.id) ?? [],
      ),
    [connectionsData?.connections],
  );
  const connectionIds = accountFilter?.split(',').filter((id) => gmailConnectionIds.has(id)) ?? [];
  const unifiedLabels = labels.filter(isSharedGmailLabel);
  const connectionLabels = aliasMailbox ? [...new Set([...labels, aliasMailbox.labelId])] : labels;

  const unifiedQuery = useInfiniteQuery(
    trpc.mail.listUnifiedThreads.infiniteQueryOptions(
      {
        q: searchValue.value,
        labelIds: unifiedLabels,
        connectionIds,
      },
      {
        enabled: isUnifiedInbox,
        initialCursor: '',
        getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
        staleTime: 60 * 1000,
        refetchOnMount: true,
        refetchInterval: 60 * 1000,
        refetchIntervalInBackground: true,
      },
    ),
  );

  const connectionQuery = useInfiniteQuery(
    trpc.mail.listThreads.infiniteQueryOptions(
      {
        q: searchValue.value,
        folder,
        labelIds: connectionLabels,
        connectionId: isAliasMailboxActive ? aliasMailbox?.sourceConnectionId : undefined,
      },
      {
        enabled:
          !isUnifiedInbox &&
          !isWorkflowView &&
          !isAliasMailboxResolving &&
          (!isAliasMailboxActive || !!aliasMailbox),
        initialCursor: '',
        getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
        staleTime: 60 * 1000 * 1, // 1 minute
        refetchOnMount: true,
        refetchIntervalInBackground: true,
      },
    ),
  );
  const threadsQuery = isUnifiedInbox ? unifiedQuery : connectionQuery;

  // Flatten threads from all pages and sort by receivedOn date (newest first)

  const threads = useMemo(() => {
    if (!threadsQuery.data) return [];

    const seen = new Set<string>();
    return threadsQuery.data.pages
      .flatMap((page) => page.threads)
      .filter(Boolean)
      .filter((thread) => {
        const key = thread.key ?? threadKey(thread.id, thread.connectionId);
        if (seen.has(key) || isInQueue(`thread:${key}`)) return false;
        seen.add(key);
        return true;
      });
  }, [threadsQuery.data, threadsQuery.dataUpdatedAt, isInQueue, backgroundQueue]);

  const partialFailures = useMemo(
    () =>
      threadsQuery.data?.pages
        .flatMap((page) => page.partialFailures ?? [])
        .filter(
          (failure, index, failures) =>
            failures.findIndex((item) => item.connectionId === failure.connectionId) === index,
        ) ?? [],
    [threadsQuery.data],
  );

  const isEmpty = useMemo(() => threads.length === 0, [threads]);
  const isReachingEnd =
    isEmpty ||
    (threadsQuery.data &&
      !threadsQuery.data.pages[threadsQuery.data.pages.length - 1]?.nextPageToken);

  const loadMore = async () => {
    if (threadsQuery.isLoading || threadsQuery.isFetching) return;
    await threadsQuery.fetchNextPage();
  };

  return [threadsQuery, threads, isReachingEnd, loadMore, partialFailures] as const;
};

export const useThread = (threadId: string | null, connectionId?: string | null) => {
  const { data: session } = useSession();
  const [_threadId] = useQueryState('threadId');
  const [_connectionId] = useQueryState('connectionId');
  const id = threadId ? threadId : _threadId;
  const mailboxId = connectionId ?? _connectionId ?? undefined;
  const trpc = useTRPC();
  const { data: settings } = useSettings();
  const { theme: systemTheme } = useTheme();

  const threadQuery = useQuery(
    trpc.mail.get.queryOptions(
      {
        id: id!,
        connectionId: mailboxId,
      },
      {
        enabled: !!id && !!session?.user.id,
        staleTime: 1000 * 60 * 60, // 1 minute
      },
    ),
  );

  const { latestDraft, isGroupThread, finalData, latestMessage } = useMemo(() => {
    if (!threadQuery.data) {
      return {
        latestDraft: undefined,
        isGroupThread: false,
        finalData: undefined,
        latestMessage: undefined,
      };
    }

    const latestDraft = threadQuery.data.latest?.id
      ? threadQuery.data.messages.findLast((e) => e.isDraft)
      : undefined;

    const isGroupThread = threadQuery.data.latest?.id
      ? (() => {
          const totalRecipients = [
            ...(threadQuery.data.latest.to || []),
            ...(threadQuery.data.latest.cc || []),
            ...(threadQuery.data.latest.bcc || []),
          ].length;
          return totalRecipients > 1;
        })()
      : false;

    const nonDraftMessages = threadQuery.data.messages.filter((e) => !e.isDraft);
    const latestMessage = nonDraftMessages[nonDraftMessages.length - 1];

    const finalData: IGetThreadResponse = {
      ...threadQuery.data,
      messages: nonDraftMessages,
    };

    return { latestDraft, isGroupThread, finalData, latestMessage };
  }, [threadQuery.data]);

  const { mutateAsync: processEmailContent } = useMutation(
    trpc.mail.processEmailContent.mutationOptions(),
  );

  // Extract image loading condition to avoid duplication
  const shouldLoadImages = useMemo(() => {
    if (!settings?.settings || !latestMessage?.sender?.email) return false;
    
    return settings.settings.externalImages ||
      settings.settings.trustedSenders?.includes(latestMessage.sender.email) ||
      false;
  }, [settings?.settings, latestMessage?.sender?.email]);

  // Prefetch query - intentionally unused, just for caching
  useQuery({
    queryKey: [
      'email-content',
      latestMessage?.id,
      shouldLoadImages,
      systemTheme,
    ],
    queryFn: async () => {
      if (!latestMessage?.decodedBody || !settings?.settings) return null;

      const userTheme =
        settings.settings.colorTheme === 'system' ? systemTheme : settings.settings.colorTheme;
      const theme = userTheme === 'dark' ? 'dark' : 'light';

      const result = await processEmailContent({
        html: latestMessage.decodedBody,
        shouldLoadImages,
        theme,
      });

      return {
        html: result.processedHtml,
        hasBlockedImages: result.hasBlockedImages,
      };
    },
    enabled: !!latestMessage?.decodedBody && !!settings?.settings,
    staleTime: 30 * 60 * 1000, // 30 minutes
    gcTime: 60 * 60 * 1000, // 1 hour
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  return { ...threadQuery, data: finalData, isGroupThread, latestDraft };
};
