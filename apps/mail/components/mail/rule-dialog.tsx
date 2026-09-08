import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConnections } from '@/hooks/use-connections';
import { getAccountColor } from '@/lib/thread-ref';
import { useTRPC } from '@/providers/query-provider';

type RuleDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  threadId: string;
};

export function RuleDialog({ open, onOpenChange, connectionId, threadId }: RuleDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const connections = useConnections();
  const [action, setAction] = useState<'archive' | 'label' | 'important'>('archive');
  const [labelId, setLabelId] = useState('');
  const labels = useQuery(
    trpc.mailboxWorkflows.rules.labels.queryOptions(
      { connectionId },
      { enabled: open && !!connectionId },
    ),
  );
  const canPreview = open && action !== 'label' ? true : open && !!labelId;
  const previewInput = useMemo(
    () => ({ connectionId, threadId, action, ...(action === 'label' ? { labelId } : {}) }),
    [connectionId, threadId, action, labelId],
  );
  const preview = useQuery(
    trpc.mailboxWorkflows.rules.preview.queryOptions(previewInput, { enabled: canPreview }),
  );
  const createRule = useMutation(trpc.mailboxWorkflows.rules.create.mutationOptions());
  const account = connections.data?.connections.find((connection) => connection.id === connectionId);

  useEffect(() => {
    if (action !== 'label') setLabelId('');
  }, [action]);

  const handleSave = async () => {
    if (!canPreview || !preview.data) return;
    try {
      await createRule.mutateAsync(previewInput);
      await queryClient.invalidateQueries({
        queryKey: trpc.mailboxWorkflows.rules.list.queryKey(),
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.mail.get.queryKey({ id: threadId, connectionId }),
        }),
        queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.pathKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.mail.listUnifiedThreads.pathKey() }),
      ]);
      toast.success('Rule created and applied');
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create rule');
    }
  };

  const effect =
    action === 'archive'
      ? 'Archive future messages from this sender'
      : action === 'important'
        ? 'Mark future messages from this sender important'
        : `Apply ${preview.data?.labelName ?? 'the selected label'} to future messages from this sender`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showOverlay className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a sender rule</DialogTitle>
          <DialogDescription>
            Preview the exact sender and action before this rule changes the current thread.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div
            className="bg-muted/50 text-muted-foreground flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs"
            aria-label={`Gmail account ${account?.email ?? connectionId}`}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: getAccountColor(connectionId) }}
              aria-hidden="true"
            />
            <span className="truncate">{account?.email ?? connectionId}</span>
          </div>

          <div className="space-y-2">
            <Label>Always</Label>
            <Select value={action} onValueChange={(value) => setAction(value as typeof action)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="archive">Archive this sender</SelectItem>
                <SelectItem value="label">Apply a label</SelectItem>
                <SelectItem value="important">Mark this sender important</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {action === 'label' ? (
            <div className="space-y-2">
              <Label>Gmail label</Label>
              {labels.isLoading ? (
                <p className="text-muted-foreground rounded-lg border px-3 py-2 text-sm">Loading labels…</p>
              ) : labels.isError ? (
                <div className="bg-muted/40 rounded-lg border p-3" role="alert">
                  <p className="text-sm font-medium">Gmail labels could not be loaded</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {labels.error instanceof Error ? labels.error.message : 'The request failed.'}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    disabled={labels.isFetching}
                    onClick={() => void labels.refetch()}
                  >
                    {labels.isFetching ? 'Trying again…' : 'Try again'}
                  </Button>
                </div>
              ) : (
                <Select value={labelId} onValueChange={setLabelId} disabled={createRule.isPending}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a label" />
                  </SelectTrigger>
                  <SelectContent>
                    {(labels.data?.labels ?? []).map((label) => (
                      <SelectItem key={label.id} value={label.id}>
                        {label.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ) : null}

          <div className="bg-muted/50 min-h-24 rounded-lg border p-4">
            {preview.isFetching ? (
              <p className="text-muted-foreground text-sm">Loading preview…</p>
            ) : preview.isError ? (
              <div role="alert">
                <p className="text-sm font-medium">Preview could not be loaded</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {preview.error instanceof Error ? preview.error.message : 'The request failed.'}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  disabled={preview.isFetching}
                  onClick={() => void preview.refetch()}
                >
                  Try again
                </Button>
              </div>
            ) : preview.data ? (
              <div className="space-y-2 text-sm">
                <p className="font-medium">{effect}</p>
                <p className="text-muted-foreground">
                  From: {preview.data.sender.name ? `${preview.data.sender.name} ` : ''}
                  &lt;{preview.data.sender.email}&gt;
                </p>
                <p className="text-muted-foreground truncate">Current thread: {preview.data.subject}</p>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                {action === 'label' ? 'Choose a label to preview this rule.' : 'Preview unavailable.'}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={!preview.data || createRule.isPending}
          >
            {createRule.isPending ? 'Applying…' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
