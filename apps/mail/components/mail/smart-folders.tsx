import { ExternalLink, FolderSearch, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SidebarToggle } from '@/components/ui/sidebar-toggle';
import { useConnections } from '@/hooks/use-connections';
import { useTRPC } from '@/providers/query-provider';
import { getAccountColor } from '@/lib/thread-ref';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

type SmartFolderSort = 'newest' | 'oldest' | 'sender' | 'domain';

const SORT_LABELS = {
  newest: 'Newest first',
  oldest: 'Oldest in loaded mail',
  sender: 'Sender in loaded mail',
  domain: 'Sender domain in loaded mail',
};

export function SmartFolders() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const folders = useQuery(trpc.mailboxWorkflows.smartFolders.list.queryOptions());
  const connectionsQuery = useConnections();
  const createFolder = useMutation(trpc.mailboxWorkflows.smartFolders.create.mutationOptions());
  const updateFolder = useMutation(trpc.mailboxWorkflows.smartFolders.update.mutationOptions());
  const deleteFolder = useMutation(trpc.mailboxWorkflows.smartFolders.delete.mutationOptions());
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [connectionId, setConnectionId] = useState('all');
  const [sort, setSort] = useState<SmartFolderSort>('newest');
  const connections =
    connectionsQuery.data?.connections.filter((connection) => connection.providerId === 'google') ??
    [];

  useEffect(() => {
    if (!open) {
      setEditingId('');
      setName('');
      setQuery('');
      setConnectionId('all');
      setSort('newest');
    }
  }, [open]);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.mailboxWorkflows.smartFolders.list.queryKey(),
    });

  const edit = (folder: NonNullable<typeof folders.data>['folders'][number]) => {
    setEditingId(folder.id);
    setName(folder.name);
    setQuery(folder.query);
    setConnectionId(folder.connectionId ?? 'all');
    setSort(folder.sort);
    setOpen(true);
  };

  const save = async () => {
    if (!name.trim() || !query.trim()) {
      toast.error('Enter a folder name and Gmail search');
      return;
    }
    try {
      const values = {
        name: name.trim(),
        query: query.trim(),
        connectionId: connectionId === 'all' ? null : connectionId,
        sort,
      };
      if (editingId) {
        await updateFolder.mutateAsync({ id: editingId, ...values });
      } else {
        await createFolder.mutateAsync({
          ...values,
          connectionId: values.connectionId ?? undefined,
        });
      }
      await refresh();
      setOpen(false);
      toast.success(editingId ? 'Smart folder updated' : 'Smart folder created');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save smart folder');
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteFolder.mutateAsync({ id });
      await refresh();
      toast.success('Smart folder deleted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete smart folder');
    }
  };

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-y-auto p-5 md:p-8">
      <SidebarToggle className="mb-3 md:hidden" />
      <div className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-muted-foreground mb-1 text-sm">Saved Gmail searches</p>
          <h1 className="text-2xl font-semibold tracking-tight">Smart folders</h1>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Save searches across every account or keep one tied to a specific mailbox.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> New smart folder
        </Button>
      </div>

      {folders.isLoading ? (
        <p className="text-muted-foreground py-12 text-center text-sm">Loading smart folders…</p>
      ) : folders.isError ? (
        <div className="mt-6 rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">Smart folders could not be loaded</p>
          <Button
            className="mt-4"
            size="sm"
            variant="outline"
            onClick={() => void folders.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : folders.data?.folders.length ? (
        <div className="mt-6 divide-y rounded-xl border">
          {folders.data.folders.map((folder) => {
            const account = connections.find(({ id }) => id === folder.connectionId);
            return (
              <article
                key={folder.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
              >
                <span className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                  <FolderSearch className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{folder.name}</p>
                  <p className="text-muted-foreground mt-1 truncate text-xs">{folder.query}</p>
                  <p className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: getAccountColor(folder.connectionId ?? 'unified') }}
                    />
                    {account?.email ?? 'All Gmail accounts'} · {SORT_LABELS[folder.sort]}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button asChild size="sm" variant="outline">
                    <Link
                      to={`/mail/inbox?smart=${encodeURIComponent(folder.id)}&sort=${folder.sort}`}
                    >
                      <ExternalLink className="mr-1.5 h-4 w-4" /> Open
                    </Link>
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => edit(folder)}>
                    <Pencil className="h-4 w-4" />
                    <span className="sr-only">Edit {folder.name}</span>
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => void remove(folder.id)}>
                    <Trash2 className="h-4 w-4" />
                    <span className="sr-only">Delete {folder.name}</span>
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="text-muted-foreground mt-6 rounded-xl border border-dashed p-10 text-center text-sm">
          No smart folders yet.
        </p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showOverlay className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit smart folder' : 'Create smart folder'}</DialogTitle>
            <DialogDescription>
              Search sender or subject text across accounts. Account-specific folders also accept
              Gmail search operators.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="smart-folder-name">Name</Label>
              <Input
                id="smart-folder-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Unread receipts"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smart-folder-query">Gmail search</Label>
              <Input
                id="smart-folder-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="is:unread subject:receipt"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Account</Label>
                <Select value={connectionId} onValueChange={setConnectionId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Gmail accounts</SelectItem>
                    {connections.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>
                        {connection.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Default sort</Label>
                <Select value={sort} onValueChange={(value) => setSort(value as SmartFolderSort)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest first</SelectItem>
                    <SelectItem value="oldest">Oldest in loaded mail</SelectItem>
                    <SelectItem value="sender">Sender in loaded mail</SelectItem>
                    <SelectItem value="domain">Sender domain in loaded mail</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              Oldest, sender, and domain sorting apply to the messages loaded as you scroll.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={createFolder.isPending || updateFolder.isPending}
              onClick={() => void save()}
            >
              {editingId ? 'Save changes' : 'Create folder'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
