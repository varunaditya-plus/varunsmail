import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Clock3, PackageOpen, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SidebarToggle } from '@/components/ui/sidebar-toggle';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useConnections } from '@/hooks/use-connections';
import { getAccountColor } from '@/lib/thread-ref';
import { useTRPC } from '@/providers/query-provider';

export function MailBundles() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const bundles = useQuery(trpc.mailboxWorkflows.bundles.list.queryOptions());
  const bundleThreads = useQuery(trpc.mailboxWorkflows.bundles.threads.queryOptions({}));
  const connectionsQuery = useConnections();
  const createBundle = useMutation(trpc.mailboxWorkflows.bundles.create.mutationOptions());
  const updateBundle = useMutation(trpc.mailboxWorkflows.bundles.update.mutationOptions());
  const deleteBundle = useMutation(trpc.mailboxWorkflows.bundles.delete.mutationOptions());
  const releaseNow = useMutation(trpc.mailboxWorkflows.bundles.releaseNow.mutationOptions());
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'newsletter' | 'receipt' | 'notification' | 'sender'>('newsletter');
  const [sender, setSender] = useState('');
  const [connectionId, setConnectionId] = useState('all');
  const [deliveryMode, setDeliveryMode] = useState<'immediate' | 'scheduled'>('immediate');
  const [deliveryTimes, setDeliveryTimes] = useState('09:00');
  const [pendingDisable, setPendingDisable] = useState<{ id: string; name: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const connections =
    connectionsQuery.data?.connections.filter((connection) => connection.providerId === 'google') ?? [];
  const isMutating =
    createBundle.isPending || updateBundle.isPending || deleteBundle.isPending || releaseNow.isPending;

  const groups = useMemo(
    () =>
      (bundles.data?.bundles ?? []).map((bundle) => ({
        bundle,
        threads:
          bundleThreads.data?.groups.find((group) => group.bundle.id === bundle.id)?.threads ?? [],
      })),
    [bundles.data?.bundles, bundleThreads.data?.groups],
  );

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.mailboxWorkflows.bundles.list.queryKey() }),
      queryClient.invalidateQueries({
        queryKey: trpc.mailboxWorkflows.bundles.threads.queryKey({}),
      }),
    ]);

  const handleCreate = async () => {
    const normalizedSender = sender.trim().toLowerCase();
    if (!name.trim()) {
      toast.error('Give this bundle a name');
      return;
    }
    if (kind === 'sender' && !normalizedSender) {
      toast.error('Enter the sender email');
      return;
    }
    const times = deliveryTimes
      .split(',')
      .map((time) => time.trim())
      .filter(Boolean);

    try {
      await createBundle.mutateAsync({
        name: name.trim(),
        deliveryMode,
        deliveryTimes: deliveryMode === 'scheduled' ? times : [],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid',
        matchers: [
          {
            kind,
            ...(connectionId === 'all' ? {} : { connectionId }),
            ...(kind === 'sender' ? { value: normalizedSender } : {}),
          },
        ],
      });
      await refresh();
      setName('');
      setSender('');
      setOpen(false);
      toast.success('Bundle created');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create bundle');
    }
  };

  const handleEnabled = async (id: string, enabled: boolean) => {
    try {
      await updateBundle.mutateAsync({ id, enabled });
      await refresh();
      setPendingDisable(null);
      toast.success(enabled ? 'Bundle enabled' : 'Bundle disabled');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update bundle');
    }
  };

  const handleRelease = async (id: string) => {
    try {
      const result = await releaseNow.mutateAsync({ id });
      await refresh();
      toast.success(`${result.released} ${result.released === 1 ? 'thread' : 'threads'} released`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to release bundle');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteBundle.mutateAsync({ id });
      await refresh();
      toast.success('Bundle deleted');
      setPendingDelete(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete bundle');
    }
  };

  const retry = async () => {
    await Promise.all([bundles.refetch(), bundleThreads.refetch()]);
  };

  const hasQueryError = bundles.isError || bundleThreads.isError;
  const isRetrying = bundles.isFetching || bundleThreads.isFetching;

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-y-auto p-5 md:p-8">
      <SidebarToggle className="mb-3 md:hidden" />
      <div className="flex items-end justify-between gap-4 border-b pb-6">
        <div>
          <p className="text-muted-foreground mb-1 text-sm">Grouped mail</p>
          <h1 className="text-2xl font-semibold tracking-tight">Bundles & digests</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Collapse newsletters, receipts, notifications, or a sender into one place. Scheduled
            bundles stay out of the inbox until a chosen digest time.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              disabled={
                isMutating ||
                connectionsQuery.isLoading ||
                connectionsQuery.isError ||
                !connections.length
              }
            >
              <Plus className="mr-1.5 h-4 w-4" /> New bundle
            </Button>
          </DialogTrigger>
          <DialogContent showOverlay className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Create bundle</DialogTitle>
              <DialogDescription>Choose what belongs here and when it reaches the inbox.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="space-y-2">
                <Label htmlFor="bundle-name">Name</Label>
                <Input
                  id="bundle-name"
                  value={name}
                  placeholder="Newsletters"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Match</Label>
                  <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="newsletter">Newsletters</SelectItem>
                      <SelectItem value="receipt">Receipts</SelectItem>
                      <SelectItem value="notification">Notifications</SelectItem>
                      <SelectItem value="sender">Exact sender</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Account</Label>
                  <Select value={connectionId} onValueChange={setConnectionId}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All accounts</SelectItem>
                      {connections.map((connection) => (
                        <SelectItem key={connection.id} value={connection.id}>
                          {connection.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {kind === 'sender' ? (
                <div className="space-y-2">
                  <Label htmlFor="bundle-sender">Sender email</Label>
                  <Input
                    id="bundle-sender"
                    type="email"
                    value={sender}
                    placeholder="news@example.com"
                    onChange={(event) => setSender(event.target.value)}
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <Label>Delivery</Label>
                <Select
                  value={deliveryMode}
                  onValueChange={(value) => setDeliveryMode(value as typeof deliveryMode)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="immediate">Keep in inbox, grouped here</SelectItem>
                    <SelectItem value="scheduled">Deliver as a digest</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {deliveryMode === 'scheduled' ? (
                <div className="space-y-2">
                  <Label htmlFor="bundle-times">Times, separated by commas</Label>
                  <Input
                    id="bundle-times"
                    value={deliveryTimes}
                    placeholder="09:00, 17:30"
                    onChange={(event) => setDeliveryTimes(event.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    Uses {Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid'}.
                  </p>
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={createBundle.isPending}>
                {createBundle.isPending ? 'Creating…' : 'Create bundle'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {connectionsQuery.isError ? (
        <div className="mt-5 flex items-center justify-between gap-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-700 dark:text-amber-300">Gmail account choices could not be loaded.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isRetrying}
            onClick={() => void connectionsQuery.refetch()}
          >
            <RefreshCw className={`mr-1.5 h-4 w-4 ${connectionsQuery.isFetching ? 'animate-spin' : ''}`} />
            Retry
          </Button>
        </div>
      ) : null}

      {bundles.isLoading || bundleThreads.isLoading ? (
        <p className="text-muted-foreground py-10 text-center text-sm">Loading bundles…</p>
      ) : hasQueryError ? (
        <div className="bg-muted/20 mt-5 rounded-xl border border-dashed p-8 text-center">
          <PackageOpen className="text-muted-foreground mx-auto mb-3 h-6 w-6" />
          <p className="font-medium">Bundles could not be loaded</p>
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
      ) : groups.length ? (
        <div className="mt-5 space-y-3">
          {groups.map(({ bundle, threads }) => (
            <Collapsible key={bundle.id} defaultOpen={threads.length > 0} className="rounded-xl border">
              <div className="flex items-center gap-3 p-4">
                <CollapsibleTrigger asChild>
                  <button type="button" className="group flex min-w-0 flex-1 items-center gap-3 text-left">
                    <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-data-[state=closed]:-rotate-90" />
                    <PackageOpen className="text-muted-foreground h-4 w-4 shrink-0" />
                    <span className="truncate font-medium">{bundle.name}</span>
                    <span className="text-muted-foreground text-xs">{threads.length}</span>
                    {bundle.deliveryMode === 'scheduled' ? (
                      <span className="text-muted-foreground ml-auto hidden items-center gap-1 text-xs sm:flex">
                        <Clock3 className="h-3.5 w-3.5" /> {(bundle.deliveryTimes ?? []).join(', ')}
                      </span>
                    ) : null}
                  </button>
                </CollapsibleTrigger>
                <Switch
                  checked={bundle.enabled}
                  disabled={isMutating}
                  onCheckedChange={(enabled) => {
                    if (!enabled && bundle.deliveryMode === 'scheduled') {
                      setPendingDisable({ id: bundle.id, name: bundle.name });
                      return;
                    }
                    void handleEnabled(bundle.id, enabled);
                  }}
                />
                {bundle.deliveryMode === 'scheduled' ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={isMutating}
                    onClick={() => handleRelease(bundle.id)}
                  >
                    <Send className="h-4 w-4" />
                    <span className="sr-only">Release now</span>
                  </Button>
                ) : null}
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={isMutating}
                  onClick={() => setPendingDelete({ id: bundle.id, name: bundle.name })}
                >
                  <Trash2 className="h-4 w-4" />
                  <span className="sr-only">Delete bundle</span>
                </Button>
              </div>
              <CollapsibleContent>
                <div className="border-t">
                  {threads.length ? (
                    threads.map((thread) => {
                      const account = connections.find(
                        (connection) => connection.id === thread.connectionId,
                      );
                      const accountEmail = account?.email ?? thread.connectionId;

                      return (
                        <Link
                          key={`${thread.connectionId}:${thread.threadId}`}
                          to={`/mail/unified?threadId=${encodeURIComponent(thread.threadId)}&connectionId=${encodeURIComponent(thread.connectionId)}`}
                          className="hover:bg-muted/40 flex items-center gap-3 border-b px-5 py-3 last:border-b-0"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {thread.senderName || thread.senderEmail || 'Unknown sender'}
                            </p>
                            <p className="text-muted-foreground truncate text-sm">
                              {thread.subject || 'No subject'}
                            </p>
                            <p
                              className="text-muted-foreground mt-1 flex min-w-0 items-center gap-1.5 text-xs"
                              aria-label={`Account ${accountEmail}`}
                            >
                              <span
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ backgroundColor: getAccountColor(thread.connectionId) }}
                                aria-hidden="true"
                              />
                              <span className="truncate">{accountEmail}</span>
                            </p>
                          </div>
                          {thread.receivedAt ? (
                            <time className="text-muted-foreground shrink-0 text-xs">
                              {new Date(thread.receivedAt).toLocaleDateString()}
                            </time>
                          ) : null}
                        </Link>
                      );
                    })
                  ) : (
                    <p className="text-muted-foreground px-5 py-6 text-sm">No matching threads yet.</p>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      ) : (
        <div className="bg-muted/20 mt-5 rounded-xl border border-dashed p-10 text-center">
          <PackageOpen className="text-muted-foreground mx-auto mb-3 h-6 w-6" />
          <p className="font-medium">No bundles yet</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Create one to group recurring mail or schedule a digest.
          </p>
        </div>
      )}

      <Dialog
        open={!!pendingDisable}
        onOpenChange={(open) => {
          if (!open && !updateBundle.isPending) setPendingDisable(null);
        }}
      >
        <DialogContent showOverlay className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disable {pendingDisable?.name || 'bundle'}?</DialogTitle>
            <DialogDescription>
              Held messages will return to the inbox now. Future matching messages will stay in the
              inbox until this bundle is enabled again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={updateBundle.isPending}
              onClick={() => setPendingDisable(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!pendingDisable || updateBundle.isPending}
              onClick={() => pendingDisable && void handleEnabled(pendingDisable.id, false)}
            >
              {updateBundle.isPending ? 'Disabling…' : 'Disable bundle'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open && !deleteBundle.isPending) setPendingDelete(null);
        }}
      >
        <DialogContent showOverlay className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {pendingDelete?.name || 'bundle'}?</DialogTitle>
            <DialogDescription>
              Held messages will return to the inbox and the bundle label will be removed from Gmail.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleteBundle.isPending}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!pendingDelete || deleteBundle.isPending}
              onClick={() => pendingDelete && void handleDelete(pendingDelete.id)}
            >
              {deleteBundle.isPending ? 'Deleting…' : 'Delete bundle'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
