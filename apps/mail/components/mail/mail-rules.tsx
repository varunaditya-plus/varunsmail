import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, CircleAlert, ListFilter, Star, Tag, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SidebarToggle } from '@/components/ui/sidebar-toggle';
import { Switch } from '@/components/ui/switch';
import { useConnections } from '@/hooks/use-connections';
import { getAccountColor } from '@/lib/thread-ref';
import { useTRPC } from '@/providers/query-provider';

export function MailRules() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const rules = useQuery(trpc.mailboxWorkflows.rules.list.queryOptions());
  const connections = useConnections();
  const setEnabled = useMutation(trpc.mailboxWorkflows.rules.setEnabled.mutationOptions());
  const deleteRule = useMutation(trpc.mailboxWorkflows.rules.delete.mutationOptions());
  const [pendingDelete, setPendingDelete] = useState<{ id: string; senderEmail: string } | null>(null);
  const labelConnectionIds = [
    ...new Set(
      (rules.data?.rules ?? [])
        .filter((rule) => rule.action === 'label')
        .map((rule) => rule.connectionId),
    ),
  ];
  const labelQueries = useQueries({
    queries: labelConnectionIds.map((connectionId) =>
      trpc.mailboxWorkflows.rules.labels.queryOptions({ connectionId }),
    ),
  });
  const failedLabelQueries = labelQueries.filter((query) => query.isError);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.mailboxWorkflows.rules.list.queryKey() });

  const handleEnabled = async (id: string, enabled: boolean) => {
    try {
      await setEnabled.mutateAsync({ id, enabled });
      await refresh();
      toast.success(enabled ? 'Rule enabled' : 'Rule paused');
    } catch (error) {
      toast.error('Rule was not updated', {
        description: `${error instanceof Error ? error.message : 'The request failed.'} Try again from the switch.`,
      });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteRule.mutateAsync({ id });
      await refresh();
      toast.success('Rule deleted');
      setPendingDelete(null);
    } catch (error) {
      toast.error('Rule was not deleted', {
        description: `${error instanceof Error ? error.message : 'The request failed.'} Try again from the delete button.`,
      });
    }
  };

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-y-auto p-5 md:p-8">
      <SidebarToggle className="mb-3 md:hidden" />
      <div className="border-b pb-6">
        <p className="text-muted-foreground mb-1 text-sm">Sender automation</p>
        <h1 className="text-2xl font-semibold tracking-tight">Rules</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
          Manage the actions Varunsmail applies to future messages from a sender. Rules stay scoped
          to the Gmail account where they were created.
        </p>
      </div>

      {connections.isError ? (
        <Alert variant="destructive" className="mt-5">
          <CircleAlert className="h-4 w-4" />
          <AlertTitle>Account details could not be loaded</AlertTitle>
          <AlertDescription>
            <p>{connections.error.message}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void connections.refetch()}>
                Retry
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link to="/settings/connections">Check connections</Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {failedLabelQueries.length ? (
        <Alert variant="destructive" className="mt-5">
          <CircleAlert className="h-4 w-4" />
          <AlertTitle>Some Gmail label names could not be loaded</AlertTitle>
          <AlertDescription>
            <p>{failedLabelQueries[0]?.error?.message ?? 'The label request failed.'}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => void Promise.all(failedLabelQueries.map((query) => query.refetch()))}
            >
              Retry label names
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {rules.isLoading ? (
        <p className="text-muted-foreground py-10 text-center text-sm">Loading rules…</p>
      ) : rules.isError ? (
        <Alert variant="destructive" className="mt-5">
          <CircleAlert className="h-4 w-4" />
          <AlertTitle>Rules could not be loaded</AlertTitle>
          <AlertDescription>
            <p>{rules.error.message}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => void rules.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : rules.data?.rules.length ? (
        <div className="mt-5 divide-y rounded-xl border">
          {rules.data.rules.map((rule) => {
            const account = connections.data?.connections.find(
              (connection) => connection.id === rule.connectionId,
            );
            const labelQuery = labelQueries[labelConnectionIds.indexOf(rule.connectionId)];
            const labelName = labelQuery?.data?.labels.find((label) => label.id === rule.labelId)?.name;
            const actionLabel =
              rule.action === 'archive'
                ? 'Always archive'
                : rule.action === 'important'
                  ? 'Mark important'
                  : labelName
                    ? `Apply “${labelName}”`
                    : 'Apply Gmail label';

            return (
              <article key={rule.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="bg-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                    {rule.action === 'archive' ? (
                      <Archive className="text-muted-foreground h-4 w-4" />
                    ) : rule.action === 'important' ? (
                      <Star className="text-muted-foreground h-4 w-4" />
                    ) : (
                      <Tag className="text-muted-foreground h-4 w-4" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{rule.senderEmail}</p>
                    <p className="text-muted-foreground mt-1 flex min-w-0 items-center gap-2 text-xs">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: getAccountColor(rule.connectionId) }}
                      />
                      <span className="truncate">{account?.email ?? rule.connectionId}</span>
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 sm:justify-end">
                  <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-1 text-xs font-medium">
                    {actionLabel}
                  </span>
                  <label className="flex min-w-24 items-center justify-end gap-2 text-xs">
                    <Switch
                      checked={rule.enabled}
                      disabled={setEnabled.isPending || deleteRule.isPending}
                      onCheckedChange={(enabled) => handleEnabled(rule.id, enabled)}
                    />
                    {rule.enabled ? 'Enabled' : 'Paused'}
                  </label>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={setEnabled.isPending || deleteRule.isPending}
                    onClick={() => setPendingDelete({ id: rule.id, senderEmail: rule.senderEmail })}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="sr-only">Delete rule for {rule.senderEmail}</span>
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="bg-muted/20 mt-5 rounded-xl border border-dashed p-10 text-center">
          <ListFilter className="text-muted-foreground mx-auto mb-3 h-6 w-6" />
          <p className="font-medium">No sender rules yet</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Create one from a message&apos;s action menu to manage it here.
          </p>
        </div>
      )}

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open && !deleteRule.isPending) setPendingDelete(null);
        }}
      >
        <DialogContent showOverlay className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete sender rule?</DialogTitle>
            <DialogDescription>
              Future messages from {pendingDelete?.senderEmail ?? 'this sender'} will no longer use
              this rule. Existing messages will stay as they are.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleteRule.isPending}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!pendingDelete || deleteRule.isPending}
              onClick={() => pendingDelete && void handleDelete(pendingDelete.id)}
            >
              {deleteRule.isPending ? 'Deleting…' : 'Delete rule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
