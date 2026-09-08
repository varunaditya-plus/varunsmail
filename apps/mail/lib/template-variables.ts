export const TEMPLATE_VARIABLES = [
  { token: '{{recipient_name}}', label: 'Recipient name' },
  { token: '{{recipient_email}}', label: 'Recipient email' },
  { token: '{{sender_name}}', label: 'Sender name' },
  { token: '{{sender_email}}', label: 'Sender email' },
  { token: '{{date}}', label: 'Date' },
  { token: '{{day}}', label: 'Day' },
];

type TemplateVariableContext = {
  recipientEmail?: string;
  recipientName?: string;
  senderEmail?: string;
  senderName?: string;
  now?: Date;
  locale?: string;
};

function nameFromEmail(email?: string) {
  const localPart = email?.split('@')[0]?.split('+')[0];
  if (!localPart) return '';
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

function getTemplateValues(context: TemplateVariableContext) {
  const now = context.now ?? new Date();
  const recipientName = context.recipientName?.trim() || nameFromEmail(context.recipientEmail);
  const senderName = context.senderName?.trim() || nameFromEmail(context.senderEmail);

  return {
    '{{recipient_name}}': recipientName,
    '{{recipient_email}}': context.recipientEmail ?? '',
    '{{sender_name}}': senderName,
    '{{sender_email}}': context.senderEmail ?? '',
    '{{date}}': new Intl.DateTimeFormat(context.locale, { dateStyle: 'long' }).format(now),
    '{{day}}': new Intl.DateTimeFormat(context.locale, { weekday: 'long' }).format(now),
  };
}

function resolveTemplateVariables(
  value: string,
  context: TemplateVariableContext,
  html: boolean,
) {
  const values = getTemplateValues(context);
  return Object.entries(values).reduce((resolved, [token, replacement]) => {
    if (!replacement) return resolved;
    return resolved.replaceAll(token, html ? escapeHtml(replacement) : replacement);
  }, value);
}

export function prepareTemplate(
  template: { kind?: string; subject: string | null; body: string | null },
  context: TemplateVariableContext,
) {
  if (template.kind !== 'snippet') {
    return {
      subject: template.subject,
      body: template.body,
      insertAtSelection: false,
    };
  }

  return {
    subject: template.subject
      ? resolveTemplateVariables(template.subject, context, false)
      : template.subject,
    body: template.body ? resolveTemplateVariables(template.body, context, true) : template.body,
    insertAtSelection: true,
  };
}
