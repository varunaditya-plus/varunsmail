// @ts-ignore
import { CssSanitizer } from '@barkleapp/css-sanitizer';
import sanitizeHtml from 'sanitize-html';
import * as cheerio from 'cheerio';

const sanitizer = new CssSanitizer();

interface ProcessEmailOptions {
  html: string;
  shouldLoadImages: boolean;
  theme: 'light' | 'dark';
  trackingProtection?: boolean;
}

function parseHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function isKnownTrackingUrl(value: string) {
  const url = parseHttpUrl(value);
  if (!url) return false;

  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  return (
    ((host === 'mandrillapp.com' || host.endsWith('.mandrillapp.com')) &&
      path.startsWith('/track/open')) ||
    (host.endsWith('.list-manage.com') && path.startsWith('/track/open')) ||
    (host.endsWith('.sendgrid.net') && path.startsWith('/wf/open')) ||
    ((host === 'track.hubspot.com' || host.endsWith('.track.hubspot.com')) &&
      path === '/__ptq.gif') ||
    ((host === 'www.google-analytics.com' || host === 'google-analytics.com') &&
      path === '/collect') ||
    ((host === 'www.facebook.com' || host === 'facebook.com') && path === '/tr') ||
    (host === 'track.customer.io' && path.startsWith('/e/o/')) ||
    (host === 'pstmrk.it' && path.startsWith('/open')) ||
    ((host.endsWith('.mailgun.org') || host.endsWith('.mailgun.net')) && path.startsWith('/o/'))
  );
}

function isTinyImage(width?: string, height?: string) {
  if (!width || !height) return false;

  const parseDimension = (value: string) =>
    Number(value.trim().toLowerCase().endsWith('px') ? value.trim().slice(0, -2) : value);
  const parsedWidth = parseDimension(width);
  const parsedHeight = parseDimension(height);
  return (
    Number.isFinite(parsedWidth) &&
    Number.isFinite(parsedHeight) &&
    parsedWidth >= 0 &&
    parsedWidth <= 2 &&
    parsedHeight >= 0 &&
    parsedHeight <= 2
  );
}

function unwrapRedirectUrl(value: string) {
  const wrapper = parseHttpUrl(value);
  if (!wrapper) return null;

  const host = wrapper.hostname.toLowerCase();
  const path = wrapper.pathname.toLowerCase();
  // Keep security gateways intact so their time-of-click protection still runs.
  if (
    host === 'safelinks.protection.outlook.com' ||
    host.endsWith('.safelinks.protection.outlook.com')
  ) {
    return null;
  }
  let destination: string | null = null;

  if ((host === 'google.com' || host === 'www.google.com') && path === '/url') {
    destination = wrapper.searchParams.get('q') || wrapper.searchParams.get('url');
  } else if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && path === '/l.php') {
    destination = wrapper.searchParams.get('u');
  } else if (
    (host === 'linkedin.com' || host === 'www.linkedin.com') &&
    path === '/redir/redirect'
  ) {
    destination = wrapper.searchParams.get('url');
  } else if ((host === 'youtube.com' || host === 'www.youtube.com') && path === '/redirect') {
    destination = wrapper.searchParams.get('q');
  }

  // Keep unknown wrappers and non-web destinations intact.
  const safeDestination = destination && parseHttpUrl(destination);
  return safeDestination?.toString() || null;
}

export function normalizeTrackingUrl(value: string, trackingProtection: boolean) {
  return trackingProtection ? unwrapRedirectUrl(value) || value : value;
}

function protectEmailHtml(html: string) {
  const $ = cheerio.load(html);
  let blockedTrackerCount = 0;

  $('img').each((_, el) => {
    const $img = $(el);
    const src = $img.attr('src') || '';
    const style = $img.attr('style') || '';
    const styleWidth = style.match(/(?:^|;)\s*width\s*:\s*([\d.]+)px(?:\s*!important)?/i)?.[1];
    const styleHeight = style.match(/(?:^|;)\s*height\s*:\s*([\d.]+)px(?:\s*!important)?/i)?.[1];

    if (
      isTinyImage($img.attr('width'), $img.attr('height')) ||
      isTinyImage(styleWidth, styleHeight) ||
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?)\s*(?:!important)?(?:;|$)/i.test(style) ||
      isKnownTrackingUrl(src)
    ) {
      blockedTrackerCount += 1;
      $img.remove();
    }
  });

  $('a[href]').each((_, el) => {
    const $link = $(el);
    const href = $link.attr('href') || '';
    const destination = normalizeTrackingUrl(href, true);
    if (destination !== href) $link.attr('href', destination);
  });

  return { html: $.html(), blockedTrackerCount };
}

// Server-side: Heavy lifting, preference-independent processing
function preprocessEmailContent(html: string, trackingProtection: boolean) {
  const sanitizeConfig: sanitizeHtml.IOptions = {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img',
      'title',
      'details',
      'summary',
      'style',
    ]),

    allowedAttributes: {
      '*': [
        'class',
        'style',
        'align',
        'valign',
        'width',
        'height',
        'cellpadding',
        'cellspacing',
        'border',
        'bgcolor',
        'colspan',
        'rowspan',
      ],
      a: ['href', 'name', 'target', 'rel', 'class', 'style'],
      img: ['src', 'alt', 'width', 'height', 'class', 'style'],
    },

    // Allow only safe schemes - no blob for security
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data', 'cid'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'data', 'cid'],
    },

    transformTags: {
      a: (tagName, attribs) => {
        return {
          tagName,
          attribs: {
            ...attribs,
            target: attribs.target || '_blank',
            rel: 'noopener noreferrer',
          },
        };
      },
    },
  };

  const sanitized = sanitizeHtml(html, sanitizeConfig);
  const $ = cheerio.load(sanitized);

  $('style').each((_, el) => {
    const css = $(el).html() || '';
    const safe = sanitizer.sanitizeCss(css, {
      allowedProperties: [
        'color',
        'background-color',
        'font-size',
        'margin',
        'padding',
        'text-align',
        'border',
        'display',
      ],
      disallowedAtRules: ['import', 'keyframes'],
      disallowedFunctions: ['expression', 'url'],
    });
    $(el).html(safe);
  });

  // Collapse quoted text (structure only, no theme colors)
  const collapseQuoted = (selector: string) => {
    $(selector).each((_, el) => {
      const $el = $(el);
      if ($el.parents('details.quoted-toggle').length) return;

      const innerHtml = $el.html();
      if (typeof innerHtml !== 'string') return;
      const detailsHtml = `<details class="quoted-toggle" style="margin-top:1em;">
          <summary style="cursor:pointer;" data-theme-color="muted">
            Show quoted text
          </summary>
          ${innerHtml}
        </details>`;

      $el.replaceWith(detailsHtml);
    });
  };

  collapseQuoted('blockquote');
  collapseQuoted('.gmail_quote');

  // Remove unwanted elements
  $('title').remove();
  const legacyTrackingPixels = $('img[width="1"][height="1"], img[width="0"][height="0"]');
  const legacyTrackerCount = trackingProtection ? legacyTrackingPixels.length : 0;
  legacyTrackingPixels.remove();

  // Remove preheader content
  $('.preheader, .preheaderText, [class*="preheader"]').each((_, el) => {
    const $el = $(el);
    const style = $el.attr('style') || '';
    if (
      style.includes('display:none') ||
      style.includes('display: none') ||
      style.includes('font-size:0') ||
      style.includes('font-size: 0') ||
      style.includes('line-height:0') ||
      style.includes('line-height: 0') ||
      style.includes('max-height:0') ||
      style.includes('max-height: 0') ||
      style.includes('mso-hide:all') ||
      style.includes('opacity:0') ||
      style.includes('opacity: 0')
    ) {
      $el.remove();
    }
  });

  if (!trackingProtection) return { html: $.html(), blockedTrackerCount: 0 };

  const protectedContent = protectEmailHtml($.html());
  return {
    ...protectedContent,
    blockedTrackerCount: legacyTrackerCount + protectedContent.blockedTrackerCount,
  };
}

export function preprocessEmailHtml(html: string): string {
  return preprocessEmailContent(html, false).html;
}

// Client-side: Light styling + image preferences
export function applyEmailPreferences(
  preprocessedHtml: string,
  theme: 'light' | 'dark',
  shouldLoadImages: boolean,
  trackingProtection = false,
): { processedHtml: string; hasBlockedImages: boolean; blockedTrackerCount: number } {
  let hasBlockedImages = false;
  const isDarkTheme = theme === 'dark';

  const protectedContent = trackingProtection
    ? protectEmailHtml(preprocessedHtml)
    : { html: preprocessedHtml, blockedTrackerCount: 0 };
  const $ = cheerio.load(protectedContent.html);

  // Handle image blocking if needed
  if (!shouldLoadImages) {
    $('img').each((_, el) => {
      const $img = $(el);
      const src = $img.attr('src');

      // Allow CID images (inline attachments)
      if (src && !src.startsWith('cid:')) {
        hasBlockedImages = true;
        $img.replaceWith(`<span style="display:none;"><!-- blocked image: ${src} --></span>`);
      }
    });
  }

  const html = $.html();

  // Apply theme-specific styles
  const themeStyles = `
    <style type="text/css">
      :host {
        display: block;
        line-height: 1.5;
        background-color: ${isDarkTheme ? '#1A1A1A' : '#ffffff'};
        color: ${isDarkTheme ? '#ffffff' : '#000000'};
      }

      *, *::before, *::after {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 0;
      }

      a {
        cursor: pointer;
        color: ${isDarkTheme ? '#60a5fa' : '#2563eb'};
        text-decoration: underline;
      }

      table {
        border-collapse: collapse;
      }

      ::selection {
        background: #b3d4fc;
        text-shadow: none;
      }

      /* Styling for collapsed quoted text */
      details.quoted-toggle {
        border-left: 2px solid ${isDarkTheme ? '#374151' : '#d1d5db'};
        padding-left: 8px;
        margin-top: 0.75rem;
      }

      details.quoted-toggle summary {
        cursor: pointer;
        color: ${isDarkTheme ? '#9CA3AF' : '#6B7280'};
        list-style: none;
        user-select: none;
      }

      details.quoted-toggle summary::-webkit-details-marker {
        display: none;
      }

      [data-theme-color="muted"] {
        color: ${isDarkTheme ? '#9CA3AF' : '#6B7280'};
      }
    </style>
  `;

  const finalHtml = `${themeStyles}${html}`;

  return {
    processedHtml: finalHtml,
    hasBlockedImages,
    blockedTrackerCount: protectedContent.blockedTrackerCount,
  };
}

// Original function for backward compatibility
export function processEmailHtml({
  html,
  shouldLoadImages,
  theme,
  trackingProtection = false,
}: ProcessEmailOptions): {
  processedHtml: string;
  hasBlockedImages: boolean;
  blockedTrackerCount: number;
} {
  const preprocessed = preprocessEmailContent(html, trackingProtection);
  const processed = applyEmailPreferences(preprocessed.html, theme, shouldLoadImages);

  return {
    ...processed,
    blockedTrackerCount: preprocessed.blockedTrackerCount,
  };
}
