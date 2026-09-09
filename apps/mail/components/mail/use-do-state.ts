import { useActiveConnection } from '@/hooks/use-connections';
import { useCallback } from 'react';
import { atom, useAtom } from 'jotai';

export type State = {
  isSyncing: boolean;
  syncingFolders: string[];
  storageSize: number;
  counts: { label: string; count: number }[];
  shards: number;
};

const emptyState: State = {
  isSyncing: false,
  syncingFolders: [],
  storageSize: 0,
  counts: [],
  shards: 0,
};

const stateAtom = atom<Record<string, State>>({});

function useDoState() {
  const { data: activeConnection } = useActiveConnection();
  const [states, setStates] = useAtom(stateAtom);
  const connectionId = activeConnection?.id;
  const setState = useCallback(
    (state: State) => {
      if (!connectionId) return;
      setStates((states) => ({ ...states, [connectionId]: state }));
    },
    [connectionId, setStates],
  );

  return [connectionId ? states[connectionId] ?? emptyState : emptyState, setState] as const;
}

export { useDoState };
