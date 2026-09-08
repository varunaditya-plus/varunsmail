import { authProxy } from '@/lib/auth-proxy';
import type { Route } from './+types/page';
import { redirect, useNavigate } from 'react-router';
import { useEffect } from 'react';

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const session = await authProxy.api.getSession({ headers: request.headers });
  if (session?.user.id) throw redirect('/mail/inbox');
  return null;
}

export default function Home() {
  const navigate = useNavigate();

  useEffect(() => {
    const previousScrollbarWidth = document.documentElement.style.scrollbarWidth;
    document.documentElement.style.scrollbarWidth = 'none';

    const redirectAtBottom = () => {
      const distanceFromBottom =
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      if (distanceFromBottom <= 1) navigate('/login');
    };

    window.addEventListener('scroll', redirectAtBottom, { passive: true });
    return () => {
      window.removeEventListener('scroll', redirectAtBottom);
      document.documentElement.style.scrollbarWidth = previousScrollbarWidth;
    };
  }, [navigate]);

  return (
    <main className="flex min-h-[130vh] items-start justify-center px-6 pt-[35vh] text-center text-xl">
      <p>
        this is varun&apos;s mail
        <br />
        if you&apos;re not me, kindly leave.
      </p>
    </main>
  );
}
