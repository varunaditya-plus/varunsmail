import { aliasMailboxes } from '@/config/alias-mailboxes';
import { useConnections } from '@/hooks/use-connections';
import { useEmailAliases } from '@/hooks/use-email-aliases';
import { useLabels } from '@/hooks/use-labels';
import { useQueryState } from 'nuqs';
import { useMemo } from 'react';

export function useAliasMailbox() {
  const [viewId] = useQueryState('mailbox');
  const definition = aliasMailboxes[0];
  const isActive = viewId === definition.viewId;
  const connectionsQuery = useConnections();
  const sourceConnection = connectionsQuery.data?.connections.find(
    (connection) => connection.email.toLowerCase() === definition.sourceEmail.toLowerCase(),
  );
  const labelsQuery = useLabels(sourceConnection?.id, !!sourceConnection);
  const aliasesQuery = useEmailAliases(sourceConnection?.id ?? null);

  const mailbox = useMemo(() => {
    if (!sourceConnection) return null;

    const label = labelsQuery.userLabels.find(
      (item) => item.name.toLowerCase() === definition.labelName.toLowerCase(),
    );
    const alias = aliasesQuery.data.find(
      (item) => item.email.toLowerCase() === definition.email.toLowerCase(),
    );
    if (!label?.id || !alias) return null;

    return {
      id: definition.id,
      viewId: definition.viewId,
      email: definition.email,
      name: definition.name,
      picture: definition.picture,
      providerId: definition.providerId,
      createdAt: sourceConnection.createdAt,
      sourceConnectionId: sourceConnection.id,
      labelId: label.id,
    };
  }, [definition, sourceConnection, labelsQuery.userLabels, aliasesQuery.data]);

  const isResolving =
    isActive &&
    !mailbox &&
    (connectionsQuery.isLoading ||
      connectionsQuery.isFetching ||
      (!!sourceConnection &&
        (labelsQuery.isLoading || labelsQuery.isFetching || aliasesQuery.isFetching)));

  return { mailbox, isActive, isResolving };
}
