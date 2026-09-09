import { describe, expect, it } from 'vitest';

import { getListUnsubscribeAction } from './email-utils';

describe('List-Unsubscribe parsing', () => {
  it('uses the first supported action and skips malformed candidates', () => {
    expect(
      getListUnsubscribeAction({
        listUnsubscribe: '<not a url>, <mailto:leave@example.com?subject=Remove%20me>',
      }),
    ).toEqual({
      type: 'email',
      emailAddress: 'leave@example.com',
      subject: 'Remove me',
      host: '',
    });
  });

  it('rejects lookalike HTTP protocols', () => {
    expect(getListUnsubscribeAction({ listUnsubscribe: '<httpx://example.com/leave>' })).toBeNull();
  });

  it('only creates a one-click POST for an HTTPS RFC 8058 request', () => {
    expect(
      getListUnsubscribeAction({
        listUnsubscribe: '<https://example.com/leave>',
        listUnsubscribePost: 'List-Unsubscribe=One-Click',
      }),
    ).toEqual({
      type: 'post',
      url: 'https://example.com/leave',
      body: 'List-Unsubscribe=One-Click',
      host: 'example.com',
    });
    expect(
      getListUnsubscribeAction({
        listUnsubscribe: '<http://example.com/leave>',
        listUnsubscribePost: 'List-Unsubscribe=One-Click',
      }),
    ).toMatchObject({ type: 'get' });
  });
});
