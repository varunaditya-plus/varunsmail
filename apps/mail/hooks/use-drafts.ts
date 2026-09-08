import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';

export const useDraft = (id: string | null, connectionId?: string | null) => {
  const { data: session } = useSession();
  const trpc = useTRPC();
  const draftQuery = useQuery(
    trpc.drafts.get.queryOptions(
      { id: id!, connectionId: connectionId ?? undefined },
      { enabled: !!session?.user.id && !!id, staleTime: 1000 * 60 * 60 },
    ),
  );
  return draftQuery;
};
