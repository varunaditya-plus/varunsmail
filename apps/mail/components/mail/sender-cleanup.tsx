import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Brush, Play, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SidebarToggle } from '@/components/ui/sidebar-toggle';
import { Switch } from '@/components/ui/switch';
import { useConnections } from '@/hooks/use-connections';
import { getAccountColor } from '@/lib/thread-ref';
import { useTRPC } from '@/providers/query-provider';

export function SenderCleanup() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const connectionsQuery = useConnections();
  const candidates = useQuery(trpc.mailboxWorkflows.cleanup.candidates.queryOptions({}));
  const rules = useQuery(trpc.mailboxWorkflows.cleanup.list.queryOptions({}));
  const createRule = useMutation(trpc.mailboxWorkflows.cleanup.create.mutationOptions());
  const setEnabled = useMutation(trpc.mailboxWorkflows.cleanup.setEnabled.mutationOptions());
  const runRule = useMutation(trpc.mailboxWorkflows.cleanup.run.mutationOptions());
  const deleteRule = useMutation(trpc.mailboxWorkflows.cleanup.delete.mutationOptions());
  const [open, setOpen] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [action, setAction] = useState<'archive' | 'trash'>('archive');
  const [ageDays, setAgeDays] = useState('30');
  const [search, setSearch] = useState('');
  const [pendingId, setPendingId] = useState('');
  const connections =
    connectionsQuery.data?.connections.filter((connection) => connection.providerId === 'google') ?? [];

  useEffect(() => {
    if (!connectionId && connections[0]?.id) setConnectionId(connections[0].id);
  }, [connectionId, connections]);

  const visibleCandidates = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (candidates.data?.senders ?? []).filter(
      (sender) =>
        !query ||
        sender.senderEmail.includes(query) ||
        sender.senderName?.toLowerCase().includes(query),
    );
  }, [candidates.data?.senders, search]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.mailboxWorkflows.cleanup.candidates.queryKey({}) }),
      queryClient.invalidateQueries({ queryKey: trpc.mailboxWorkflows.cleanup.list.queryKey({}) }),
      queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.pathKey() }),
    ]);

  const prepareRule = (candidate?: (typeof visibleCandidates)[number]) => {
    if (candidate) {
      setConnectionId(candidate.connectionId);
      setSenderEmail(candidate.senderEmail);
    }
    setOpen(true);
  };

  const saveRule = async () => {
    const days = Number(ageDays);
    if (!connectionId || !senderEmail.trim() || !Number.isInteger(days) || days < 0) {
      toast.error('Choose an account, sender, and valid retention period');
      return;
    }
    try {
      const created = await createRule.mutateAsync({
        connectionId,
        senderEmail: senderEmail.trim().toLowerCase(),
        action,
        ageDays: days,
      });
      const result = await runRule.mutateAsync({ id: created.rule.id });
      await refresh();
      setOpen(false);
      setSenderEmail('');
      toast.success(`Cleanup rule created · ${result.changed} cleaned this run`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create cleanup rule');
    }
  };

  const run = async (id: string) => {
    setPendingId(id);
    try {
      const result = await runRule.mutateAsync({ id });
      await refresh();
      toast.success(`${result.changed} ${result.changed === 1 ? 'thread' : 'threads'} cleaned this run`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Cleanup failed');
    } finally {
      setPendingId('');
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    try {
      await setEnabled.mutateAsync({ id, enabled });
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update cleanup rule');
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteRule.mutateAsync({ id });
      await refresh();
      toast.success('Cleanup rule deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete cleanup rule');
    }
  };

  const isSaving = createRule.isPending || runRule.isPending;
  const hasError = connectionsQuery.isError || candidates.isError || rules.isError;

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-y-auto p-5 md:p-8">
      <SidebarToggle className="mb-3 md:hidden" />
      <div className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-muted-foreground mb-1 text-sm">Inbox maintenance</p>
          <h1 className="text-2xl font-semibold tracking-tight">Sender cleanup</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Archive or move older inbox mail to Gmail Trash in safe daily batches.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button disabled={!connections.length} onClick={() => prepareRule()}>
              <Plus className="mr-1.5 h-4 w-4" /> New rule
            </Button>
          </DialogTrigger>
          <DialogContent showOverlay className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create cleanup rule</DialogTitle>
              <DialogDescription>The rule checks exact message age and cleans up to 20 inbox threads now, then daily.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label>Account</Label>
                <Select value={connectionId} onValueChange={setConnectionId}>
                  <SelectTrigger><SelectValue placeholder="Choose an account" /></SelectTrigger>
                  <SelectContent>
                    {connections.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>{connection.email}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cleanup-sender">Sender email</Label>
                <Input
                  id="cleanup-sender"
                  type="email"
                  value={senderEmail}
                  onChange={(event) => setSenderEmail(event.target.value)}
                  placeholder="news@example.com"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Action</Label>
                  <Select value={action} onValueChange={(value) => setAction(value as 'archive' | 'trash')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="archive">Archive</SelectItem>
                      <SelectItem value="trash">Move to Trash</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cleanup-age">Keep for days</Label>
                  <Input
                    id="cleanup-age"
                    type="number"
                    min="0"
                    max="3650"
                    value={ageDays}
                    onChange={(event) => setAgeDays(event.target.value)}
                  />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={isSaving} onClick={() => void saveRule()}>
                {isSaving ? 'Cleaning…' : 'Create & clean now'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {hasError ? (
        <div className="bg-muted/20 mt-5 rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">Cleanup data could not be loaded</p>
          <Button type="button" size="sm" variant="outline" className="mt-4" onClick={() => void refresh()}>
            <RefreshCw className="mr-1.5 h-4 w-4" /> Retry
          </Button>
        </div>
      ) : (
        <>
          <section className="mt-6">
            <h2 className="font-medium">Active rules</h2>
            {rules.data?.rules.length ? (
              <div className="mt-3 divide-y rounded-xl border">
                {rules.data.rules.map((rule) => {
                  const account = connections.find(({ id }) => id === rule.connectionId);
                  return (
                    <article key={rule.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                      <span className="bg-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                        {rule.action === 'archive' ? <Archive className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{rule.senderEmail}</p>
                        <p className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: getAccountColor(rule.connectionId) }} />
                          {account?.email ?? rule.connectionId} · {rule.action} after {rule.ageDays} days
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={rule.enabled} onCheckedChange={(enabled) => void toggle(rule.id, enabled)} />
                        <Button size="sm" variant="outline" disabled={pendingId === rule.id} onClick={() => void run(rule.id)}>
                          <Play className="mr-1.5 h-4 w-4" /> Run now
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => void remove(rule.id)}>
                          <Trash2 className="h-4 w-4" /><span className="sr-only">Delete cleanup rule</span>
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground mt-3 rounded-xl border border-dashed p-8 text-center text-sm">No cleanup rules yet.</p>
            )}
          </section>

          <section className="mt-8 pb-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-medium">Recent senders</h2>
                <p className="text-muted-foreground mt-1 text-xs">Based on a recent sample of up to 100 cached inbox threads across accounts.</p>
              </div>
              <div className="relative">
                <Search className="text-muted-foreground absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
                <Input className="w-full pl-9 sm:w-64" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search senders" />
              </div>
            </div>
            {candidates.isLoading ? (
              <p className="text-muted-foreground py-10 text-center text-sm">Scanning cached mail…</p>
            ) : visibleCandidates.length ? (
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {visibleCandidates.map((candidate) => (
                  <button
                    key={`${candidate.connectionId}:${candidate.senderEmail}`}
                    type="button"
                    className="hover:bg-muted/40 flex items-center gap-3 rounded-xl border p-3 text-left transition-colors"
                    onClick={() => prepareRule(candidate)}
                  >
                    <span className="bg-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"><Brush className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{candidate.senderName || candidate.senderEmail}</span>
                      <span className="text-muted-foreground block truncate text-xs">{candidate.senderEmail} · {candidate.count} in sample</span>
                    </span>
                    <Plus className="text-muted-foreground h-4 w-4" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground mt-3 rounded-xl border border-dashed p-8 text-center text-sm">No matching senders found.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
