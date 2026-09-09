type OwnerSession = { user: { id: string; email: string } } | null;
type McpSession = {
  userId?: string | null;
  accessTokenExpiresAt?: unknown;
  scopes?: unknown;
} | null;

export const MCP_FULL_MAIL_SCOPE = 'mail:full';
export const MCP_AUTHORIZATION_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  MCP_FULL_MAIL_SCOPE,
];

export function getMcpPluginOptions(loginPage: string) {
  return {
    loginPage,
    oidcConfig: {
      loginPage,
      allowDynamicClientRegistration: true,
      scopes: [MCP_FULL_MAIL_SCOPE],
      defaultScope: `openid ${MCP_FULL_MAIL_SCOPE}`,
      metadata: { scopes_supported: MCP_AUTHORIZATION_SCOPES },
    },
  };
}

export function getMcpAuthorizationServerMetadata(metadata: object | null) {
  if (!metadata) return null;
  return { ...metadata, scopes_supported: MCP_AUTHORIZATION_SCOPES };
}

export function getMcpProtectedResourceMetadata(appOrigin: string) {
  const origin = new URL(appOrigin).origin;
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [MCP_FULL_MAIL_SCOPE],
    resource_name: 'Varunsmail',
  };
}

export function unauthorizedMcpResponse(appOrigin: string) {
  const origin = new URL(appOrigin).origin;
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadata}", scope="${MCP_FULL_MAIL_SCOPE}"`,
    },
  });
}

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
    getMcpSession: (headers: Headers) => Promise<McpSession>;
    findUser: (userId: string) => Promise<{ email: string } | undefined>;
  },
) {
  if (!headers.get('Authorization')?.startsWith('Bearer ')) return;
  const session = await options.getMcpSession(headers);
  const expiresAt = session?.accessTokenExpiresAt;
  const scopes = typeof session?.scopes === 'string' ? session.scopes.split(/\s+/) : [];
  if (
    !session?.userId ||
    !(expiresAt instanceof Date) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now() ||
    !scopes.includes(MCP_FULL_MAIL_SCOPE)
  ) {
    return;
  }
  const user = await options.findUser(session.userId);
  if (user?.email.toLowerCase() === options.ownerEmail.toLowerCase()) return session.userId;
}
