import { useTemplates } from '@/hooks/use-templates';
import { useTRPC } from '@/providers/query-provider';
import { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Save, Trash2 } from 'lucide-react';
import React, { useState, useMemo, useDeferredValue, useCallback, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { TRPCClientError } from '@trpc/client';
import { TEMPLATE_VARIABLES, prepareTemplate } from '@/lib/template-variables';

type EmailTemplate = {
  id: string;
  userId: string;
  name: string;
  kind?: 'template' | 'snippet';
  subject: string | null;
  body: string | null;
  to: string[] | null;
  cc: string[] | null;
  bcc: string[] | null;
  createdAt: Date;
  updatedAt: Date;
};

type RecipientField = 'to' | 'cc' | 'bcc';

interface TemplateButtonProps {
  editor: Editor | null;
  subject: string;
  setSubject: (value: string) => void;
  to: string[];
  cc: string[];
  bcc: string[];
  senderEmail?: string;
  senderName?: string;
  setRecipients: (field: RecipientField, value: string[]) => void;
}

const TemplateButtonComponent: React.FC<TemplateButtonProps> = ({
  editor,
  subject,
  setSubject,
  to,
  cc,
  bcc,
  senderEmail,
  senderName,
  setRecipients,
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const templatesQuery = useTemplates();
  const { data } = templatesQuery;
  
  const templates = useMemo(() => (data?.templates ?? []) as EmailTemplate[], [data?.templates]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [search, setSearch] = useState('');
  const [saveKind, setSaveKind] = useState<'template' | 'snippet'>('template');
  const selectionRef = useRef({ from: 0, to: 0 });

  const deferredSearch = useDeferredValue(search);

  const filteredTemplates = useMemo(() => {
    if (!deferredSearch.trim()) return templates;
    return templates.filter((t) =>
      t.name.toLowerCase().includes(deferredSearch.toLowerCase()),
    );
  }, [deferredSearch, templates]);

  const templatesById = useMemo(() => {
    return new Map(templates.map((t) => [t.id, t] as const));
  }, [templates]);

  const { mutateAsync: createTemplate } = useMutation(trpc.templates.create.mutationOptions());
  const { mutateAsync: deleteTemplateMutation } = useMutation(
    trpc.templates.delete.mutationOptions(),
  );

  const handleSaveTemplate = async () => {
    if (!editor) return;
    if (!templateName.trim()) {
      toast.error('Please provide a name');
      return;
    }

    setIsSaving(true);
    try {
      const isSnippet = saveKind === 'snippet';
      const normalizedSubject = subject.trim() ? subject : null;
      await createTemplate({
        name: templateName.trim(),
        kind: saveKind,
        body: editor.getHTML(),
        ...(!isSnippet && to.length ? { to } : {}),
        ...(!isSnippet && cc.length ? { cc } : {}),
        ...(!isSnippet && bcc.length ? { bcc } : {}),
        ...(!isSnippet && normalizedSubject !== null ? { subject: normalizedSubject } : {}),
      });
      await queryClient.invalidateQueries({
        queryKey: trpc.templates.list.queryKey(),
      });
      toast.success(`${isSnippet ? 'Snippet' : 'Template'} saved`);
      setTemplateName('');
      setSaveDialogOpen(false);
    } catch (error) {
      if (error instanceof TRPCClientError) {
        toast.error(error.message);
      } else {
        toast.error('Failed to save template');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleApplyTemplate = useCallback((template: EmailTemplate) => {
    if (!editor) return;

    const application = prepareTemplate(template, {
      recipientEmail: template.to?.[0] ?? to[0],
      senderEmail,
      senderName,
    });

    if (application.insertAtSelection) {
      if (application.body) {
        editor
          .chain()
          .focus()
          .setTextSelection(selectionRef.current)
          .insertContent(application.body)
          .run();
      }
      return;
    }

    if (application.subject) setSubject(application.subject);
    if (application.body) editor.commands.setContent(application.body, false);
    if (template.to) setRecipients('to', template.to);
    if (template.cc) setRecipients('cc', template.cc);
    if (template.bcc) setRecipients('bcc', template.bcc);
    setTimeout(() => editor.chain().focus('end').run(), 200);
  }, [editor, senderEmail, senderName, setSubject, setRecipients, to]);

  const handleMenuOpenChange = useCallback((open: boolean) => {
    if (open && editor) {
      selectionRef.current = {
        from: editor.state.selection.from,
        to: editor.state.selection.to,
      };
    }
    setMenuOpen(open);
  }, [editor]);

  const handleDeleteTemplate = useCallback(
    async (templateId: string) => {
      try {
        await deleteTemplateMutation({ id: templateId });
        await queryClient.invalidateQueries({
          queryKey: trpc.templates.list.queryKey(),
        });
        toast.success('Template deleted');
      } catch (err) {
        if (err instanceof TRPCClientError) {
          toast.error(err.message);
        } else {
          toast.error('Failed to delete template');
        }
      }
    },
    [deleteTemplateMutation, queryClient, trpc.templates.list],
  );

  const handleTemplateItemClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const templateId = (e.currentTarget as HTMLElement).dataset.templateId;
      if (!templateId) return;
      const template = templatesById.get(templateId);
      if (!template) return;
      handleApplyTemplate(template);
      setMenuOpen(false);
    },
    [handleApplyTemplate, templatesById],
  );

  const handleDeleteButtonClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      setMenuOpen(false);
      const templateId = (e.currentTarget as HTMLButtonElement).dataset.templateId;
      if (!templateId) return;
      const template = templatesById.get(templateId);
      const templateName = template?.name ?? 'this template';
      toast(`Delete template "${templateName}"?`, {
        duration: 10000,
        action: {
          label: 'Delete',
          onClick: () => handleDeleteTemplate(templateId),
        },
        className: 'pointer-events-auto',
        style: {
          pointerEvents: 'auto',
        },
      });
    },
    [templatesById, handleDeleteTemplate],
  );

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button type="button" size={'xs'} variant={'secondary'} className="bg-background border hover:bg-gray-50 dark:hover:bg-[#404040] transition-colors cursor-pointer" disabled={isSaving}>
            Templates
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="z-99999 w-60" align="start" sideOffset={6}>
          <DropdownMenuItem
            onSelect={() => {
              setMenuOpen(false);
              setSaveKind('template');
              setSaveDialogOpen(true);
            }}
            disabled={isSaving}
          >
            <Save className="mr-2 h-3.5 w-3.5" /> Save current as template
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setMenuOpen(false);
              setSaveKind('snippet');
              setSaveDialogOpen(true);
            }}
            disabled={isSaving}
          >
            <span className="mr-2 text-xs">{'{ }'}</span> Save message as snippet
          </DropdownMenuItem>
          {templatesQuery.isLoading ? (
            <DropdownMenuItem disabled>Loading saved items…</DropdownMenuItem>
          ) : templatesQuery.isError ? (
            <DropdownMenuItem
              disabled={templatesQuery.isFetching}
              onSelect={(event) => {
                event.preventDefault();
                void templatesQuery.refetch();
              }}
            >
              {templatesQuery.isFetching ? 'Trying again…' : 'Could not load saved items · Try again'}
            </DropdownMenuItem>
          ) : templates.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FileText className="mr-2 h-3.5 w-3.5" /> Use saved
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="z-99999 w-60">
                <div className="p-2 border-b border-border sticky top-0 bg-background">
                  <Input
                    placeholder="Search..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 text-sm"
                    autoFocus
                  />
                </div>
                <div className="max-h-30 overflow-y-auto">
                  {filteredTemplates.map((t) => (
                    <DropdownMenuItem
                      key={t.id}
                      data-template-id={t.id}
                      className="flex items-center justify-between gap-2"
                      onClick={handleTemplateItemClick}
                    >
                      <span className="flex-1 truncate text-left">{t.name}</span>
                      <span className="text-muted-foreground text-[10px] capitalize">
                        {t.kind ?? 'template'}
                      </span>
                      <button
                        className="p-0.5 text-muted-foreground hover:text-destructive"
                        data-template-id={t.id}
                        onClick={handleDeleteButtonClick}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuItem>
                  ))}
                  {filteredTemplates.length === 0 && (
                    <div className="p-2 text-xs text-muted-foreground">No saved items</div>
                  )}
                </div>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            <DropdownMenuItem disabled>No saved items yet</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent showOverlay>
          <DialogHeader>
            <DialogTitle>Save as {saveKind === 'snippet' ? 'Snippet' : 'Template'}</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-2">
            <Input
              placeholder={`${saveKind === 'snippet' ? 'Snippet' : 'Template'} name`}
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              autoFocus
            />
            {saveKind === 'snippet' ? (
              <p className="text-muted-foreground text-xs leading-5">
                Snippets insert at the cursor. Available variables:{' '}
                {TEMPLATE_VARIABLES.map(({ token }) => token).join(', ')}
              </p>
            ) : null}
          </div>
          <DialogFooter className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSaveDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSaveTemplate} disabled={isSaving}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export const TemplateButton = React.memo(TemplateButtonComponent);
