import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, MessageSquareReply } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useQueryState } from 'nuqs';

import { Button } from '@/components/ui/button';
import { SidebarToggle } from '@/components/ui/sidebar-toggle';
import { ThreadDemo } from '@/components/mail/thread-display';
import ReplyCompose from '@/components/mail/reply-composer';
import { useConnections } from '@/hooks/use-connections';
import { useThread } from '@/hooks/use-threads';
import { useTRPC } from '@/providers/query-provider';

export function FocusReply() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const queue = useQuery(
    trpc.mailboxWorkflows.focus.list.queryOptions(undefined, { refetchInterval: 15_000 }),
  );
  const remove = useMutation(trpc.mailboxWorkflows.focus.remove.mutationOptions());
  const { data: connectionData } = useConnections();
  const [threadId, setThreadId] = useQueryState('threadId');
  const [connectionId, setConnectionId] = useQueryState('connectionId');
  const [mode, setMode] = useQueryState('mode');
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const threads = useMemo(() => queue.data?.threads ?? [], [queue.data?.threads]);
  const activeIndex = useMemo(() => {
    const index = threads.findIndex(
      (thread) => thread.threadId === threadId && thread.connectionId === connectionId,
    );
    return index >= 0 ? index : 0;
  }, [threads, threadId, connectionId]);
  const active = threads[activeIndex];
  const thread = useThread(active?.threadId ?? null, active?.connectionId);

  useEffect(() => {
    if (!active || (threadId === active.threadId && connectionId === active.connectionId)) return;
    void setThreadId(active.threadId);
    void setConnectionId(active.connectionId);
  }, [active, threadId, connectionId, setThreadId, setConnectionId]);

  const moveTo = (index: number) => {
    const target = threads[index];
    if (!target) return;
    void setMode(null);
    void setActiveReplyId(null);
    void setThreadId(target.threadId);
    void setConnectionId(target.connectionId);
  };

  const handleReply = () => {
    if (!thread.data?.latest) return;
    void setMode('reply');
    void setActiveReplyId(thread.data.latest.id);
  };

  const handleDone = async () => {
    if (!active) return;
    try {
      await remove.mutateAsync({ connectionId: active.connectionId, threadId: active.threadId });
      await queryClient.invalidateQueries({ queryKey: trpc.mailboxWorkflows.focus.list.queryKey() });
      const remaining = threads.filter(
        (item) =>
          item.threadId !== active.threadId || item.connectionId !== active.connectionId,
      );
      const next = remaining[Math.min(activeIndex, remaining.length - 1)];
      void setMode(null);
      void setActiveReplyId(null);
      void setThreadId(next?.threadId ?? null);
      void setConnectionId(next?.connectionId ?? null);
      toast.success('Removed from Focus & Reply');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to finish thread');
    }
  };

  const account = connectionData?.connections.find(
    (connection) => connection.id === active?.connectionId,
  );

  if (queue.isLoading) {
    return (
      <main className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <SidebarToggle className="h-8 w-8 md:hidden" />
          <h1 className="font-semibold">Focus & Reply</h1>
        </header>
        <p className="text-muted-foreground p-10 text-center text-sm">Loading Focus & Reply…</p>
      </main>
    );
  }

  if (queue.isError) {
    return (
      <main className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <SidebarToggle className="h-8 w-8 md:hidden" />
          <h1 className="font-semibold">Focus & Reply</h1>
        </header>
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div>
            <p className="font-medium">Focus & Reply could not be loaded</p>
            <p className="text-muted-foreground mt-1 text-sm">
              {queue.error instanceof Error ? queue.error.message : 'Try the request again.'}
            </p>
            <Button className="mt-4" variant="outline" onClick={() => queue.refetch()}>
              Try again
            </Button>
          </div>
        </div>
      </main>
    );
  }

  if (!active) {
    return (
      <main className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <SidebarToggle className="h-8 w-8 md:hidden" />
          <h1 className="font-semibold">Focus & Reply</h1>
        </header>
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div>
            <Check className="text-muted-foreground mx-auto mb-3 h-7 w-7" />
            <h1 className="text-xl font-semibold">Focus queue complete</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Add threads from their action menu when you want to reply in one session.
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <SidebarToggle className="h-8 w-8 md:hidden" />
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground text-xs">
            Focus & Reply · {activeIndex + 1} of {threads.length} · {account?.email ?? active.connectionId}
          </p>
          <h1 className="truncate text-base font-semibold">
            {thread.data?.latest?.subject || active.subject || 'No subject'}
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            disabled={activeIndex === 0}
            onClick={() => moveTo(activeIndex - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Previous</span>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={activeIndex >= threads.length - 1}
            onClick={() => moveTo(activeIndex + 1)}
          >
            <ChevronRight className="h-4 w-4" />
            <span className="sr-only">Next</span>
          </Button>
          <Button variant="outline" onClick={handleReply} disabled={!thread.data?.latest}>
            <MessageSquareReply className="mr-1.5 h-4 w-4" /> Reply
          </Button>
          <Button onClick={handleDone} disabled={remove.isPending}>
            <Check className="mr-1.5 h-4 w-4" /> Done
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {thread.isLoading ? (
          <p className="text-muted-foreground p-10 text-center text-sm">Loading thread…</p>
        ) : thread.isError ? (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <div>
              <p className="font-medium">This thread could not be loaded</p>
              <p className="text-muted-foreground mt-1 text-sm">
                {thread.error instanceof Error ? thread.error.message : 'Try the request again.'}
              </p>
              <Button className="mt-4" variant="outline" onClick={() => thread.refetch()}>
                Try again
              </Button>
            </div>
          </div>
        ) : thread.data ? (
          <div className="mx-auto flex h-full max-w-4xl flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">
              <ThreadDemo messages={thread.data.messages} fillContainer />
            </div>
            {mode === 'reply' && thread.data.latest ? (
              <div className="border-t p-4">
                <ReplyCompose messageId={thread.data.latest.id} />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground p-10 text-center text-sm">This thread could not be loaded.</p>
        )}
      </div>
    </main>
  );
}
