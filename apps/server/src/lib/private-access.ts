type OwnerSession = { user: { id: string; email: string } } | null;

export async function authorizeAgentRequest(
  request: Request,
  options: {
    ownerEmail: string;
    appOrigin: string;
    getSession: (headers: Headers) => Promise<OwnerSession>;
    ownsConnection: (userId: string, connectionId: string) => Promise<boolean>;
  },
) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(options.appOrigin).origin) {
    return new Response('Forbidden', { status: 403 });
  }

  const session = await options.getSession(request.headers);
  if (!session || session.user.email.toLowerCase() !== options.ownerEmail.toLowerCase()) {
    return new Response('Unauthorized', { status: 401 });
  }

  const [, prefix, agent, encodedConnectionId] = new URL(request.url).pathname.split('/');
  if (prefix !== 'agents' || agent !== 'zero-agent' || !encodedConnectionId) {
    return new Response('Not found', { status: 404 });
  }

  let connectionId: string;
  try {
    connectionId = decodeURIComponent(encodedConnectionId);
  } catch {
    return new Response('Not found', { status: 404 });
  }

  if (!(await options.ownsConnection(session.user.id, connectionId))) {
    return new Response('Forbidden', { status: 403 });
  }
}

export async function getOwnerMcpUserId(
  headers: Headers,
  options: {
    ownerEmail: string;
    getMcpSession: (headers: Headers) => Promise<{ userId?: string | null } | null>;
    findUser: (userId: string) => Promise<{ email: string } | undefined>;
  },
) {
  if (!headers.get('Authorization')?.startsWith('Bearer ')) return;
  const session = await options.getMcpSession(headers);
  if (!session?.userId) return;
  const user = await options.findUser(session.userId);
  if (user?.email.toLowerCase() === options.ownerEmail.toLowerCase()) return session.userId;
}
