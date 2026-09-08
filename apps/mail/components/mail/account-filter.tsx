import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConnections } from '@/hooks/use-connections';
import { getAccountColor } from '@/lib/thread-ref';
import { Button } from '@/components/ui/button';
import { ChevronDown } from 'lucide-react';
import { useQueryState } from 'nuqs';
import { useEffect, useMemo } from 'react';

export function AccountFilter() {
  const { data } = useConnections();
  const [filter, setFilter] = useQueryState('accounts');
  const connections = useMemo(
    () => data?.connections.filter((connection) => connection.providerId === 'google') ?? [],
    [data?.connections],
  );
  const connectionIds = useMemo(
    () => new Set(connections.map((connection) => connection.id)),
    [connections],
  );
  const filteredIds = filter?.split(',').filter((id) => connectionIds.has(id)) ?? [];
  const selectedIds = filteredIds.length ? filteredIds : connections.map((connection) => connection.id);

  useEffect(() => {
    if (!data || !filter) return;
    const validIds = [...new Set(filter.split(',').filter((id) => connectionIds.has(id)))].sort();
    const nextFilter =
      validIds.length && validIds.length !== connections.length ? validIds.join(',') : null;
    if (nextFilter !== filter) void setFilter(nextFilter);
  }, [connectionIds, connections.length, data, filter, setFilter]);

  if (connections.length < 2) return null;

  const toggleConnection = (connectionId: string) => {
    const next = selectedIds.includes(connectionId)
      ? selectedIds.filter((id) => id !== connectionId)
      : [...selectedIds, connectionId];
    if (!next.length) return;
    const allSelected = connections.every((connection) => next.includes(connection.id));
    void setFilter(allSelected ? null : next.sort().join(','));
  };

  const label =
    selectedIds.length === connections.length
      ? 'All accounts'
      : selectedIds.length === 1
        ? connections.find((connection) => connection.id === selectedIds[0])?.email
        : `${selectedIds.length} accounts`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-10 max-w-44 gap-2 rounded-lg px-3 shadow-none">
          <span className="truncate text-xs">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        {connections.map((connection) => (
          <DropdownMenuCheckboxItem
            key={connection.id}
            checked={selectedIds.includes(connection.id)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => toggleConnection(connection.id)}
          >
            <span
              className="mr-2 h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: getAccountColor(connection.id) }}
            />
            <span className="truncate">{connection.email}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
