import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';

export function useEmailAliases(connectionId?: string | null) {
  const trpc = useTRPC();
  const emailAliasesQuery = useQuery(
    trpc.mail.getEmailAliases.queryOptions(
      { connectionId: connectionId ?? undefined },
      {
        enabled: connectionId !== null,
        placeholderData: [] as { email: string; name: string; primary?: boolean }[],
        staleTime: 24 * 60 * 60 * 1000,
        gcTime: 7 * 24 * 60 * 60 * 1000,
        refetchOnMount: false,
        refetchOnReconnect: false,
      },
    ),
  );
  return emailAliasesQuery;
}
