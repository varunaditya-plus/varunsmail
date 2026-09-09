import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigate,
  type MetaFunction,
} from 'react-router';
import { Analytics as DubAnalytics } from '@dub/analytics/react';
import { ServerProviders } from '@/providers/server-providers';
import { ClientProviders } from '@/providers/client-providers';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { useEffect, type PropsWithChildren } from 'react';
import type { AppRouter } from '@zero/server/trpc';
import { Button } from '@/components/ui/button';
import { getLocale } from '@/paraglide/runtime';
import { siteConfig } from '@/lib/site-config';
import { signOut } from '@/lib/auth-client';
import type { Route } from './+types/root';
import { AlertCircle } from 'lucide-react';
import { m } from '@/paraglide/messages';
import { ArrowLeft } from 'lucide-react';
import * as Sentry from '@sentry/react';
import superjson from 'superjson';
import './globals.css';

const getUrl = () => import.meta.env.VITE_PUBLIC_BACKEND_URL + '/api/trpc';
const FALLBACK_NAV_ITEMS = ['inbox', 'drafts', 'sent', 'screening', 'bundles', 'focus', 'rules', 'settings'];
const FALLBACK_ROWS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
];

export const getServerTrpc = (req: Request) =>
  createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        maxItems: 1,
        url: getUrl(),
        transformer: superjson,
        headers: req.headers,
      }),
    ],
  });

export const meta: MetaFunction = () => {
  return [
    { title: siteConfig.title },
    { name: 'description', content: siteConfig.description },
    { property: 'og:title', content: siteConfig.title },
    { property: 'og:description', content: siteConfig.description },
    { property: 'og:url', content: siteConfig.alternates.canonical },
    { property: 'og:type', content: 'website' },
    { rel: 'manifest', href: '/manifest.webmanifest' },
  ];
};

export function Layout({ children }: PropsWithChildren) {
  return (
    <html lang={getLocale()} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#141414" media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
        <link rel="manifest" href="/manifest.json" />
        <Meta />
        {import.meta.env.REACT_SCAN && (
          <script crossOrigin="anonymous" src="//unpkg.com/react-scan/dist/auto.global.js" />
        )}
        <Links />
      </head>
      <body className="antialiased">
        <ServerProviders connectionId={null}>
          <ClientProviders>{children}</ClientProviders>
          <DubAnalytics
            domainsConfig={{
              refer: 'mail.varunaditya.space',
            }}
          />
        </ServerProviders>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function HydrateFallback() {
  return (
    <div className="bg-sidebar flex h-svh w-full flex-col overflow-hidden" aria-label="Loading mail">
      <div className="flex h-16 shrink-0 items-center gap-4 px-3">
        <div className="bg-muted h-8 w-44 animate-pulse rounded-lg" />
        <div className="bg-muted/70 h-12 max-w-2xl flex-1 animate-pulse rounded-3xl" />
        <div className="bg-muted h-8 w-8 animate-pulse rounded-full" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-64 shrink-0 space-y-3 px-4 py-3 md:block">
          <div className="bg-muted h-14 animate-pulse rounded-2xl" />
          {FALLBACK_NAV_ITEMS.map((item) => (
            <div key={item} className="bg-muted/60 h-8 animate-pulse rounded-lg" />
          ))}
        </div>
        <div className="bg-panelLight dark:bg-panelDark min-w-0 flex-1 overflow-hidden rounded-t-xl">
          <div className="border-border/70 flex h-12 items-center gap-3 border-b px-4">
            <div className="bg-muted h-4 w-4 animate-pulse rounded" />
            <div className="bg-muted h-4 w-4 animate-pulse rounded-full" />
          </div>
          {FALLBACK_ROWS.map((row) => (
            <div key={row} className="border-border/70 flex h-11 items-center gap-4 border-b px-4">
              <div className="bg-muted h-4 w-4 animate-pulse rounded" />
              <div className="bg-muted h-3 w-28 animate-pulse rounded" />
              <div className="bg-muted/70 h-3 flex-1 animate-pulse rounded" />
              <div className="bg-muted h-3 w-12 animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error';
    details =
      error.status === 404 ? 'The requested page could not be found.' : error.statusText || details;
    if (error.status === 404) {
      return <NotFound />;
    }
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  useEffect(() => {
    console.error(error);
    console.error({ message, details, stack });

    // Report error to Sentry
    if (isRouteErrorResponse(error)) {
      Sentry.captureException(new Error(`Route Error ${error.status}: ${error.statusText}`), {
        tags: {
          type: 'route_error',
          status: error.status,
        },
        extra: {
          statusText: error.statusText,
          data: error.data,
        },
      });
    } else if (error instanceof Error) {
      Sentry.captureException(error, {
        tags: {
          type: 'app_error',
        },
      });
    } else {
      Sentry.captureException(new Error('Unknown error occurred'), {
        tags: {
          type: 'unknown_error',
        },
        extra: {
          error: error,
        },
      });
    }
  }, [error, message, details, stack]);

  return (
    <div className="dark:bg-background flex w-full items-center justify-center bg-white text-center">
      <div className="flex-col items-center justify-center md:flex dark:text-gray-100">
        {/* Message */}
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">Something went wrong!</h2>
          <p className="text-muted-foreground">See the console for more information.</p>
          <pre className="text-muted-foreground">{JSON.stringify(error, null, 2)}</pre>
        </div>

        <div className="mt-2 flex gap-2">
          <Button
            variant="outline"
            onClick={() => window.location.reload()}
            className="text-muted-foreground gap-2"
          >
            Refresh
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              await signOut();
              window.location.href = '/login';
            }}
            className="text-muted-foreground gap-2"
          >
            Log Out and Refresh
          </Button>
        </div>
      </div>
    </div>
  );
}

function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="dark:bg-background flex w-full items-center justify-center bg-white text-center">
      <div className="flex-col items-center justify-center md:flex dark:text-gray-100">
        <div className="relative">
          <h1 className="text-muted-foreground/20 select-none text-[150px] font-bold">404</h1>
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <AlertCircle className="text-muted-foreground h-20 w-20" />
          </div>
        </div>

        {/* Message */}
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">
            {m['pages.error.notFound.title']()}
          </h2>
          <p className="text-muted-foreground">{m['pages.error.notFound.description']()}</p>
        </div>

        {/* Buttons */}
        <div className="mt-2 flex justify-center gap-2">
          <Button
            variant="outline"
            onClick={() => navigate(-1)}
            className="text-muted-foreground gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            {m['pages.error.notFound.goBack']()}
          </Button>
        </div>
      </div>
    </div>
  );
}
