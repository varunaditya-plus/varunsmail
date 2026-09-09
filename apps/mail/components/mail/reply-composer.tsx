import { useUndoSend } from '@/hooks/use-undo-send';
import { constructReplyBody, constructForwardBody } from '@/lib/utils';
import { useActiveConnection, useConnections } from '@/hooks/use-connections';
import { useEmailAliases } from '@/hooks/use-email-aliases';
import { useAliasMailbox } from '@/hooks/use-alias-mailbox';
import { EmailComposer } from '../create/email-composer';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { useTRPC } from '@/providers/query-provider';
import { useMutation } from '@tanstack/react-query';
import { useSettings } from '@/hooks/use-settings';
import { useThread } from '@/hooks/use-threads';
import { useSession } from '@/lib/auth-client';
import { serializeFiles } from '@/lib/schemas';
import { parseFrom } from '@/lib/email-utils';
import { useDraft } from '@/hooks/use-drafts';
import { m } from '@/paraglide/messages';
import type { IConnection, Sender } from '@/types';
import { useQueryState } from 'nuqs';
import { useEffect, useMemo } from 'react';
import posthog from 'posthog-js';
import { toast } from 'sonner';

interface ReplyComposeProps {
  messageId?: string;
}

function ensureEmailArray(emails: string | string[] | undefined | null) {
  if (!emails) return [];
  const values = Array.isArray(emails) ? emails : emails.split(',');
  return values.map((email) => email.trim().replace(/[<>]/g, '')).filter(Boolean);
}

export default function ReplyCompose({ messageId }: ReplyComposeProps) {
  const [mode, setMode] = useQueryState('mode');
  const { enableScope, disableScope } = useHotkeysContext();
  const [connectionId] = useQueryState('connectionId');
  const { data: activeConnection } = useActiveConnection();
  const { mailbox: aliasMailbox, isActive: isAliasMailboxActive } = useAliasMailbox();
  const replyConnectionId = isAliasMailboxActive
    ? (aliasMailbox?.sourceConnectionId ?? null)
    : (connectionId ?? activeConnection?.id ?? null);
  const { data: aliases, isFetching: isAliasesFetching } = useEmailAliases(replyConnectionId);

  const [draftId, setDraftId] = useQueryState('draftId');
  const [threadId] = useQueryState('threadId');
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const { data: emailData, refetch, latestDraft } = useThread(threadId, replyConnectionId);
  const { data: draft, isFetching: isDraftFetching } = useDraft(
    draftId ?? null,
    replyConnectionId,
  );
  const trpc = useTRPC();
  const { mutateAsync: sendEmail } = useMutation(trpc.mail.send.mutationOptions());
  const { data: connectionData } = useConnections();
  const replyConnection =
    connectionData?.connections.find(
      (connection: IConnection) => connection.id === replyConnectionId,
    ) ??
    activeConnection;
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: session } = useSession();
  const { handleUndoSend } = useUndoSend();

  // Find the specific message to reply to
  const replyToMessage =
    (messageId && emailData?.messages.find((msg) => msg.id === messageId)) || emailData?.latest;

  const initial = useMemo(() => {
    if (!replyToMessage || !mode || !replyConnection?.email) {
      return { to: [], cc: [], bcc: [], subject: '', preferredFromEmail: undefined };
    }

    const selfAddresses = new Set(
      [replyConnection.email, aliasMailbox?.email, ...(aliases ?? []).map((alias) => alias.email)]
        .filter(Boolean)
        .map((email) => email!.trim().toLowerCase()),
    );
    const originalRecipients = [
      ...(replyToMessage.to || []),
      ...(replyToMessage.cc || []),
      ...(replyToMessage.bcc || []),
    ];
    const addressedAlias = aliases?.find((alias) =>
      [replyToMessage.sender, ...originalRecipients].some(
        (recipient) => recipient.email.toLowerCase() === alias.email.toLowerCase(),
      ),
    );
    const preferredFromEmail = isAliasMailboxActive ? aliasMailbox?.email : addressedAlias?.email;
    const draftMessage = draft || latestDraft;
    const subjectPrefix = mode === 'forward' ? 'Fwd:' : 'Re:';
    const subjectPattern = mode === 'forward' ? /^(fwd?|forward):/i : /^(re|aw|sv):/i;
    const subject = subjectPattern.test(replyToMessage.subject)
      ? replyToMessage.subject
      : `${subjectPrefix} ${replyToMessage.subject}`;

    if (draftMessage) {
      return {
        to: draft
          ? ensureEmailArray(draft.to)
          : latestDraft?.to.map((recipient) => recipient.email) ?? [],
        cc: draft
          ? ensureEmailArray(draft.cc)
          : latestDraft?.cc?.map((recipient) => recipient.email) ?? [],
        bcc: draft
          ? ensureEmailArray(draft.bcc)
          : latestDraft?.bcc?.map((recipient) => recipient.email) ?? [],
        subject: draftMessage.subject || subject,
        preferredFromEmail,
      };
    }

    if (mode === 'forward') {
      return { to: [], cc: [], bcc: [], subject, preferredFromEmail };
    }

    const to: string[] = [];
    const cc: string[] = [];
    const seen = new Set<string>();
    const addRecipient = (target: string[], email?: string) => {
      const normalized = email?.trim().toLowerCase();
      if (!email || !normalized || selfAddresses.has(normalized) || seen.has(normalized)) return;
      seen.add(normalized);
      target.push(email);
    };
    const parsedReplyTo = replyToMessage.replyTo ? parseFrom(replyToMessage.replyTo).email : '';
    const replyAddress =
      parsedReplyTo === 'no-sender@unknown'
        ? replyToMessage.sender.email
        : parsedReplyTo || replyToMessage.sender.email;

    addRecipient(to, replyAddress);
    if (!to.length) {
      const externalRecipient = originalRecipients.find(
        (recipient) => !selfAddresses.has(recipient.email.toLowerCase()),
      );
      addRecipient(to, externalRecipient?.email);
    }

    if (mode === 'replyAll') {
      replyToMessage.to?.forEach((recipient) => addRecipient(to, recipient.email));
      replyToMessage.cc?.forEach((recipient) => addRecipient(cc, recipient.email));
    }

    return { to, cc, bcc: [], subject, preferredFromEmail };
  }, [
    aliasMailbox?.email,
    aliases,
    draft,
    isAliasMailboxActive,
    latestDraft,
    mode,
    replyConnection?.email,
    replyToMessage,
  ]);

  const handleSendEmail = async (data: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    message: string;
    attachments: File[];
    fromEmail?: string;
    draftId?: string;
    scheduleAt?: string;
  }) => {
    if (!replyToMessage || !replyConnection?.email) return;

    try {
      const userEmail = replyConnection.email.toLowerCase();
      const userName = replyConnection.name || session?.user?.name || '';

      let senderAddress = userEmail;
      const selectedAddress = data.fromEmail?.trim().toLowerCase();
      const selectedAlias = aliases?.find(
        (alias) => alias.email.toLowerCase() === selectedAddress,
      );
      const isConfiguredAlias =
        isAliasMailboxActive && aliasMailbox?.email.toLowerCase() === selectedAddress;

      if (selectedAlias || selectedAddress === userEmail || isConfiguredAlias) {
        senderAddress = selectedAlias?.email ?? aliasMailbox?.email ?? replyConnection.email;
      } else if (aliases && aliases.length > 0) {
        const allRecipients = [
          ...(replyToMessage.to || []),
          ...(replyToMessage.cc || []),
          ...(replyToMessage.bcc || []),
        ];
        const matchingAlias = aliases.find((alias) =>
          allRecipients.some(
            (recipient) => recipient.email.toLowerCase() === alias.email.toLowerCase(),
          ),
        );

        if (matchingAlias) {
          senderAddress = matchingAlias.email;
        } else {
          senderAddress =
            aliases.find((alias) => alias.email.toLowerCase() === userEmail)?.email ||
            aliases.find((alias) => alias.primary)?.email ||
            aliases[0]?.email ||
            userEmail;
        }
      }
      const senderName = selectedAlias?.name || userName;
      const fromEmail = senderName.trim()
        ? `${senderName.replace(/[<>]/g, '')} <${senderAddress}>`
        : senderAddress;

      const toRecipients: Sender[] = data.to.map((email) => ({
        email,
        name: email.split('@')[0] || 'User',
      }));

      const ccRecipients: Sender[] | undefined = data.cc
        ? data.cc.map((email) => ({
            email,
            name: email.split('@')[0] || 'User',
          }))
        : undefined;

      const bccRecipients: Sender[] | undefined = data.bcc
        ? data.bcc.map((email) => ({
            email,
            name: email.split('@')[0] || 'User',
          }))
        : undefined;

      const emailBody =
        mode === 'forward'
          ? constructForwardBody(
              data.message,
              new Date(replyToMessage.receivedOn || '').toLocaleString(),
              { ...replyToMessage.sender, subject: replyToMessage.subject },
              toRecipients,
              //   replyToMessage.decodedBody,
            )
          : constructReplyBody(
              data.message,
              new Date(replyToMessage.receivedOn || '').toLocaleString(),
              replyToMessage.sender,
              toRecipients,
              //   replyToMessage.decodedBody,
            );

      const result = await sendEmail({
        to: toRecipients,
        cc: ccRecipients,
        bcc: bccRecipients,
        subject: data.subject,
        message: emailBody,
        attachments: await serializeFiles(data.attachments),
        fromEmail: fromEmail,
        draftId: data.draftId ?? draftId ?? undefined,
        headers: {
          'In-Reply-To': replyToMessage?.messageId ?? '',
          References: [
            ...(replyToMessage?.references ? replyToMessage.references.split(' ') : []),
            replyToMessage?.messageId,
          ]
            .filter(Boolean)
            .join(' '),
          'Thread-Id': replyToMessage?.threadId ?? '',
        },
        threadId: replyToMessage?.threadId,
        isForward: mode === 'forward',
        originalMessage: replyToMessage.decodedBody,
        scheduleAt: data.scheduleAt,
        connectionId: replyConnection.id,
      });

      posthog.capture('Reply Email Sent');

      // Reset states
      setMode(null);
      await refetch();
      
      handleUndoSend(result, settings, {
        to: data.to,
        cc: data.cc,
        bcc: data.bcc,
        subject: data.subject,
        message: data.message,
        attachments: data.attachments,
        scheduleAt: data.scheduleAt,
      });
    } catch (error) {
      console.error('Error sending email:', error);
      toast.error(m['pages.createEmail.failedToSendEmail']());
    }
  };

  useEffect(() => {
    if (mode) {
      enableScope('compose');
    } else {
      disableScope('compose');
    }
    return () => {
      disableScope('compose');
    };
  }, [mode, enableScope, disableScope]);

  if (
    !mode ||
    !emailData ||
    !replyConnection ||
    isAliasesFetching ||
    isDraftFetching ||
    (isAliasMailboxActive && !aliasMailbox)
  ) {
    return null;
  }

  return (
    <div className="w-full rounded-2xl overflow-visible border">
      <EmailComposer
        key={`${replyToMessage?.id}:${mode}:${draft?.id ?? latestDraft?.id ?? ''}`}
        connectionId={replyConnection.id}
        preferredFromEmail={initial.preferredFromEmail}
        editorClassName="min-h-[50px]"
        className="w-full max-w-none! pb-1 overflow-visible"
        onSendEmail={handleSendEmail}
        onClose={async () => {
          setMode(null);
          setDraftId(null);
          setActiveReplyId(null);
        }}
        initialMessage={draft?.content ?? latestDraft?.decodedBody}
        initialTo={initial.to}
        initialCc={initial.cc}
        initialBcc={initial.bcc}
        initialSubject={initial.subject}
        autofocus={true}
        settingsLoading={settingsLoading}
      />
    </div>
  );
}
