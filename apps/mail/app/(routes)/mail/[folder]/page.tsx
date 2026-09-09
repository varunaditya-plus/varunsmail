import { useLoaderData, useNavigate } from 'react-router';

import { MailLayout } from '@/components/mail/mail';
import { FocusReply } from '@/components/mail/focus-reply';
import { MailBundles } from '@/components/mail/mail-bundles';
import { MailRules } from '@/components/mail/mail-rules';
import { MailboxActivity } from '@/components/mail/mailbox-activity';
import { SenderScreening } from '@/components/mail/sender-screening';
import { SenderCleanup } from '@/components/mail/sender-cleanup';
import { useLabels } from '@/hooks/use-labels';
import { authProxy } from '@/lib/auth-proxy';
import { useEffect, useState } from 'react';
import type { Route } from './+types/page';

const ALLOWED_FOLDERS = new Set([
  'unified',
  'inbox',
  'draft',
  'sent',
  'spam',
  'bin',
  'archive',
  'snoozed',
  'screening',
  'bundles',
  'focus',
  'rules',
  'activity',
  'cleanup',
]);

type LabelNode = { id?: string; labels?: LabelNode[] };

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  if (!params.folder) return Response.redirect(`${import.meta.env.VITE_PUBLIC_APP_URL}/mail/unified`);

  const session = await authProxy.api.getSession({ headers: request.headers });
  if (!session) return Response.redirect(`${import.meta.env.VITE_PUBLIC_APP_URL}/login`);

  return {
    folder: params.folder,
  };
}

export default function MailPage() {
  const { folder } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const [isLabelValid, setIsLabelValid] = useState<boolean | null>(true);

  const isStandardFolder = ALLOWED_FOLDERS.has(folder);

  const { userLabels, isLoading: isLoadingLabels } = useLabels();

  useEffect(() => {
    if (isStandardFolder) {
      setIsLabelValid(true);
      return;
    }

    if (isLoadingLabels) return;

    if (userLabels) {
      const checkLabelExists = (labels: LabelNode[]): boolean => {
        for (const label of labels) {
          if (label.id === folder) return true;
          if (label.labels && label.labels.length > 0) {
            if (checkLabelExists(label.labels)) return true;
          }
        }
        return false;
      };

      const labelExists = checkLabelExists(userLabels);
      setIsLabelValid(labelExists);

      if (!labelExists) {
        const timer = setTimeout(() => {
          navigate('/mail/inbox');
        }, 2000);
        return () => clearTimeout(timer);
      }
    } else {
      setIsLabelValid(false);
    }
  }, [folder, userLabels, isLoadingLabels, isStandardFolder, navigate]);

  if (!isLabelValid) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center">
        <h2 className="text-xl font-semibold">Folder not found</h2>
        <p className="text-muted-foreground mt-2">
          The folder you&apos;re looking for doesn&apos;t exist. Redirecting to inbox...
        </p>
      </div>
    );
  }

  if (folder === 'screening') return <SenderScreening />;
  if (folder === 'bundles') return <MailBundles />;
  if (folder === 'focus') return <FocusReply />;
  if (folder === 'rules') return <MailRules />;
  if (folder === 'activity') return <MailboxActivity />;
  if (folder === 'cleanup') return <SenderCleanup />;
  return <MailLayout />;
}
