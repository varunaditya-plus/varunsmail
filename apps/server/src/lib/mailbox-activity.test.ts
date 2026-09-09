import { describe, expect, it } from 'vitest';

import { parseOutboxState } from './mailbox-activity';

describe('outbox state', () => {
  it('recognizes sent messages so queue redelivery can skip the provider send', () => {
    expect(parseOutboxState('{"status":"sent","attempts":1}')).toEqual({
      status: 'sent',
      attempts: 1,
    });
  });

  it('treats malformed state as pending', () => {
    expect(parseOutboxState('{not-json')).toEqual({ status: 'pending' });
  });
});
