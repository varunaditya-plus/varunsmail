import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

const desiredSystemLabels = new Set([
  'IMPORTANT',
  'FORUMS',
  'PROMOTIONS',
  'SOCIAL',
  'UPDATES',
  'STARRED',
  'UNREAD',
]);

export function useLabels(connectionId?: string, enabled = true) {
  const trpc = useTRPC();
  const labelQuery = useQuery(
    trpc.labels.list.queryOptions(connectionId ? { connectionId } : undefined, {
      enabled,
      staleTime: 1000 * 60 * 60, // 1 hour
    }),
  );

  const { userLabels, systemLabels } = useMemo(() => {
    if (!labelQuery.data) return { userLabels: [], systemLabels: [] };
    const cleanedName = labelQuery.data
      .filter((label) => label.type === 'system')
      .map((label) => {
        return {
          ...label,
          name: label.name.replace('CATEGORY_', ''),
        };
      });
    const cleanedSystemLabels = cleanedName.filter((label) => desiredSystemLabels.has(label.name));
    return {
      userLabels: labelQuery.data.filter((label) => label.type === 'user'),
      systemLabels: cleanedSystemLabels,
    };
  }, [labelQuery.data]);

  return { userLabels, systemLabels, ...labelQuery };
}

export function useThreadLabels(ids: string[], connectionId?: string) {
  const { userLabels: labels = [] } = useLabels(connectionId);

  const threadLabels = useMemo(() => {
    if (!labels) return [];
    return labels.filter((label) => (label.id ? ids.includes(label.id) : false));
  }, [labels, ids]);

  return { labels: threadLabels };
}
