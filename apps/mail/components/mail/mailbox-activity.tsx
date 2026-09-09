import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CircleAlert, Clock3, RefreshCw, RotateCcw, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { SidebarToggle } from '@/components/ui/sidebar-toggle';
import { getAccountColor } from '@/lib/thread-ref';
import { useTRPC } from '@/providers/query-provider';

const formatTime = (value?: string | Date | number | null) =>
  value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : 'Never';

export function MailboxActivity() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const activity = useQuery(trpc.mailboxWorkflows.activity.list.queryOptions());
  const outbox = useQuery(trpc.mailboxWorkflows.activity.outbox.queryOptions());
  const forceSync = useMutation(trpc.mailboxWorkflows.activity.forceSync.mutationOptions());
  const retryOutbox = useMutation(trpc.mailboxWorkflows.activity.retryOutbox.mutationOptions());
  const cancelOutbox = useMutation(trpc.mailboxWorkflows.activity.cancelOutbox.mutationOptions());
  const [pendingId, setPendingId] = useState('');

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.mailboxWorkflows.activity.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.mailboxWorkflows.activity.outbox.queryKey() }),
    ]);

  const syncMailbox = async (connectionId: string) => {
    setPendingId(connectionId);
    try {
      await forceSync.mutateAsync({ connectionId });
      await refresh();
      toast.success('Mailbox synced');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Mailbox sync failed');
    } finally {
      setPendingId('');
    }
  };

  const retryMessage = async (messageId: string) => {
    setPendingId(messageId);
    try {
      await retryOutbox.mutateAsync({ messageId });
      await refresh();
      toast.success('Message queued again');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not retry message');
    } finally {
      setPendingId('');
    }
  };

  const cancelMessage = async (messageId: string) => {
    setPendingId(messageId);
    try {
      await cancelOutbox.mutateAsync({ messageId });
      await refresh();
      toast.success('Message cancelled');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not cancel message');
    } finally {
      setPendingId('');
    }
  };

  const hasError = activity.isError || outbox.isError;

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-y-auto p-5 md:p-8">
      <SidebarToggle className="mb-3 md:hidden" />
      <div className="border-b pb-6">
        <p className="text-muted-foreground mb-1 text-sm">Mailbox reliability</p>
        <h1 className="text-2xl font-semibold tracking-tight">Sync & activity</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
          Check every account, retry messages that could not send, and review recent Gmail actions.
        </p>
      </div>

      {hasError ? (
        <div className="bg-muted/20 mt-5 rounded-xl border border-dashed p-8 text-center">
          <CircleAlert className="text-muted-foreground mx-auto mb-3 h-6 w-6" />
          <p className="font-medium">Mailbox activity could not be loaded</p>
          <Button type="button" size="sm" variant="outline" className="mt-4" onClick={() => void refresh()}>
            <RefreshCw className="mr-1.5 h-4 w-4" /> Retry
          </Button>
        </div>
      ) : (
        <>
          <section className="mt-6">
            <div className="mb-3 flex items-center gap-2">
              <Activity className="h-4 w-4" />
              <h2 className="font-medium">Accounts</h2>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {activity.data?.mailboxes.map((mailbox) => {
                const status = mailbox.sync?.status ?? 'waiting';
                return (
                  <article key={mailbox.id} className="rounded-xl border p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 truncate font-medium">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: getAccountColor(mailbox.id) }}
                          />
                          {mailbox.email}
                        </p>
                        <p className="text-muted-foreground mt-2 text-xs">
                          Last synced: {formatTime(mailbox.sync?.lastSuccessAt)}
                        </p>
                        {mailbox.sync?.lastError ? (
                          <p className="mt-2 text-xs text-red-600">{mailbox.sync.lastError}</p>
                        ) : null}
                      </div>
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${
                          status === 'healthy'
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                            : status === 'error'
                              ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                              : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {status}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-4"
                      disabled={pendingId === mailbox.id}
                      onClick={() => void syncMailbox(mailbox.id)}
                    >
                      <RefreshCw className={`mr-1.5 h-4 w-4 ${pendingId === mailbox.id ? 'animate-spin' : ''}`} />
                      Sync now
                    </Button>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="mt-8">
            <div className="mb-3 flex items-center gap-2">
              <Send className="h-4 w-4" />
              <h2 className="font-medium">Outbox</h2>
            </div>
            {outbox.data?.messages.length ? (
              <div className="divide-y rounded-xl border">
                {outbox.data.messages.map((message) => (
                  <article key={message.messageId} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{message.subject || '(No subject)'}</p>
                      <p className="text-muted-foreground mt-1 truncate text-xs">
                        {message.fromEmail ?? message.accountEmail} to {message.to.join(', ') || 'unknown recipient'}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {message.status} · {formatTime(message.sendAt ?? message.createdAt)}
                      </p>
                      {message.error ? <p className="mt-1 text-xs text-red-600">{message.error}</p> : null}
                    </div>
                    <div className="flex gap-2">
                      {message.status === 'failed' ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pendingId === message.messageId}
                          onClick={() => void retryMessage(message.messageId)}
                        >
                          <RotateCcw className="mr-1.5 h-4 w-4" /> Retry
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pendingId === message.messageId}
                        onClick={() => void cancelMessage(message.messageId)}
                      >
                        <Trash2 className="mr-1.5 h-4 w-4" /> Cancel
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="bg-muted/20 rounded-xl border border-dashed p-8 text-center">
                <p className="font-medium">Outbox is clear</p>
                <p className="text-muted-foreground mt-1 text-sm">Queued and failed messages appear here.</p>
              </div>
            )}
          </section>

          <section className="mt-8 pb-8">
            <div className="mb-3 flex items-center gap-2">
              <Clock3 className="h-4 w-4" />
              <h2 className="font-medium">Recent actions</h2>
            </div>
            {activity.data?.actions.length ? (
              <div className="divide-y rounded-xl border">
                {activity.data.actions.map((action) => {
                  const account = activity.data.mailboxes.find(({ id }) => id === action.connectionId);
                  return (
                    <article key={action.id} className="flex items-center justify-between gap-4 p-3 text-sm">
                      <div className="min-w-0">
                        <p className="capitalize">{action.action}</p>
                        <p className="text-muted-foreground mt-0.5 truncate text-xs">
                          {account?.email ?? 'Varunsmail'}{action.detail ? ` · ${action.detail}` : ''}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className={action.status === 'failed' ? 'text-red-600' : 'text-muted-foreground'}>
                          {action.status}
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-xs">{formatTime(action.updatedAt)}</p>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
                Mailbox actions will appear here.
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
