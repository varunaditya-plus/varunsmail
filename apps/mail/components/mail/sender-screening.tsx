import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Ban, Check, RefreshCw, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { SidebarToggle } from '@/components/ui/sidebar-toggle';
import { Switch } from '@/components/ui/switch';
import { useConnections } from '@/hooks/use-connections';
import { useTRPC } from '@/providers/query-provider';

export function SenderScreening() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const connectionsQuery = useConnections();
  const connections = useMemo(
    () =>
      connectionsQuery.data?.connections.filter((connection) => connection.providerId === 'google') ?? [],
    [connectionsQuery.data?.connections],
  );
  const [connectionId, setConnectionId] = useState('');

  useEffect(() => {
    if (!connectionId && connections[0]?.id) setConnectionId(connections[0].id);
  }, [connectionId, connections]);

  const config = useQuery(
    trpc.mailboxWorkflows.screening.getConfig.queryOptions(
      { connectionId },
      { enabled: !!connectionId },
    ),
  );
  const queue = useQuery(
    trpc.mailboxWorkflows.screening.list.queryOptions(
      { connectionId },
      { enabled: !!connectionId && config.data?.enabled === true },
    ),
  );
  const setEnabled = useMutation(trpc.mailboxWorkflows.screening.setEnabled.mutationOptions());
  const decide = useMutation(trpc.mailboxWorkflows.screening.decide.mutationOptions());
  const isMutating = setEnabled.isPending || decide.isPending;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.mailboxWorkflows.screening.getConfig.queryKey({ connectionId }),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.mailboxWorkflows.screening.list.queryKey({ connectionId }),
      }),
      queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.pathKey() }),
    ]);
  };

  const handleEnabled = async (enabled: boolean) => {
    try {
      await setEnabled.mutateAsync({ connectionId, enabled });
      await refresh();
      toast.success(enabled ? 'New sender screening enabled' : 'New sender screening disabled');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update screening');
    }
  };

  const handleDecision = async (
    email: string,
    decision: 'allow' | 'archive' | 'block' | 'spam',
  ) => {
    try {
      await decide.mutateAsync({ connectionId, email, decision });
      await refresh();
      toast.success(
        decision === 'allow'
          ? 'Sender allowed'
          : decision === 'archive'
            ? 'Sender archived'
            : decision === 'block'
              ? 'Sender blocked'
              : 'Sender marked as spam',
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to screen sender');
    }
  };

  const retry = async () => {
    await Promise.all([
      connectionsQuery.refetch(),
      ...(connectionId ? [config.refetch(), queue.refetch()] : []),
    ]);
  };

  const selected = connections.find((connection) => connection.id === connectionId);
  const hasQueryError =
    connectionsQuery.isError || config.isError || (config.data?.enabled === true && queue.isError);
  const isRetrying = connectionsQuery.isFetching || config.isFetching || queue.isFetching;

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-y-auto p-5 md:p-8">
      <SidebarToggle className="mb-3 md:hidden" />
      <div className="flex flex-col gap-5 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-muted-foreground mb-1 text-sm">First-time senders</p>
          <h1 className="text-2xl font-semibold tracking-tight">Screening</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            New senders wait here until you allow, archive, block, or report them. Existing contacts
            from before screening was enabled stay trusted.
          </p>
        </div>
        <label className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
          <Switch
            checked={config.data?.enabled ?? false}
            disabled={!connectionId || config.isLoading || config.isError || isMutating}
            onCheckedChange={handleEnabled}
          />
          Screen new senders
        </label>
      </div>

      <div className="my-5 flex gap-2 overflow-x-auto pb-1">
        {connections.map((connection) => (
          <Button
            key={connection.id}
            type="button"
            size="sm"
            variant={connection.id === connectionId ? 'default' : 'outline'}
            className="shrink-0"
            disabled={isMutating}
            onClick={() => setConnectionId(connection.id)}
          >
            {connection.email}
          </Button>
        ))}
      </div>

      {connectionsQuery.isLoading || (!!connectionId && config.isLoading) ? (
        <p className="text-muted-foreground py-10 text-center text-sm">Loading screening…</p>
      ) : hasQueryError ? (
        <div className="bg-muted/20 rounded-xl border border-dashed p-8 text-center">
          <ShieldAlert className="text-muted-foreground mx-auto mb-3 h-6 w-6" />
          <p className="font-medium">Screening could not be loaded</p>
          <p className="text-muted-foreground mt-1 text-sm">Check the connection and try again.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-4"
            disabled={isRetrying}
            onClick={() => void retry()}
          >
            <RefreshCw className={`mr-1.5 h-4 w-4 ${isRetrying ? 'animate-spin' : ''}`} />
            Retry
          </Button>
        </div>
      ) : !connections.length ? (
        <div className="bg-muted/20 rounded-xl border border-dashed p-8 text-center">
          <ShieldAlert className="text-muted-foreground mx-auto mb-3 h-6 w-6" />
          <p className="font-medium">No Gmail accounts connected</p>
          <p className="text-muted-foreground mt-1 text-sm">Connect Gmail before enabling screening.</p>
        </div>
      ) : !config.data?.enabled ? (
        <div className="bg-muted/30 rounded-xl border border-dashed p-8 text-center">
          <ShieldAlert className="text-muted-foreground mx-auto mb-3 h-6 w-6" />
          <p className="font-medium">Screening is off for {selected?.email ?? 'this account'}</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Enable it above. Only senders first seen after that moment will enter this queue.
          </p>
        </div>
      ) : queue.isLoading ? (
        <p className="text-muted-foreground py-10 text-center text-sm">Loading screened senders…</p>
      ) : queue.data?.senders.length ? (
        <div className="grid gap-3">
          {queue.data.senders.map((sender) => (
            <article key={`${sender.connectionId}:${sender.email}`} className="rounded-xl border p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-medium">{sender.name || sender.email}</p>
                  {sender.name ? (
                    <p className="text-muted-foreground truncate text-sm">{sender.email}</p>
                  ) : null}
                  <p className="text-muted-foreground mt-1 text-xs">
                    {sender.threadIds.length} pending {sender.threadIds.length === 1 ? 'thread' : 'threads'}
                  </p>
                  {sender.sampleThreadId ? (
                    <Link
                      className="text-primary mt-2 inline-block text-sm hover:underline"
                      to={`/mail/inbox?threadId=${encodeURIComponent(sender.sampleThreadId)}&connectionId=${encodeURIComponent(sender.connectionId)}`}
                    >
                      Preview message
                    </Link>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={isMutating}
                    onClick={() => handleDecision(sender.email, 'allow')}
                  >
                    <Check className="mr-1.5 h-4 w-4" /> Allow
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isMutating}
                    onClick={() => handleDecision(sender.email, 'archive')}
                  >
                    <Archive className="mr-1.5 h-4 w-4" /> Archive
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isMutating}
                    onClick={() => handleDecision(sender.email, 'block')}
                  >
                    <Ban className="mr-1.5 h-4 w-4" /> Block
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={isMutating}
                    onClick={() => handleDecision(sender.email, 'spam')}
                  >
                    Spam
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="bg-muted/20 rounded-xl border border-dashed p-10 text-center">
          <Check className="text-muted-foreground mx-auto mb-3 h-6 w-6" />
          <p className="font-medium">Screening queue is clear</p>
          <p className="text-muted-foreground mt-1 text-sm">New senders will appear here.</p>
        </div>
      )}
    </main>
  );
}
