import {
  Archive2,
  GroupPeople,
  Important,
  Star2,
  Trash,
  PencilCompose,
} from '../icons/icons';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  useState,
} from 'react';
import { useOptimisticThreadState } from '@/components/mail/optimistic-thread-state';
import { focusedIndexAtom, useMailNavigation } from '@/hooks/use-mail-navigation';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type UseQueryResult } from '@tanstack/react-query';
import type { MailSelectMode, ParsedMessage, ThreadProps } from '@/types';
import type { ParsedDraft } from '../../../server/src/lib/driver/types';
import { ThreadContextMenu } from '@/components/context/thread-context';
import { useOptimisticActions } from '@/hooks/use-optimistic-actions';
import { useMail, type Config } from '@/components/mail/use-mail';
import { type ThreadDestination } from '@/lib/thread-actions';
import { useThread, useThreads } from '@/hooks/use-threads';
import { useSearchValue } from '@/hooks/use-search-value';
import { EmptyStateIcon } from '../icons/empty-state-svg';
import { highlightText } from '@/lib/email-utils.client';
import { getAccountColor, parseThreadKey, threadKey } from '@/lib/thread-ref';
import { cn, FOLDERS, formatDate } from '@/lib/utils';
import { useThreadLabels } from '@/hooks/use-labels';
import { useSettings } from '@/hooks/use-settings';
import { useKeyState } from '@/hooks/use-hot-key';
import { VList, type VListHandle } from 'virtua';
import { RenderLabels } from './render-labels';
import { Badge } from '@/components/ui/badge';
import { useDraft } from '@/hooks/use-drafts';
import { Check, Star } from 'lucide-react';
import { Skeleton } from '../ui/skeleton';
import { m } from '@/paraglide/messages';
import { useParams } from 'react-router';
import { Button } from '../ui/button';
import { useQueryState } from 'nuqs';
import { useAtom } from 'jotai';

const getListItemKey = (item: { id: string; connectionId?: string; key?: string }) =>
  item.key ?? threadKey(item.id, item.connectionId);
const LOADING_ROWS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
const EMPTY_ACCOUNT_COLORS = {};

const Thread = memo(
  function Thread({
    message,
    onClick,
    isKeyboardFocused,
    index,
    accountColors,
  }: ThreadProps & { index?: number; accountColors: Record<string, string> }) {
    const [searchValue] = useSearchValue();
    const { folder } = useParams<{ folder: string }>();
    const [, threads] = useThreads();
    const [threadId] = useQueryState('threadId');
    const { data: getThreadData, isGroupThread, latestDraft } = useThread(
      message.id,
      message.connectionId,
    );
    const [id, setThreadId] = useQueryState('threadId');
    const [openConnectionId, setOpenConnectionId] = useQueryState('connectionId');
    const [focusedIndex, setFocusedIndex] = useAtom(focusedIndexAtom);

    const { latestMessage, idToUse, cleanName } = useMemo(() => {
      const latestMessage = getThreadData?.latest;
      const idToUse = latestMessage?.threadId ?? latestMessage?.id;
      const cleanName = latestMessage?.sender?.name
        ? latestMessage.sender.name.trim().replace(/^['"]|['"]$/g, '')
        : '';

      return { latestMessage, idToUse, cleanName };
    }, [getThreadData?.latest]);

    const keyToUse = message.key ?? threadKey(idToUse ?? message.id, message.connectionId);
    const optimisticState = useOptimisticThreadState(keyToUse);

    const { displayStarred, displayImportant, displayUnread, optimisticLabels, emailContent } =
      useMemo(() => {
        const emailContent = getThreadData?.latest?.body;
        const displayStarred =
          optimisticState.optimisticStarred !== null
            ? optimisticState.optimisticStarred
            : (getThreadData?.latest?.tags?.some((tag) => tag.name === 'STARRED') ?? false);

        const displayImportant =
          optimisticState.optimisticImportant !== null
            ? optimisticState.optimisticImportant
            : (getThreadData?.latest?.tags?.some((tag) => tag.name === 'IMPORTANT') ?? false);

        const displayUnread =
          optimisticState.optimisticRead !== null
            ? !optimisticState.optimisticRead
            : (getThreadData?.hasUnread ?? false);

        let labels: { id: string; name: string }[] = [];
        if (getThreadData?.labels) {
          labels = [...getThreadData.labels];
          const hasStarredLabel = labels.some((label) => label.name === 'STARRED');

          if (optimisticState.optimisticStarred !== null) {
            if (optimisticState.optimisticStarred && !hasStarredLabel) {
              labels.push({ id: 'starred-optimistic', name: 'STARRED' });
            } else if (!optimisticState.optimisticStarred && hasStarredLabel) {
              labels = labels.filter((label) => label.name !== 'STARRED');
            }
          }

          if (optimisticState.optimisticLabels) {
            labels = labels.filter(
              (label) => !optimisticState.optimisticLabels.removedLabelIds.includes(label.id),
            );

            optimisticState.optimisticLabels.addedLabelIds.forEach((labelId) => {
              if (!labels.some((label) => label.id === labelId)) {
                labels.push({ id: labelId, name: labelId });
              }
            });
          }
        }

        return {
          displayStarred,
          displayImportant,
          displayUnread,
          optimisticLabels: labels,
          emailContent,
        };
      }, [
        optimisticState.optimisticStarred,
        optimisticState.optimisticImportant,
        optimisticState.optimisticRead,
        getThreadData?.latest?.tags,
        getThreadData?.hasUnread,
        getThreadData?.labels,
        optimisticState.optimisticLabels,
      ]);

    const { optimisticToggleStar, optimisticToggleImportant, optimisticMoveThreadsTo } =
      useOptimisticActions();

    const handleToggleStar = useCallback(
      async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!getThreadData || !idToUse) return;

        const newStarredState = !displayStarred;
        optimisticToggleStar([keyToUse], newStarredState);
      },
      [getThreadData, idToUse, keyToUse, displayStarred, optimisticToggleStar],
    );

    const handleToggleImportant = useCallback(
      async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!getThreadData || !idToUse) return;

        const newImportantState = !displayImportant;
        optimisticToggleImportant([keyToUse], newImportantState);
      },
      [getThreadData, idToUse, keyToUse, displayImportant, optimisticToggleImportant],
    );

    const handleNext = useCallback(
      (id: string) => {
        if (!id || !threads.length || focusedIndex === null) return setThreadId(null);
        if (focusedIndex < threads.length - 1) {
          const nextThread = threads[focusedIndex];
          if (nextThread) {
            setThreadId(nextThread.id);
            setOpenConnectionId(nextThread.connectionId ?? null);
            // Don't clear activeReplyId - let ThreadDisplay handle Reply All auto-opening
            setFocusedIndex(focusedIndex);
          }
        }
      },
      [threads, id, focusedIndex, setThreadId, setOpenConnectionId, setFocusedIndex],
    );

    const moveThreadTo = useCallback(
      async (destination: ThreadDestination) => {
        if (!idToUse) return;
        handleNext(idToUse);
        optimisticMoveThreadsTo([keyToUse], folder ?? '', destination);
      },
      [idToUse, keyToUse, folder, optimisticMoveThreadsTo, handleNext],
    );

    const { labels: threadLabels } = useThreadLabels(
      optimisticLabels ? optimisticLabels.map((l) => l.id) : [],
      message.connectionId,
    );

    const [mailState, setMail] = useMail();
    const { isMailSelected, isMailBulkSelected } = useMemo(() => {
      const isSelected =
        !threadId || !idToUse
          ? false
          : (idToUse === threadId &&
              (!message.connectionId || message.connectionId === openConnectionId)) ||
            keyToUse === mailState.selected;
      const isBulkSelected = mailState.bulkSelected.includes(keyToUse);

      return { isMailSelected: isSelected, isMailBulkSelected: isBulkSelected };
    }, [threadId, idToUse, message.connectionId, openConnectionId, keyToUse, mailState]);

    const handleToggleBulkSelection = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        setMail((prev: Config) => ({
          ...prev,
          bulkSelected: prev.bulkSelected.includes(keyToUse)
            ? prev.bulkSelected.filter((id) => id !== keyToUse)
            : [...prev.bulkSelected, keyToUse],
        }));
      },
      [keyToUse, setMail],
    );

    const { isFolderInbox, isFolderSpam, isFolderSent, isFolderBin } = useMemo(
      () => ({
        isFolderInbox: folder === FOLDERS.INBOX || folder === 'unified' || !folder,
        isFolderSpam: folder === FOLDERS.SPAM,
        isFolderSent: folder === FOLDERS.SENT,
        isFolderBin: folder === FOLDERS.BIN,
      }),
      [folder],
    );

    // Check if thread has a draft
    const hasDraft = useMemo(() => {
      return !!latestDraft;
    }, [latestDraft]);

    const content = useMemo(() => {
      if (!latestMessage || !getThreadData) return null;

      const sender = isFolderSent
        ? latestMessage.to.map(({ email }) => email).join(', ')
        : cleanName || latestMessage.sender.email;

      return (
        <div
          className="h-11 select-none border-b border-border/70"
          onClick={onClick ? onClick(latestMessage) : undefined}
        >
          <div
            data-thread-id={keyToUse}
            key={keyToUse}
            className={cn(
              'group relative flex h-11 w-full cursor-pointer items-center gap-1 px-2 text-left text-sm transition-colors',
              displayUnread ? 'bg-background' : 'bg-muted/25 text-foreground/80',
              'hover:bg-offsetLight dark:hover:bg-primary/5',
              (isMailSelected || isMailBulkSelected || isKeyboardFocused) && 'bg-primary/10',
              isKeyboardFocused && 'ring-primary/50 ring-1 ring-inset',
            )}
          >
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10"
              aria-label={isMailBulkSelected ? 'Deselect conversation' : 'Select conversation'}
              aria-pressed={isMailBulkSelected}
              onClick={handleToggleBulkSelection}
            >
              {isMailBulkSelected ? (
                <span className="flex h-4 w-4 items-center justify-center rounded-sm bg-[#006FFE]">
                  <Check className="h-3 w-3 text-white" />
                </span>
              ) : (
                <span className="border-muted-foreground/60 h-4 w-4 rounded-sm border" />
              )}
            </button>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 [&_svg]:size-4"
                  onClick={handleToggleStar}
                >
                  <Star2
                    className={cn(
                      displayStarred
                        ? 'fill-yellow-400 stroke-yellow-400'
                        : 'fill-transparent stroke-[#9D9D9D] dark:stroke-[#9D9D9D]',
                    )}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side={index === 0 ? 'bottom' : 'top'} className="p-1 text-xs">
                {displayStarred
                  ? m['common.threadDisplay.unstar']()
                  : m['common.threadDisplay.star']()}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'hidden h-7 w-7 shrink-0 sm:inline-flex [&_svg]:size-4',
                    displayImportant && 'hover:bg-orange-200/70 dark:hover:bg-orange-800/40',
                  )}
                  onClick={handleToggleImportant}
                >
                  <Important
                    className={cn(
                      displayImportant
                        ? 'fill-amber-400 stroke-amber-500 text-amber-950'
                        : 'fill-transparent stroke-[#9D9D9D] text-[#9D9D9D]',
                    )}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side={index === 0 ? 'bottom' : 'top'} className="p-1 text-xs">
                {m['common.mail.toggleImportant']()}
              </TooltipContent>
            </Tooltip>

            <div className="flex w-28 shrink-0 items-center gap-1.5 sm:w-32 xl:w-40">
              {message.connectionId && message.account ? (
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: getAccountColor(message.connectionId, accountColors) }}
                  aria-label={'Account ' + message.account.email}
                  title={message.account.email}
                />
              ) : null}
              {isGroupThread ? <GroupPeople className="h-3.5 w-3.5 shrink-0 opacity-60" /> : null}
              <span
                className={cn('min-w-0 truncate', displayUnread ? 'font-semibold' : 'font-medium')}
                title={sender}
              >
                {highlightText(sender, searchValue.highlight)}
              </span>
              {getThreadData.totalReplies > 1 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0 text-xs opacity-60">
                      [{getThreadData.totalReplies}]
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="p-1 text-xs">
                    {m['common.mail.replies']({ count: getThreadData.totalReplies })}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {hasDraft ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex shrink-0 items-center">
                      <PencilCompose className="h-3 w-3 fill-blue-500 dark:fill-blue-400" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="p-1 text-xs">Draft</TooltipContent>
                </Tooltip>
              ) : null}
            </div>

            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <span
                className={cn(
                  'min-w-0 shrink truncate',
                  displayUnread ? 'font-semibold' : 'font-normal',
                )}
              >
                {highlightText(latestMessage.subject, searchValue.highlight)}
              </span>
              {emailContent ? (
                <>
                  <span className="text-muted-foreground shrink-0">-</span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate">
                    {highlightText(emailContent, searchValue.highlight)}
                  </span>
                </>
              ) : null}
              {threadLabels.length ? (
                <div className="hidden max-w-36 shrink-0 overflow-hidden lg:block">
                  <RenderLabels labels={threadLabels} />
                </div>
              ) : null}
            </div>

            {latestMessage.receivedOn ? (
              <p
                className={cn(
                  'text-muted-foreground shrink-0 whitespace-nowrap pr-1 text-xs font-normal transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 dark:text-[#8C8C8C]',
                  isMailSelected && 'text-foreground',
                )}
              >
                {formatDate(latestMessage.receivedOn.split('.')[0] || '')}
              </p>
            ) : null}

            <div className="bg-background/95 pointer-events-none absolute inset-y-0 right-2 z-20 flex items-center gap-1 pl-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 [&_svg]:size-4"
                    onClick={(event) => {
                      event.stopPropagation();
                      moveThreadTo('archive');
                    }}
                  >
                    <Archive2 className="fill-[#9D9D9D]" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side={index === 0 ? 'bottom' : 'top'} className="p-1 text-xs">
                  {m['common.threadDisplay.archive']()}
                </TooltipContent>
              </Tooltip>
              {!isFolderBin ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 hover:bg-[#FDE4E9] dark:hover:bg-[#411D23] [&_svg]:size-4"
                      onClick={(event) => {
                        event.stopPropagation();
                        moveThreadTo('bin');
                      }}
                    >
                      <Trash className="fill-[#F43F5E]" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side={index === 0 ? 'bottom' : 'top'} className="p-1 text-xs">
                    {m['common.actions.Bin']()}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
        </div>
      );
    }, [
      latestMessage,
      getThreadData,
      keyToUse,
      onClick,
      displayUnread,
      displayStarred,
      displayImportant,
      isMailSelected,
      isMailBulkSelected,
      isKeyboardFocused,
      handleToggleBulkSelection,
      handleToggleStar,
      handleToggleImportant,
      message.connectionId,
      message.account,
      accountColors,
      isGroupThread,
      isFolderSent,
      isFolderBin,
      cleanName,
      searchValue.highlight,
      hasDraft,
      emailContent,
      threadLabels,
      index,
      moveThreadTo,
    ]);

    if (optimisticState.shouldHide) return null;

    if (!latestMessage || !getThreadData || !idToUse) {
      return (
        <div className="flex h-11 select-none items-center gap-1 border-b border-border/70 px-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center">
            <Skeleton className="bg-muted h-4 w-4 rounded" />
          </div>
          <div className="h-7 w-7 shrink-0" />
          <div className="hidden h-7 w-7 shrink-0 sm:block" />
          <Skeleton className="bg-muted h-4 w-28 shrink-0 rounded sm:w-32 xl:w-40" />
          <Skeleton className="bg-muted h-4 min-w-0 flex-1 rounded" />
          <Skeleton className="bg-muted h-3 w-12 shrink-0 rounded" />
        </div>
      );
    }

    return (
      <ThreadContextMenu
        threadId={idToUse}
        connectionId={message.connectionId}
        threadKey={keyToUse}
        isInbox={isFolderInbox}
        isSpam={isFolderSpam}
        isSent={isFolderSent}
        isBin={isFolderBin}
      >
        {content}
      </ThreadContextMenu>
    );
  },
  (prev, next) => {
    const isSameMessage =
      getListItemKey(prev.message) === getListItemKey(next.message) &&
      prev.isKeyboardFocused === next.isKeyboardFocused &&
      prev.index === next.index &&
      prev.accountColors === next.accountColors &&
      Object.is(prev.onClick, next.onClick);
    return isSameMessage;
  },
);

const Draft = memo(({ message, index }: { message: { id: string }; index: number }) => {
  const draftQuery = useDraft(message.id) as UseQueryResult<ParsedDraft>;
  const draft = draftQuery.data;
  const [, setComposeOpen] = useQueryState('isComposeOpen');
  const [, setDraftId] = useQueryState('draftId');
  const { optimisticDeleteDraft } = useOptimisticActions();
  const optimisticState = useOptimisticThreadState(message.id);

  const handleMailClick = useCallback(() => {
    setComposeOpen('true');
    setDraftId(message.id);
  }, [message.id, setComposeOpen, setDraftId]);

  const handleDeleteDraft = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      optimisticDeleteDraft(message.id);
    },
    [message.id, optimisticDeleteDraft],
  );

  if (optimisticState.shouldHide) return null;

  if (!draft) {
    return (
      <div className="flex h-11 select-none items-center gap-1 border-b border-border/70 px-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <Skeleton className="bg-muted h-4 w-4 rounded" />
        </div>
        <div className="h-7 w-7 shrink-0" />
        <div className="hidden h-7 w-7 shrink-0 sm:block" />
        <Skeleton className="bg-muted h-4 w-28 shrink-0 rounded sm:w-32 xl:w-40" />
        <Skeleton className="bg-muted h-4 min-w-0 flex-1 rounded" />
        <Skeleton className="bg-muted h-3 w-12 shrink-0 rounded" />
      </div>
    );
  }

  return (
    <div
      className="h-11 select-none border-b border-border/70"
      onClick={handleMailClick}
    >
      <div className="hover:bg-offsetLight dark:hover:bg-primary/5 group relative flex h-11 w-full cursor-pointer items-center gap-1 px-2 text-left text-sm transition-colors">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <PencilCompose className="h-4 w-4 fill-blue-500 dark:fill-blue-400" />
        </div>
        <div className="h-7 w-7 shrink-0" />
        <div className="hidden h-7 w-7 shrink-0 sm:block" />
        <span className="w-28 shrink-0 truncate font-medium sm:w-32 xl:w-40">
          {cleanNameDisplay(draft.to?.[0] || 'No Recipient') || ''}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate">
          {draft.subject}
        </span>
        {draft.rawMessage?.internalDate ? (
          <p className="text-muted-foreground shrink-0 whitespace-nowrap pr-1 text-xs font-normal transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 dark:text-[#8C8C8C]">
            {formatDate(Number(draft.rawMessage.internalDate))}
          </p>
        ) : null}
        <div
          className="bg-background/95 pointer-events-none absolute inset-y-0 right-2 z-20 flex items-center pl-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          aria-busy={optimisticState.isRemoving}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 hover:bg-[#FDE4E9] dark:hover:bg-[#411D23] [&_svg]:size-4"
                aria-label="Delete draft"
                disabled={optimisticState.isRemoving}
                onClick={handleDeleteDraft}
              >
                <Trash className="fill-[#F43F5E]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side={index === 0 ? 'bottom' : 'top'} className="p-1 text-xs">
              {m['common.actions.Bin']()}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
});

Draft.displayName = 'Draft';

export const MailList = memo(
  function MailList() {
    const { folder } = useParams<{ folder: string }>();
    const { data: settingsData } = useSettings();
    const [, setThreadId] = useQueryState('threadId');
    const [, setConnectionId] = useQueryState('connectionId');
    const [, setDraftId] = useQueryState('draftId');
    const [searchValue, setSearchValue] = useSearchValue();
    const [anchorIndex, setAnchorIndex] = useState<number | null>(null);

    useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setAnchorIndex(null);
        }
      };

      window.addEventListener('keydown', handleKeyDown);

      return () => {
        window.removeEventListener('keydown', handleKeyDown);
      };
    }, [setAnchorIndex]);

    const [
      {
        data,
        dataUpdatedAt,
        refetch,
        isLoading,
        isFetching,
        isFetchingNextPage,
        hasNextPage,
        isError,
      },
      items,
      ,
      loadMore,
      partialFailures,
    ] = useThreads();
    const itemsRef = useRef(items);
    const parentRef = useRef<HTMLDivElement>(null);
    const vListRef = useRef<VListHandle>(null);
    const underfillRequestRef = useRef('');

    useEffect(() => {
      itemsRef.current = items;
    }, [items]);

    // Add event listener for refresh
    useEffect(() => {
      const handleRefresh = () => {
        void refetch();
      };

      window.addEventListener('refreshMailList', handleRefresh);
      return () => window.removeEventListener('refreshMailList', handleRefresh);
    }, [refetch]);

    const navigationItems = useMemo(
      () => items.map((item) => ({ id: getListItemKey(item) })),
      [items],
    );

    const handleNavigateToThread = useCallback(
      (key: string | null) => {
        if (!key) {
          setThreadId(null);
          setConnectionId(null);
          return;
        }
        const ref = parseThreadKey(key);
        setThreadId(ref.threadId);
        setConnectionId(ref.connectionId ?? null);
        return;
      },
      [setThreadId, setConnectionId],
    );

    const { focusedIndex, handleMouseEnter, keyboardActive } = useMailNavigation({
      items: navigationItems,
      containerRef: parentRef,
      onNavigate: handleNavigateToThread,
    });

    const isKeyPressed = useKeyState();

    const getSelectMode = useCallback((): MailSelectMode => {
      const isAltPressed =
        isKeyPressed('Alt') || isKeyPressed('AltLeft') || isKeyPressed('AltRight');
      const isShiftPressed =
        isKeyPressed('Shift') || isKeyPressed('ShiftLeft') || isKeyPressed('ShiftRight');
      const isCtrlPressed = isKeyPressed('Control') || isKeyPressed('Meta');

      if (isShiftPressed && !isCtrlPressed) {
        return 'range';
      }
      if (isCtrlPressed) {
        return 'mass';
      }
      if (isAltPressed && isShiftPressed) {
        console.log('Select All Below mode activated'); // Debug log
        return 'selectAllBelow';
      }
      return 'single';
    }, [isKeyPressed]);

    const [, setActiveReplyId] = useQueryState('activeReplyId');
    const [, setMail] = useMail();

    const handleSelectMail = useCallback(
      (message: ParsedMessage) => {
        const itemId = threadKey(message.threadId ?? message.id, message.connectionId);
        const currentMode = getSelectMode();
        console.log('Selection mode:', currentMode, 'for item:', itemId);

        setMail((prevMail) => {
          const mail = prevMail;
          const clickedIndex = itemsRef.current.findIndex(
            (item) => getListItemKey(item) === itemId,
          );
          if (clickedIndex === -1) return mail;

          switch (currentMode) {
            case 'mass': {
              const newSelected = mail.bulkSelected.includes(itemId)
                ? mail.bulkSelected.filter((id) => id !== itemId)
                : [...mail.bulkSelected, itemId];
              console.log('Mass selection mode - selected items:', newSelected.length);
              return { ...mail, bulkSelected: newSelected };
            }
            case 'selectAllBelow': {
              const clickedIndex = itemsRef.current.findIndex(
                (item) => getListItemKey(item) === itemId,
              );
              console.log(
                'SelectAllBelow - clicked index:',
                clickedIndex,
                'total items:',
                itemsRef.current.length,
              );

              if (clickedIndex !== -1) {
                const itemsBelow = itemsRef.current.slice(clickedIndex);
                const idsBelow = itemsBelow.map(getListItemKey);
                console.log('Selecting all items below - count:', idsBelow.length);
                return { ...mail, bulkSelected: idsBelow };
              }
              console.log('Item not found in list, selecting just this item');
              return { ...mail, bulkSelected: [itemId] };
            }
            case 'range': {
              console.log('Range selection mode');
              if (anchorIndex === null) {
                return { ...mail, bulkSelected: [itemId] };
              }
              const start = Math.min(anchorIndex, clickedIndex);
              const end = Math.max(anchorIndex, clickedIndex);
              const rangeIds = itemsRef.current.slice(start, end + 1).map(getListItemKey);
              const newSelected = [...new Set([...mail.bulkSelected, ...rangeIds])];

              return { ...mail, bulkSelected: newSelected };
            }
            default: {
              console.log('Single selection mode');
              return { ...mail, bulkSelected: [itemId] };
            }
          }
        });
      },
      [getSelectMode, setMail, anchorIndex],
    );

    const [, setFocusedIndex] = useAtom(focusedIndexAtom);

    const { optimisticMarkAsRead } = useOptimisticActions();
    const handleMailClick = useCallback(
      (message: ParsedMessage) => async () => {
        const mode = getSelectMode();
        const autoRead = settingsData?.settings?.autoRead ?? true;
        console.log('Mail click with mode:', mode);

        if (mode !== 'single') {
          const messageThreadId = threadKey(
            message.threadId ?? message.id,
            message.connectionId,
          );
          const clickedIndex = itemsRef.current.findIndex(
            (item) => getListItemKey(item) === messageThreadId,
          );
          if (clickedIndex !== -1 && mode !== 'range') {
            setAnchorIndex(clickedIndex);
          }
          return handleSelectMail(message);
        }

        const messageThreadId = message.threadId ?? message.id;
        const messageKey = threadKey(messageThreadId, message.connectionId);
        handleMouseEnter(messageKey);

        const clickedIndex = itemsRef.current.findIndex(
          (item) => getListItemKey(item) === messageKey,
        );
        setFocusedIndex(clickedIndex);
        if (message.unread && autoRead) optimisticMarkAsRead([messageKey], true);
        setThreadId(messageThreadId);
        setConnectionId(message.connectionId ?? null);
        setDraftId(null);
        // Don't clear activeReplyId - let ThreadDisplay handle Reply All auto-opening
      },
      [
        getSelectMode,
        handleSelectMail,
        handleMouseEnter,
        setFocusedIndex,
        optimisticMarkAsRead,
        setThreadId,
        setConnectionId,
        setDraftId,
        settingsData,
        setActiveReplyId,
      ],
    );

    const isFiltering = searchValue.value.trim().length > 0;

    useEffect(() => {
      if (isFiltering && !isLoading) {
        setSearchValue({
          ...searchValue,
          isLoading: false,
        });
      }
    }, [isLoading, isFiltering, setSearchValue]);

    const clearFilters = () => {
      setSearchValue({
        value: '',
        highlight: '',
        folder: '',
      });
    };

    const filteredItems = useMemo(() => items.filter((item) => item.id), [items]);
    const pageCount = data?.pages.length ?? 0;

    const loadMoreIfUnderfilled = useCallback(() => {
      const list = vListRef.current;
      if (
        isLoading ||
        isFetching ||
        isFetchingNextPage ||
        !hasNextPage ||
        !list ||
        list.viewportSize <= 0 ||
        list.scrollSize > list.viewportSize + 1
      ) {
        return;
      }

      const requestKey = `${dataUpdatedAt}:${pageCount}:${filteredItems.length}`;
      if (underfillRequestRef.current === requestKey) return;
      underfillRequestRef.current = requestKey;
      void loadMore();
    }, [
      dataUpdatedAt,
      filteredItems.length,
      hasNextPage,
      isFetching,
      isFetchingNextPage,
      isLoading,
      loadMore,
      pageCount,
    ]);

    useEffect(() => {
      const frame = requestAnimationFrame(loadMoreIfUnderfilled);
      const listContainer = parentRef.current?.querySelector('#mail-list-scroll');
      if (!listContainer || typeof ResizeObserver === 'undefined') {
        return () => cancelAnimationFrame(frame);
      }

      const observer = new ResizeObserver(loadMoreIfUnderfilled);
      observer.observe(listContainer);
      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
      };
    }, [loadMoreIfUnderfilled]);

    const accountColors = settingsData?.settings.accountColors ?? EMPTY_ACCOUNT_COLORS;

    const vListRenderer = useCallback(
      (index: number) => {
        const item = filteredItems[index];
        if (!item) return <></>;
        if (folder === FOLDERS.DRAFT) {
          return <Draft key={getListItemKey(item)} message={item} index={index} />;
        }
        return (
          <Thread
            key={getListItemKey(item)}
            message={item}
            isKeyboardFocused={focusedIndex === index && keyboardActive}
            index={index}
            onClick={handleMailClick}
            accountColors={accountColors}
          />
        );
      },
      [accountColors, filteredItems, focusedIndex, folder, keyboardActive, handleMailClick],
    );

    return (
      <>
        <div
          ref={parentRef}
          className={cn(
            'hide-link-indicator flex h-full w-full flex-col',
            getSelectMode() === 'range' && 'select-none',
          )}
        >
          <>
            {partialFailures.length ? (
              <div className="mx-3 mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {partialFailures.map((failure) => failure.email).join(', ')} could not be loaded.
              </div>
            ) : null}
            {isLoading ? (
              <div className="w-full" aria-label="Loading conversations">
                {LOADING_ROWS.map((row) => (
                  <div key={row} className="border-border/70 flex h-11 items-center gap-3 border-b px-4">
                    <Skeleton className="h-4 w-4 rounded" />
                    <Skeleton className="h-4 w-4 rounded-full" />
                    <Skeleton className="h-3 w-28 rounded sm:w-36" />
                    <Skeleton className="h-3 min-w-0 flex-1 rounded" />
                    <Skeleton className="h-3 w-12 rounded" />
                  </div>
                ))}
              </div>
            ) : isError && items.length === 0 ? (
              <div className="flex h-48 w-full items-center justify-center px-6" role="alert">
                <div className="flex max-w-xs flex-col items-center gap-3 text-center">
                  <div>
                    <p className="text-sm font-medium">Couldn&apos;t load your mail</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Check your connection and try again.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isFetching}
                    onClick={() => void refetch()}
                  >
                    {isFetching ? 'Trying again…' : 'Try again'}
                  </Button>
                </div>
              </div>
            ) : !items || items.length === 0 ? (
              <div className="flex w-full items-center justify-center">
                <div className="flex flex-col items-center justify-center gap-2 text-center">
                  <EmptyStateIcon width={200} height={200} />
                  <div className="mt-5">
                    <p className="text-lg">It&apos;s empty here</p>
                    <p className="text-md text-muted-foreground dark:text-white/50">
                      Search for another email or{' '}
                      <button type="button" className="underline cursor-pointer" onClick={clearFilters}>
                        clear filters
                      </button>
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col" id="mail-list-scroll">
                <VList
                  ref={vListRef}
                  count={filteredItems.length}
                  overscan={5}
                  itemSize={44}
                  className="scrollbar-none flex-1 overflow-x-hidden"
                  onScroll={() => {
                    if (!vListRef.current) return;
                    const endIndex = vListRef.current.findEndIndex();
                    if (
                      // Load more when the final rows enter the viewport.
                      Math.abs(filteredItems.length - 1 - endIndex) < 7 &&
                      !isLoading &&
                      !isFetchingNextPage &&
                      hasNextPage
                    ) {
                      void loadMore();
                    }
                  }}
                >
                  {vListRenderer}
                </VList>
              </div>
            )}
          </>
        </div>
      </>
    );
  },
  () => true,
);

export const MailLabels = memo(
  function MailListLabels({ labels }: { labels: { id: string; name: string }[] }) {
    if (!labels?.length) return null;

    const visibleLabels = labels.filter(
      (label) => !['unread', 'inbox'].includes(label.name.toLowerCase()),
    );

    if (!visibleLabels.length) return null;

    return (
      <div className={cn('flex select-none items-center')}>
        {visibleLabels.map((label) => {
          const style = getDefaultBadgeStyle(label.name);
          if (label.name.toLowerCase() === 'notes') {
            return (
              <Tooltip key={label.id}>
                <TooltipTrigger asChild>
                  <Badge className="rounded-md bg-amber-100 p-1 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400">
                    {getLabelIcon(label.name)}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="hidden px-1 py-0 text-xs">
                  {m['common.notes.title']()}
                </TooltipContent>
              </Tooltip>
            );
          }

          // Skip rendering if style is "secondary" (default case)
          if (style === 'secondary') return null;
          const content = getLabelIcon(label.name);

          return content ? (
            <Badge key={label.id} className="rounded-md p-1" variant={style}>
              {content}
            </Badge>
          ) : null;
        })}
      </div>
    );
  },
  (prev, next) => {
    return JSON.stringify(prev.labels) === JSON.stringify(next.labels);
  },
);

function getLabelIcon(label: string) {
  const normalizedLabel = label.toLowerCase().replace(/^category_/i, '');

  switch (normalizedLabel) {
    case 'starred':
      return <Star className="h-[12px] w-[12px] fill-yellow-400 stroke-yellow-400" />;
    default:
      return null;
  }
}

function getDefaultBadgeStyle(label: string): ComponentProps<typeof Badge>['variant'] {
  const normalizedLabel = label.toLowerCase().replace(/^category_/i, '');

  switch (normalizedLabel) {
    case 'starred':
    case 'important':
      return 'important';
    case 'promotions':
      return 'promotions';
    case 'personal':
      return 'personal';
    case 'updates':
      return 'updates';
    case 'work':
      return 'default';
    case 'forums':
      return 'forums';
    case 'notes':
      return 'secondary';
    default:
      return 'secondary';
  }
}

// Helper function to clean name display
const cleanNameDisplay = (name?: string) => {
  if (!name) return '';
  const match = name.match(/^[^\p{L}\p{N}.]*(.*?)[^\p{L}\p{N}.]*$/u);
  return match ? match[1] : name;
};
