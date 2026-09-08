import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { useAIFullScreen, useAISidebar } from '../ui/ai-sidebar';
import { VoiceProvider } from '@/providers/voice-provider';
import useComposeEditor from '@/hooks/use-compose-editor';
import { useRef, useCallback, useEffect } from 'react';
import type { useAgentChat } from 'agents/ai-react';
import { Markdown } from '@react-email/components';
import { TextShimmer } from '../ui/text-shimmer';
import { getAccountColor } from '@/lib/thread-ref';
import { useThread } from '@/hooks/use-threads';
import { MailLabels } from '../mail/mail-list';
import { cn, getEmailLogo } from '@/lib/utils';
import type { Message as AiMessage } from 'ai';
import type { Label } from '@/types';
import { VoiceButton } from '../voice-button';
import { EditorContent } from '@tiptap/react';
import { CurvedArrow } from '../icons/icons';
import { Tools } from '../../types/tools';
import { format } from 'date-fns-tz';
import { parseAsString, useQueryState, useQueryStates } from 'nuqs';
import { Sparkles } from 'lucide-react';

const ThreadPreview = ({ threadId, connectionId }: { threadId: string; connectionId?: string }) => {
  const [, setThreadReference] = useQueryStates({
    threadId: parseAsString,
    connectionId: parseAsString,
  });
  const { data: getThread } = useThread(threadId, connectionId);
  const [, setIsFullScreen] = useQueryState('isFullScreen');

  const handleClick = () => {
    void setThreadReference({ threadId, connectionId: connectionId ?? null });
    void setIsFullScreen(null);
  };

  if (!getThread?.latest) return null;

  return (
    <div
      onClick={handleClick}
      key={threadId}
      className="hover:bg-offsetLight/30 dark:hover:bg-offsetDark/30 cursor-pointer rounded-lg"
    >
      <div className="flex cursor-pointer items-center justify-between p-2">
        <div className="flex w-full items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarImage
              className="rounded-full"
              src={getEmailLogo(getThread.latest?.sender?.email)}
            />
            <AvatarFallback className="rounded-full bg-[#FFFFFF] font-bold text-[#9F9F9F] dark:bg-[#373737]">
              {getThread.latest?.sender?.name?.[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex w-full flex-col gap-1.5">
            <div className="flex w-full items-center justify-between gap-2">
              <p className="max-w-[20ch] truncate text-sm font-medium text-black dark:text-white">
                {getThread.latest?.sender?.name}
              </p>
              <span className="max-w-[180px] truncate text-xs text-[#8C8C8C] dark:text-[#8C8C8C]">
                {getThread.latest.receivedOn ? format(getThread.latest.receivedOn, 'MMMM do') : ''}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="max-w-[220px] truncate text-xs text-[#8C8C8C] dark:text-[#8C8C8C]">
                {getThread.latest?.subject}
              </span>
              <MailLabels labels={getThread.latest?.tags || []} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

type MailboxSearchSource = {
  threadId: string;
  connectionId: string;
  accountEmail: string;
  accountName: string | null;
  subject: string;
  sender: { name: string; email: string };
  receivedOn: string;
  excerpt: string;
  provenance: 'semantic' | 'provider';
  unavailable: boolean;
};

type MailboxSearchResult = {
  sources: MailboxSearchSource[];
  searchedAccounts: number;
  failures: { accountEmail: string }[];
};

function isMailboxSearchResult(result: unknown): result is MailboxSearchResult {
  if (!result || typeof result !== 'object' || !('sources' in result)) return false;
  return Array.isArray(result.sources) && result.sources.every((source) => {
    return !!source && typeof source === 'object' &&
      'threadId' in source && typeof source.threadId === 'string' &&
      'connectionId' in source && typeof source.connectionId === 'string';
  });
}

function hasLabels(result: unknown): result is { labels: Label[] } {
  if (!result || typeof result !== 'object' || !('labels' in result)) return false;
  return Array.isArray(result.labels) && result.labels.every((label) => {
    return !!label && typeof label === 'object' &&
      'id' in label && typeof label.id === 'string' &&
      'name' in label && typeof label.name === 'string' &&
      'type' in label && typeof label.type === 'string';
  });
}

const SearchSourcePreview = ({ source }: { source: MailboxSearchSource }) => {
  const [, setThreadReference] = useQueryStates({
    threadId: parseAsString,
    connectionId: parseAsString,
  });
  const [, setIsFullScreen] = useQueryState('isFullScreen');
  const sender = source.sender.name || source.sender.email || 'Unknown sender';

  const handleClick = () => {
    if (source.unavailable) return;
    void setThreadReference({
      threadId: source.threadId,
      connectionId: source.connectionId,
    });
    void setIsFullScreen(null);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={source.unavailable}
      className={cn(
        'w-full rounded-lg p-2 text-left transition-colors',
        source.unavailable
          ? 'cursor-default opacity-60'
          : 'hover:bg-offsetLight/50 dark:hover:bg-offsetDark/40',
      )}
    >
      <div className="flex items-start gap-3">
        <Avatar className="mt-0.5 h-8 w-8 shrink-0">
          <AvatarImage className="rounded-full" src={getEmailLogo(source.sender.email)} />
          <AvatarFallback className="rounded-full bg-white font-bold text-[#9F9F9F] dark:bg-[#373737]">
            {sender[0]?.toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium text-black dark:text-white">{sender}</p>
            <span className="shrink-0 text-xs text-[#8C8C8C]">
              {source.receivedOn ? format(source.receivedOn, 'MMMM do') : ''}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-[#686868] dark:text-[#A0A0A0]">
            {source.subject}
          </p>
          {source.excerpt ? (
            <p className="mt-1 line-clamp-2 text-xs leading-4 text-[#8C8C8C]">{source.excerpt}</p>
          ) : null}
          <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] text-[#8C8C8C]">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: getAccountColor(source.connectionId) }}
            />
            <span className="truncate">{source.accountEmail}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">
              {source.unavailable
                ? 'Thread unavailable'
                : source.provenance === 'semantic'
                  ? 'Semantic match'
                  : 'Mailbox match'}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
};

const ExampleQueries = ({ onQueryClick }: { onQueryClick: (query: string) => void }) => {
  const firstRowQueries = [
    'Find all work meetings today',
    'Label all emails from Github as OSS',
    'Show recent Linear feedback',
  ];

  const secondRowQueries = ['Find receipt from OpenAI', 'What Asana projects do I have coming up'];

  return (
    <div className="relative mt-6 flex w-full max-w-xl flex-col items-center gap-2">
      {/* First row */}
      <div className="no-scrollbar relative flex w-full justify-center overflow-x-auto">
        <div className="flex gap-4 px-4">
          {firstRowQueries.map((query) => (
            <button
              key={query}
              onClick={() => onQueryClick(query)}
              className="shrink-0 whitespace-nowrap rounded-md bg-[#f0f0f0] p-1 px-2 text-sm text-[#555555] dark:bg-[#262626] dark:text-[#929292]"
            >
              {query}
            </button>
          ))}
        </div>
      </div>
      {/* Second row */}
      <div className="no-scrollbar relative flex w-full justify-center overflow-x-auto">
        <div className="flex gap-4 px-4">
          {secondRowQueries.map((query) => (
            <button
              key={query}
              onClick={() => onQueryClick(query)}
              className="shrink-0 whitespace-nowrap rounded-md bg-[#f0f0f0] p-1 px-2 text-sm text-[#555555] dark:bg-[#262626] dark:text-[#929292]"
            >
              {query}
            </button>
          ))}
        </div>
      </div>
      {/* Left mask */}
      <div className="from-panelLight dark:from-panelDark bg-linear-to-r pointer-events-none absolute bottom-0 left-0 top-0 w-12 to-transparent"></div>
      {/* Right mask */}
      <div className="from-panelLight dark:from-panelDark bg-linear-to-l pointer-events-none absolute bottom-0 right-0 top-0 w-12 to-transparent"></div>
    </div>
  );
};

// interface Message {
//   id: string;
//   role: 'user' | 'assistant' | 'data' | 'system';
//   parts: Array<{
//     type: string;
//     text?: string;
//     toolInvocation?: {
//       toolName: string;
//       result?: {
//         threads?: Array<{ id: string; title: string; snippet: string }>;
//       };
//       args?: any;
//     };
//   }>;
// }

export interface AIChatProps {
  messages: AiMessage[];
  input: string;
  setInput: (input: string) => void;
  error?: Error;
  handleSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  status: string;
  stop: () => void;
  className?: string;
  onModelChange?: (model: string) => void;
  setMessages: (messages: AiMessage[]) => void;
}

// Subcomponents for ToolResponse
const GetThreadToolResponse = ({ result, args }: { result: unknown; args: unknown }) => {
  // Extract threadId from result or args
  let threadId: string | null = null;
  let connectionId: string | undefined;
  if (typeof result === 'string') {
    const match = result.match(/<thread id="([^"]+)"(?: connectionId="([^"]+)")? ?\/>/);
    if (match?.[1]) threadId = match[1];
    if (match?.[2]) connectionId = match[2];
  }
  if (
    !threadId &&
    args &&
    typeof args === 'object' &&
    'id' in args &&
    typeof args.id === 'string'
  ) {
    threadId = args.id;
  }
  if (
    !connectionId &&
    args &&
    typeof args === 'object' &&
    'connectionId' in args &&
    typeof args.connectionId === 'string'
  ) {
    connectionId = args.connectionId;
  }
  if (!threadId) return null;
  return <ThreadPreview threadId={threadId} connectionId={connectionId} />;
};

const GetUserLabelsToolResponse = ({ result }: { result: unknown }) => {
  if (!hasLabels(result)) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {result.labels.map((label) => (
        <MailLabels key={label.id} labels={[label]} />
      ))}
    </div>
  );
};

const ComposeEmailToolResponse = ({ result }: { result: unknown }) => {
  if (
    !result ||
    typeof result !== 'object' ||
    !('newBody' in result) ||
    typeof result.newBody !== 'string'
  ) {
    return null;
  }
  return (
    <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <div className="prose dark:prose-invert max-w-none">
        <Markdown>{result.newBody}</Markdown>
      </div>
    </div>
  );
};

const MailboxSearchToolResponse = ({ result }: { result: unknown }) => {
  if (!isMailboxSearchResult(result)) return null;
  const failures = Array.isArray(result.failures) ? result.failures : [];

  return (
    <div className="mt-1 rounded-xl border border-black/10 p-1 dark:border-white/10">
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-[#8C8C8C]">
        <span>
          {result.sources.length} source{result.sources.length === 1 ? '' : 's'} ·{' '}
          {result.searchedAccounts} account{result.searchedAccounts === 1 ? '' : 's'} searched
        </span>
        {failures.length ? <span className="text-amber-600">Partial results</span> : null}
      </div>
      <div className="divide-y divide-black/5 dark:divide-white/5">
        {result.sources.map((source: MailboxSearchSource) => (
          <SearchSourcePreview
            key={`${source.connectionId}:${source.threadId}`}
            source={source}
          />
        ))}
      </div>
      {failures.length ? (
        <p className="px-2 py-1.5 text-xs text-[#8C8C8C]">
          Couldn&apos;t search{' '}
          {failures
            .map((failure) => failure.accountEmail)
            .join(', ')}
          .
        </p>
      ) : null}
    </div>
  );
};

// Main ToolResponse switcher
const ToolResponse = ({
  toolName,
  result,
  args,
}: {
  toolName: string;
  result: unknown;
  args: unknown;
}) => {
  switch (toolName) {
    case Tools.GetThread:
      return <GetThreadToolResponse result={result} args={args} />;
    case Tools.GetUserLabels:
      return <GetUserLabelsToolResponse result={result} />;
    case Tools.ComposeEmail:
      return <ComposeEmailToolResponse result={result} />;
    case Tools.SearchMailbox:
      return <MailboxSearchToolResponse result={result} />;
    default:
      return null;
  }
};

export function AIChat({
  messages,
  setInput,
  error,
  handleSubmit,
  status,
}: ReturnType<typeof useAgentChat>): React.ReactElement {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const { isFullScreen } = useAIFullScreen();
  const [aiSidebarOpen] = useQueryState('aiSidebar');
  const { toggleOpen } = useAISidebar();

  const scrollToBottom = useCallback(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    if (!['submitted', 'streaming'].includes(status)) {
      scrollToBottom();
    }
  }, [status, scrollToBottom]);

  const editor = useComposeEditor({
    placeholder: 'Ask the mail assistant anything...',
    onLengthChange: () => setInput(editor.getText()),
    onKeydown(event) {
      if (event.key === '0' && event.metaKey) {
        return toggleOpen();
      }

      if (event.key === 'Enter' && !event.metaKey && !event.shiftKey) {
        onSubmit(event as unknown as React.FormEvent<HTMLFormElement>);
      }
    },
  });

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    handleSubmit(e);
    editor.commands.clearContent(true);
    setTimeout(() => {
      scrollToBottom();
    }, 100);
  };

  const handleQueryClick = (query: string) => {
    editor.commands.setContent(query);
    setInput(query);
    editor.commands.focus();
  };

  useEffect(() => {
    if (aiSidebarOpen === 'true') {
      editor.commands.focus();
    }
  }, [aiSidebarOpen, editor]);

  return (
    <div className={cn('flex h-full flex-col', isFullScreen ? 'mx-auto max-w-xl' : '')}>
      <div className="no-scrollbar flex-1 overflow-y-auto" ref={messagesContainerRef}>
        <div className="min-h-full px-2 py-4">
          {!messages.length ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="relative mb-4 flex h-[44px] w-[44px] items-center justify-center">
                <Sparkles aria-hidden="true" className="h-8 w-8" />
              </div>
              <p className="mb-1 mt-2 hidden text-center text-sm font-medium text-black md:block dark:text-white">
                Ask anything about your emails
              </p>
              <p className="mb-3 text-center text-sm text-[#8C8C8C] dark:text-[#929292]">
                Ask to do or show anything using natural language
              </p>

              {/* Example Thread */}
              <ExampleQueries onQueryClick={handleQueryClick} />
            </div>
          ) : (
            messages.map((message, index) => {
              const textParts = message.parts.filter((part) => part.type === 'text');
              const toolParts = message.parts.filter((part) => part.type === 'tool-invocation');
              const sourceParts = toolParts.filter(
                (part) => part.toolInvocation?.toolName === Tools.SearchMailbox,
              );
              const otherToolParts = toolParts.filter(
                (part) => part.toolInvocation?.toolName !== Tools.SearchMailbox,
              );

              return (
                <div key={`${message.id}-${index}`} className="mb-2 flex flex-col" data-message-role={message.role}>
                  {otherToolParts.map((part, index) => {
                    const invocation = part.toolInvocation;
                    if (!invocation || !('result' in invocation) || invocation.result == null) {
                      return null;
                    }
                    return (
                      <ToolResponse
                        key={`${invocation.toolName}-${index}`}
                        toolName={invocation.toolName}
                        result={invocation.result}
                        args={invocation.args}
                      />
                    );
                  })}
                  {textParts.length > 0 && (
                    <div
                      className={cn(
                        'flex w-fit flex-col gap-2 rounded-lg text-sm',
                        message.role === 'user'
                          ? 'overflow-wrap-anywhere text-offsetDark dark:text-subtleWhite ml-auto break-words bg-[#f0f0f0] px-2 py-1 dark:bg-[#252525]'
                          : 'overflow-wrap-anywhere mr-auto break-words p-2',
                      )}
                    >
                      {textParts.map(
                        (part) =>
                          part.text && (
                            <Markdown
                              markdownCustomStyles={{
                                h1: { fontSize: '1rem' },
                                h2: { fontSize: '1rem' },
                                h3: { fontSize: '1rem' },
                                h4: { fontSize: '1rem' },
                                h5: { fontSize: '1rem' },
                                h6: { fontSize: '1rem' },
                                p: { fontSize: '1rem' },
                                li: {
                                  fontSize: '1rem',
                                  marginBottom: '0.25rem',
                                  listStyleType: 'disc',
                                  listStylePosition: 'inside',
                                },
                                ul: { fontSize: '1rem' },
                                ol: { fontSize: '1rem' },
                                blockQuote: { fontSize: '1rem' },
                                codeBlock: { fontSize: '1rem' },
                                codeInline: { fontSize: '1rem' },
                                link: { fontSize: '1rem' },
                                image: { fontSize: '1rem' },
                              }}
                              key={part.text}
                            >
                              {part.text || ' '}
                            </Markdown>
                          ),
                      )}
                    </div>
                  )}
                  {sourceParts.map((part, index) => {
                    const invocation = part.toolInvocation;
                    if (!invocation || !('result' in invocation) || invocation.result == null) {
                      return null;
                    }
                    return (
                      <ToolResponse
                        key={`${invocation.toolName}-${index}`}
                        toolName={invocation.toolName}
                        result={invocation.result}
                        args={invocation.args}
                      />
                    );
                  })}
                </div>
              );
            })
          )}

          {(status === 'submitted' || status === 'streaming') && (
            <div className="absolute bottom-0 ml-2 flex items-center gap-2">
              <TextShimmer className="text-muted-foreground text-xs">
                Assistant is thinking...
              </TextShimmer>
            </div>
          )}
          {(status === 'error' || !!error) && (
            <div className="text-sm text-red-500">Error, please try again later</div>
          )}
          <div className="h-0 w-0" ref={messagesEndRef} />
        </div>
      </div>

      {/* Fixed input at bottom */}
      <div className={cn('mb-4 shrink-0 px-4', isFullScreen ? 'px-0' : '')}>
        <div className="bg-offsetLight relative rounded-lg p-2 dark:bg-[#202020]">
          <div className="flex flex-col">
            <div className="w-full">
              <form id="ai-chat-form" onSubmit={onSubmit} className="relative">
                <div className="grow self-stretch overflow-y-auto outline-white/5 dark:bg-[#202020]">
                  <div
                    onClick={() => {
                      editor.commands.focus();
                    }}
                    className={cn('max-h-[100px] w-full')}
                  >
                    <EditorContent editor={editor} className="h-full w-full" />
                  </div>
                </div>
              </form>
            </div>
            <div className="grid">
              <div className="flex justify-end gap-1">
                <VoiceProvider>
                  <VoiceButton />
                </VoiceProvider>
                <button
                  form="ai-chat-form"
                  type="submit"
                  className="inline-flex cursor-pointer gap-1.5 rounded-lg"
                >
                  <div className="dark:bg[#141414] flex h-7 items-center justify-center gap-1 rounded-sm bg-[#262626] px-2 pr-1">
                    <CurvedArrow className="mt-1.5 h-4 w-4 fill-white dark:fill-[#929292]" />
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* <div className="flex items-center justify-end gap-1">
        <div className="mt-1 flex items-center justify-end relative z-10">
          <Select

          >
            <SelectTrigger className="flex h-6 w-fit cursor-pointer items-center justify-between gap-1 border-0 dark:bg-[#141414] px-2 text-xs hover:bg-[#1E1E1E]">
              <div className="flex items-center gap-1.5 w-full">
                <Puzzle className="h-3.5 w-3.5 fill-white dark:fill-[#929292]" />
              </div>

            </SelectTrigger>
            <SelectContent className="w-[190px] rounded-md border-0 bg-[#1E1E1E] p-0.5 shadow-md">
              <SelectItem
                value="gpt-3.5"
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-[#2A2A2A]"
              >
                <div className="flex items-center gap-1.5 pl-6">
                  <img src="/openai.png" alt="OpenAI" className="h-3.5 w-3.5 dark:invert" />
                  <span className="whitespace-nowrap">GPT 3.5</span>
                </div>
              </SelectItem>
              <SelectItem
                value="claude-3.5"
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-[#2A2A2A]"
              >
                <div className="flex items-center gap-1.5 pl-6">
                  <img src="/claude.png" alt="Claude" className="h-3.5 w-3.5" />
                  <span className="whitespace-nowrap">Claude 3.5</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="mt-1 flex items-center justify-end relative z-10">
          <Select
            value={selectedModel}
            onValueChange={(value) => {
              setSelectedModel(value);
              onModelChange?.(value);
            }}
          >
            <SelectTrigger className="flex h-6 w-fit cursor-pointer items-center justify-between gap-1 border-0 dark:bg-[#141414] px-2 text-xs hover:bg-[#1E1E1E]">
              <div className="flex items-center gap-1.5 w-full">
                {selectedModel === 'gpt-3.5' ? (
                  <img src="/openai.png" alt="OpenAI" className="h-3.5 w-3.5 dark:invert" />
                ) : (
                  <img src="/claude.png" alt="Claude" className="h-3.5 w-3.5" />
                )}
              </div>

            </SelectTrigger>
            <SelectContent className="w-[190px] rounded-md border-0 bg-[#1E1E1E] p-0.5 shadow-md">
              <SelectItem
                value="gpt-3.5"
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-[#2A2A2A]"
              >
                <div className="flex items-center gap-1.5 pl-6">
                  <img src="/openai.png" alt="OpenAI" className="h-3.5 w-3.5 dark:invert" />
                  <span className="whitespace-nowrap">GPT 3.5</span>
                </div>
              </SelectItem>
              <SelectItem
                value="claude-3.5"
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-[#2A2A2A]"
              >
                <div className="flex items-center gap-1.5 pl-6">
                  <img src="/claude.png" alt="Claude" className="h-3.5 w-3.5" />
                  <span className="whitespace-nowrap">Claude 3.5</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        </div> */}
      </div>
    </div>
  );
}
