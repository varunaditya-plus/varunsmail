import { describe, expect, it } from 'vitest';

import { applyEmailPreferences, processEmailHtml } from './email-processor';

const options = {
  shouldLoadImages: true,
  theme: 'light' as const,
};

describe('email tracking protection', () => {
  it('preserves tracker and redirect behavior when protection is disabled', () => {
    const html = `
      <a href="https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fstory">Story</a>
      <img src="https://track.hubspot.com/__ptq.gif?id=123" width="20" height="20">
      <img src="https://example.com/legacy.gif" width="1" height="1">
    `;

    const result = processEmailHtml({ html, ...options });

    expect(result.blockedTrackerCount).toBe(0);
    expect(result.processedHtml).toContain('https://www.google.com/url?q=');
    expect(result.processedHtml).toContain('https://track.hubspot.com/__ptq.gif?id=123');
    expect(result.processedHtml).not.toContain('legacy.gif');
  });

  it('removes common tracking pixels while keeping ordinary remote images', () => {
    const html = `
      <img src="https://example.com/tiny.gif" width="1" height="1">
      <img src="https://example.com/two-pixel.gif" width="2" height="2">
      <img src="https://example.com/hidden.gif" style="width: 0px; height: 1px">
      <img src="https://example.com/invisible.gif" style="display: none">
      <img src="https://track.hubspot.com/__ptq.gif?id=123" width="600" height="200">
      <img src="https://example.com/logo.png" width="120" height="40">
    `;

    const result = processEmailHtml({ html, ...options, trackingProtection: true });

    expect(result.blockedTrackerCount).toBe(5);
    expect(result.hasBlockedImages).toBe(false);
    expect(result.processedHtml).not.toContain('tiny.gif');
    expect(result.processedHtml).not.toContain('two-pixel.gif');
    expect(result.processedHtml).not.toContain('hidden.gif');
    expect(result.processedHtml).not.toContain('invisible.gif');
    expect(result.processedHtml).not.toContain('__ptq.gif');
    expect(result.processedHtml).toContain('https://example.com/logo.png');
  });

  it('unwraps known redirectors only when their destination is HTTP(S)', () => {
    const html = `
      <a id="google" href="https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fstory%3Fa%3D1">Google</a>
      <a id="outlook" href="https://nam01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.org%2Fdocs&amp;data=abc">Outlook</a>
      <a id="unsafe" href="https://www.google.com/url?q=javascript%3Aalert(1)">Unsafe</a>
      <a id="ordinary" href="https://example.net/redirect?url=https%3A%2F%2Fexample.com">Ordinary</a>
    `;

    const result = processEmailHtml({ html, ...options, trackingProtection: true });

    expect(result.processedHtml).toContain('href="https://example.com/story?a=1"');
    expect(result.processedHtml).toContain(
      'href="https://nam01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.org%2Fdocs&amp;data=abc"',
    );
    expect(result.processedHtml).toContain(
      'href="https://www.google.com/url?q=javascript%3Aalert(1)"',
    );
    expect(result.processedHtml).toContain(
      'href="https://example.net/redirect?url=https%3A%2F%2Fexample.com"',
    );
  });

  it('reports trackers separately from ordinary blocked remote images', () => {
    const html = `
      <img src="https://mandrillapp.com/track/open.php?id=123" width="20" height="20">
      <img src="https://example.com/photo.jpg" width="600" height="400">
      <img src="cid:inline-logo" width="120" height="40">
    `;

    const result = processEmailHtml({
      html,
      theme: 'dark',
      shouldLoadImages: false,
      trackingProtection: true,
    });

    expect(result.blockedTrackerCount).toBe(1);
    expect(result.hasBlockedImages).toBe(true);
    expect(result.processedHtml).not.toContain('track/open.php');
    expect(result.processedHtml).toContain('blocked image: https://example.com/photo.jpg');
    expect(result.processedHtml).toContain('src="cid:inline-logo"');
  });

  it('supports protection when preferences are applied to cached preprocessed HTML', () => {
    const result = applyEmailPreferences(
      '<img src="https://email.sendgrid.net/wf/open?id=123" width="50" height="50">',
      'light',
      true,
      true,
    );

    expect(result.blockedTrackerCount).toBe(1);
    expect(result.processedHtml).not.toContain('/wf/open');
  });
});
