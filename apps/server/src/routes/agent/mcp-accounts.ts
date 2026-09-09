export type McpConnection = {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  providerId: 'google' | 'microsoft';
  accessToken?: string | null;
  refreshToken?: string | null;
};

export type McpMailboxAccount = {
  id: string;
  connectionId: string;
  email: string;
  name: string | null;
  picture: string | null;
  providerId: 'google' | 'microsoft';
  kind: 'connection' | 'alias';
  isDefault: boolean;
  isConnected: boolean;
  fromEmail?: string;
  labelName?: string;
};

const aliases = [
  {
    id: 'alias:barcelonahackathon',
    email: 'varun@barcelonahackathon.com',
    name: 'Barcelona Hackathon',
    sourceEmail: 'varunaditya.aga@gmail.com',
    labelName: 'barcelonahackathon',
  },
];

export function listMcpMailboxAccounts(
  connections: McpConnection[],
  defaultConnectionId?: string | null,
) {
  const accounts: McpMailboxAccount[] = connections.map((mailbox) => ({
    id: mailbox.id,
    connectionId: mailbox.id,
    email: mailbox.email,
    name: mailbox.name,
    picture: mailbox.picture,
    providerId: mailbox.providerId,
    kind: 'connection',
    isDefault: mailbox.id === defaultConnectionId,
    isConnected: Boolean(mailbox.accessToken && mailbox.refreshToken),
  }));

  for (const alias of aliases) {
    const source = connections.find(
      (mailbox) => mailbox.email.toLowerCase() === alias.sourceEmail.toLowerCase(),
    );
    if (!source) continue;
    accounts.push({
      id: alias.id,
      connectionId: source.id,
      email: alias.email,
      name: alias.name,
      picture: source.picture,
      providerId: source.providerId,
      kind: 'alias',
      isDefault: false,
      isConnected: Boolean(source.accessToken && source.refreshToken),
      fromEmail: alias.email,
      labelName: alias.labelName,
    });
  }

  return accounts;
}

export function resolveMcpMailboxAccount(
  connections: McpConnection[],
  defaultConnectionId: string | null | undefined,
  selector?: string,
) {
  const accounts = listMcpMailboxAccounts(connections, defaultConnectionId);
  const normalized = selector?.trim().toLowerCase();
  const account = normalized
    ? accounts.find(
        (candidate) =>
          candidate.id.toLowerCase() === normalized || candidate.email.toLowerCase() === normalized,
      )
    : (accounts.find((candidate) => candidate.kind === 'connection' && candidate.isDefault) ??
      accounts.find((candidate) => candidate.kind === 'connection'));

  if (!account) throw new Error(selector ? 'Mailbox account not found' : 'Connect a mailbox first');
  return account;
}
