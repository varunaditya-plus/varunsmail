import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_COLOR_OPTIONS, getAccountColor } from '@/lib/thread-ref';
import { useConnections } from '@/hooks/use-connections';
import { useTRPC } from '@/providers/query-provider';
import { useSettings } from '@/hooks/use-settings';
import { Button } from '@/components/ui/button';
import { Check, ChevronDown } from 'lucide-react';
import { useQueryState } from 'nuqs';
import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';

export function AccountFilter() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data } = useConnections();
  const { data: settingsData } = useSettings();
  const [filter, setFilter] = useQueryState('accounts');
  const { mutateAsync: saveUserSettings } = useMutation(trpc.settings.save.mutationOptions());
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
  const accountColors = settingsData?.settings.accountColors ?? {};

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

  async function changeAccountColor(connectionId: string, color: string) {
    const previous = accountColors;
    const next = { ...previous, [connectionId]: color };
    queryClient.setQueryData(trpc.settings.get.queryKey(), (current) =>
      current ? { ...current, settings: { ...current.settings, accountColors: next } } : current,
    );

    try {
      await saveUserSettings({ accountColors: next });
    } catch (error) {
      queryClient.setQueryData(trpc.settings.get.queryKey(), (current) =>
        current
          ? { ...current, settings: { ...current.settings, accountColors: previous } }
          : current,
      );
      console.error('Failed to update account color:', error);
      toast.error('Failed to update account color');
    }
  }

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
              style={{ backgroundColor: getAccountColor(connection.id, accountColors) }}
            />
            <span className="truncate">{connection.email}</span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">
          Account colors
        </DropdownMenuLabel>
        {connections.map((connection) => {
          const color = getAccountColor(connection.id, accountColors);
          return (
            <DropdownMenuSub key={connection.id}>
              <DropdownMenuSubTrigger>
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="max-w-48 truncate">{connection.email}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-36">
                {ACCOUNT_COLOR_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => void changeAccountColor(connection.id, option.value)}
                  >
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: option.value }}
                    />
                    {option.name}
                    <Check className={`ml-auto h-4 w-4 ${color === option.value ? '' : 'opacity-0'}`} />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
