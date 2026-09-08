import { describe, expect, it } from 'vitest';

import { prepareTemplate } from '../../mail/lib/template-variables';

describe('template variables', () => {
  it('keeps legacy templates unchanged and in full-template mode', () => {
    const template = { subject: 'Following up', body: '<p>Thanks for your time.</p>' };

    expect(prepareTemplate(template, {})).toEqual({
      ...template,
      insertAtSelection: false,
    });
  });

  it('resolves recipient, sender, date, and day variables in snippets', () => {
    const result = prepareTemplate(
      {
        kind: 'snippet',
        subject: 'Hello {{recipient_name}} on {{day}}',
        body:
          '<p>From {{sender_name}} ({{sender_email}}) to {{recipient_email}} on {{date}}</p>',
      },
      {
        recipientEmail: 'alex.morgan@example.com',
        senderEmail: 'varun@example.com',
        senderName: 'Varun Aditya',
        now: new Date('2026-09-09T12:00:00.000Z'),
        locale: 'en-GB',
      },
    );

    expect(result.subject).toBe('Hello Alex Morgan on Wednesday');
    expect(result.body).toBe(
      '<p>From Varun Aditya (varun@example.com) to alex.morgan@example.com on 9 September 2026</p>',
    );
    expect(result.insertAtSelection).toBe(true);
  });

  it('escapes variable values inserted into snippet HTML', () => {
    const result = prepareTemplate(
      {
        kind: 'snippet',
        subject: 'Hello {{recipient_name}}',
        body: '<p>Hello {{recipient_name}}</p>',
      },
      { recipientName: '<img src=x onerror=alert(1)>', recipientEmail: 'safe@example.com' },
    );

    expect(result.subject).toBe('Hello <img src=x onerror=alert(1)>');
    expect(result.body).toBe('<p>Hello &lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('leaves unavailable and unknown variables visible for manual completion', () => {
    const result = prepareTemplate(
      {
        kind: 'snippet',
        subject: '{{recipient_name}} {{project}}',
        body: '<p>{{recipient_email}} {{project}}</p>',
      },
      {},
    );

    expect(result.subject).toBe('{{recipient_name}} {{project}}');
    expect(result.body).toBe('<p>{{recipient_email}} {{project}}</p>');
  });

  it('does not resolve variables for a template without a kind', () => {
    const result = prepareTemplate(
      { subject: 'Hello {{recipient_name}}', body: '<p>Legacy body</p>' },
      { recipientName: 'Alex' },
    );

    expect(result.subject).toBe('Hello {{recipient_name}}');
    expect(result.body).toBe('<p>Legacy body</p>');
    expect(result.insertAtSelection).toBe(false);
  });
});
