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
import { Input } from '@/components/ui/input';
import { useTRPC } from '@/providers/query-provider';

type ReminderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  threadId: string;
  sentMessageId: string;
};

function toLocalInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function ReminderDialog({
  open,
  onOpenChange,
  connectionId,
  threadId,
  sentMessageId,
}: ReminderDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [dueAt, setDueAt] = useState(() => toLocalInput(new Date(Date.now() + 3 * 86_400_000)));
  const reminders = useQuery(
    trpc.mailboxWorkflows.reminders.list.queryOptions(
      { connectionId },
      { enabled: open && !!connectionId },
    ),
  );
  const current = useMemo(
    () => reminders.data?.reminders.find((item) => item.threadId === threadId),
    [reminders.data?.reminders, threadId],
  );
  const setReminder = useMutation(trpc.mailboxWorkflows.reminders.set.mutationOptions());
  const cancelReminder = useMutation(trpc.mailboxWorkflows.reminders.cancel.mutationOptions());
  const isMutating = setReminder.isPending || cancelReminder.isPending;

  useEffect(() => {
    if (open && current?.dueAt) setDueAt(toLocalInput(new Date(current.dueAt)));
  }, [open, current?.dueAt]);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.mailboxWorkflows.reminders.list.queryKey({ connectionId }),
    });

  const choosePreset = (hours: number) => {
    setDueAt(toLocalInput(new Date(Date.now() + hours * 3_600_000)));
  };

  const handleSave = async () => {
    if (reminders.isLoading || reminders.isError) return;
    const parsed = new Date(dueAt);
    if (!dueAt || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      toast.error('Choose a future time');
      return;
    }

    try {
      await setReminder.mutateAsync({
        connectionId,
        threadId,
        sentMessageId,
        dueAt: parsed.toISOString(),
      });
      await invalidate();
      toast.success('Reply reminder set');
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to set reminder');
    }
  };

  const handleCancel = async () => {
    try {
      await cancelReminder.mutateAsync({ connectionId, threadId });
      await invalidate();
      toast.success('Reply reminder cancelled');
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to cancel reminder');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !isMutating && onOpenChange(nextOpen)}>
      <DialogContent showOverlay className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remind me if nobody replies</DialogTitle>
          <DialogDescription>
            This thread will return to the inbox at the chosen time unless an external reply arrives.
          </DialogDescription>
        </DialogHeader>

        {reminders.isLoading ? (
          <p className="text-muted-foreground py-6 text-center text-sm">Loading reminder…</p>
        ) : reminders.isError ? (
          <div className="bg-muted/40 rounded-lg border p-4 text-center" role="alert">
            <p className="text-sm font-medium">Reminder could not be loaded</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {reminders.error instanceof Error ? reminders.error.message : 'The request failed.'}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3"
              disabled={reminders.isFetching}
              onClick={() => void reminders.refetch()}
            >
              {reminders.isFetching ? 'Trying again…' : 'Try again'}
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" disabled={isMutating} onClick={() => choosePreset(24)}>
                  Tomorrow
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={isMutating} onClick={() => choosePreset(72)}>
                  In 3 days
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={isMutating} onClick={() => choosePreset(168)}>
                  In 1 week
                </Button>
              </div>
              <Input
                type="datetime-local"
                value={dueAt}
                min={toLocalInput(new Date(Date.now() + 60_000))}
                disabled={isMutating}
                onChange={(event) => setDueAt(event.target.value)}
              />
              {current?.status === 'pending' ? (
                <p className="text-muted-foreground text-xs">
                  Current reminder: {new Date(current.dueAt).toLocaleString()}
                </p>
              ) : null}
            </div>

            <DialogFooter className="gap-2 sm:justify-between">
              <div>
                {current?.status === 'pending' ? (
                  <Button type="button" variant="ghost" onClick={handleCancel} disabled={isMutating}>
                    {cancelReminder.isPending ? 'Cancelling…' : 'Cancel reminder'}
                  </Button>
                ) : null}
              </div>
              <Button type="button" onClick={handleSave} disabled={isMutating}>
                {setReminder.isPending ? 'Saving…' : 'Set reminder'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
