import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Link2,
  MailOpen,
  Paperclip,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SidebarToggle } from '@/components/ui/sidebar-toggle';
import { useConnections } from '@/hooks/use-connections';
import { useTRPC } from '@/providers/query-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown date'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};

const formatSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

export function MailboxAssets() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const connectionsQuery = useConnections();
  const [kind, setKind] = useState<'all' | 'attachment' | 'link'>('all');
  const [connectionId, setConnectionId] = useState('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursors, setCursors] = useState<string[]>(['']);
  const cursor = cursors.at(-1) ?? '';
  const connections =
    connectionsQuery.data?.connections.filter((connection) => connection.providerId === 'google') ?? [];
  const assets = useQuery(
    trpc.mailboxWorkflows.assets.list.queryOptions({
      kind,
      limit: 40,
      ...(connectionId === 'all' ? {} : { connectionId }),
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
    }),
  );

  const resetPage = () => setCursors(['']);

  const selectKind = (value: string) => {
    setKind(value as typeof kind);
    resetPage();
  };

  const selectConnection = (value: string) => {
    setConnectionId(value);
    resetPage();
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setQuery(search.trim());
    resetPage();
  };

  const openThread = (threadId: string, assetConnectionId: string) => {
    const params = new URLSearchParams({ threadId, connectionId: assetConnectionId });
    void navigate(`/mail/unified?${params}`);
  };

  const page = cursors.length;
  const items = assets.data?.items ?? [];

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-y-auto p-5 md:p-8">
      <SidebarToggle className="mb-3 md:hidden" />
      <div className="border-b pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Attachments & links</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
          Browse recent files and web links from mail across your connected accounts.
        </p>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Tabs value={kind} onValueChange={selectKind}>
            <TabsList className="h-10 w-full sm:w-auto">
              <TabsTrigger value="all" className="h-8 flex-1 px-3 sm:flex-none">
                All
              </TabsTrigger>
              <TabsTrigger value="attachment" className="h-8 flex-1 px-3 sm:flex-none">
                Attachments
              </TabsTrigger>
              <TabsTrigger value="link" className="h-8 flex-1 px-3 sm:flex-none">
                Links
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Select value={connectionId} onValueChange={selectConnection}>
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue placeholder="All accounts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All accounts</SelectItem>
              {connections.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <form className="relative flex min-w-0 flex-1 gap-2" onSubmit={submitSearch}>
            <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
            <Input
              value={search}
              className="min-w-0 pl-9"
              aria-label="Search attachments and links"
              placeholder="Search files, senders, subjects, or URLs"
              onChange={(event) => setSearch(event.target.value)}
            />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
        </div>
      </div>

      {connectionsQuery.isError || assets.isError ? (
        <div className="bg-muted/20 mt-5 rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">Attachments and links could not be loaded</p>
          <p className="text-muted-foreground mt-1 text-sm">Check the connection and try again.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-4"
            disabled={assets.isFetching}
            onClick={() => void Promise.all([connectionsQuery.refetch(), assets.refetch()])}
          >
            <RefreshCw className={`mr-1.5 h-4 w-4 ${assets.isFetching ? 'animate-spin' : ''}`} />
            Retry
          </Button>
        </div>
      ) : assets.isLoading ? (
        <p className="text-muted-foreground py-12 text-center text-sm">Scanning cached mail…</p>
      ) : items.length ? (
        <section className="py-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">
              {assets.data?.total ?? 0} {(assets.data?.total ?? 0) === 1 ? 'result' : 'results'}
              {assets.data?.isPartial ? ` from ${assets.data.scannedThreads} recent threads` : ''}
            </p>
            {assets.isFetching ? (
              <p className="text-muted-foreground text-xs">Refreshing…</p>
            ) : null}
          </div>
          <div className="divide-y overflow-hidden rounded-xl border">
            {items.map((asset) => {
              const sender = asset.senderName || asset.senderEmail || 'Unknown sender';
              const details = `${sender} · ${asset.accountEmail} · ${formatDate(asset.receivedAt)}`;
              const icon =
                asset.kind === 'attachment' ? (
                  <Paperclip className="h-4 w-4" />
                ) : (
                  <Link2 className="h-4 w-4" />
                );
              const content = (
                <>
                  <span className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                    {icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {asset.kind === 'attachment' ? asset.filename : asset.title}
                    </span>
                    <span className="text-muted-foreground mt-1 block truncate text-xs">
                      {asset.kind === 'attachment'
                        ? `${asset.mimeType} · ${formatSize(asset.size)}`
                        : asset.url}
                    </span>
                    <span className="text-muted-foreground mt-1 block truncate text-xs">
                      {asset.subject} · {details}
                    </span>
                  </span>
                </>
              );

              return asset.kind === 'attachment' ? (
                <button
                  key={asset.id}
                  type="button"
                  className="hover:bg-muted/40 focus-visible:ring-ring flex w-full items-center gap-3 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
                  onClick={() => openThread(asset.threadId, asset.connectionId)}
                >
                  {content}
                  <MailOpen className="text-muted-foreground h-4 w-4 shrink-0" />
                </button>
              ) : (
                <a
                  key={asset.id}
                  href={asset.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:bg-muted/40 focus-visible:ring-ring flex items-center gap-3 p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
                >
                  {content}
                  <ExternalLink className="text-muted-foreground h-4 w-4 shrink-0" />
                </a>
              );
            })}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={cursors.length === 1 || assets.isFetching}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              <ChevronLeft className="mr-1 h-4 w-4" /> Previous
            </Button>
            <span className="text-muted-foreground text-xs">Page {page}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!assets.data?.nextCursor || assets.isFetching}
              onClick={() => {
                const nextCursor = assets.data?.nextCursor;
                if (nextCursor) setCursors((current) => [...current, nextCursor]);
              }}
            >
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </section>
      ) : (
        <div className="bg-muted/20 mt-5 rounded-xl border border-dashed p-10 text-center">
          {kind === 'attachment' ? (
            <Paperclip className="text-muted-foreground mx-auto mb-3 h-6 w-6" />
          ) : kind === 'link' ? (
            <Link2 className="text-muted-foreground mx-auto mb-3 h-6 w-6" />
          ) : (
            <Search className="text-muted-foreground mx-auto mb-3 h-6 w-6" />
          )}
          <p className="font-medium">
            No matching {kind === 'all' ? 'attachments or links' : `${kind}s`}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">Try another account or search.</p>
        </div>
      )}
    </main>
  );
}
