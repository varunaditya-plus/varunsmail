import { describe, expect, it } from 'vitest';

import { extractMailboxLinks } from './mailbox-assets';

describe('mailbox asset link protection', () => {
  const html = `
    <a href="https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fstory">Story</a>
    <a href="https://nam01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.org%2Fdocs&amp;data=abc">Protected</a>
  `;

  it('normalizes tracking redirects while keeping security gateways intact', () => {
    const links = extractMailboxLinks([html], true);

    expect(links.map(({ url }) => url)).toEqual([
      'https://example.com/story',
      'https://nam01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.org%2Fdocs&data=abc',
    ]);
  });

  it('preserves tracking redirects when protection is disabled', () => {
    const links = extractMailboxLinks([html], false);

    expect(links[0]?.url).toContain('https://www.google.com/url?q=');
  });
});
