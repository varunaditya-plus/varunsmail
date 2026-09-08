import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';

export function useEmailAliases(connectionId?: string | null) {
  const trpc = useTRPC();
  const emailAliasesQuery = useQuery(
    trpc.mail.getEmailAliases.queryOptions({ connectionId: connectionId ?? undefined }, {
      initialData: [] as { email: string; name: string; primary?: boolean }[],
    }),
  );
  return emailAliasesQuery;
}
