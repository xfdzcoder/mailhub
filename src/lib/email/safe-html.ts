import createDOMPurify from 'dompurify';
import { emailContentStyles } from './content-styles';
import { MAX_MAIL_HTML_LENGTH, MAX_INLINE_BYTES, MAX_INLINE_DATA_LENGTH, MAX_MAIL_IMAGES } from './display-budget';

export type InlineAttachment = { id: string; cid: string | null; contentType: string | null };
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const tags = 'p div span br hr h1 h2 h3 h4 h5 h6 b strong i em u s del strike blockquote pre code ul ol li table thead tbody tfoot tr td th caption a img sub sup'.split(' ');
const cssProperties = new Set('color background-color font-size font-weight font-style font-family text-align text-decoration line-height margin margin-top margin-bottom margin-left margin-right padding padding-top padding-bottom padding-left padding-right border border-color border-width border-style border-collapse width max-width height vertical-align white-space'.split(' '));

export function sanitizeMail(html: string, remote: boolean, inline: Map<string, string>) {
  if (html.length > MAX_MAIL_HTML_LENGTH) throw new Error('Mail HTML exceeds display budget');
  const links: { label: string; url: string }[] = [];
  let hasRemoteImages = false;
  const cids = new Set<string>();
  let embeddedLength = 0;
  let imageCount = 0;
  const purifier = createDOMPurify(window);
  if (!purifier.isSupported) throw new Error('HTML sanitization is unavailable');
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.hasAttribute('style')) {
      for (const name of Array.from(node.style)) {
        const value = node.style.getPropertyValue(name);
        // Only ordinary typography/layout; no escapes, functions, URLs or positioning.
        const plainValue = /^[\w\s#.,%+\-"']{1,160}$/.test(value);
        const colorValue = /^(?:rgb|hsl)a?\([\d\s.,%+\-/]{1,100}\)$/i.test(value);
        if (!cssProperties.has(name) || !(plainValue || colorValue)) node.style.removeProperty(name);
      }
    }
    if (node.tagName === 'A') {
      try {
        const url = new URL(node.getAttribute('href') || '');
        if (['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password && links.length < 100) {
          links.push({ label: (node.textContent || url.href).slice(0, 200), url: url.href });
        }
      } catch { /* Relative and malformed links are inert. */ }
      // Navigation is offered by the trusted parent, never by the mail frame.
      node.removeAttribute('href');
    }
    if (node.tagName === 'IMG') {
      const source = node.getAttribute('src') || '';
      node.removeAttribute('src');
      if (++imageCount > MAX_MAIL_IMAGES) return;
      if (source.toLowerCase().startsWith('cid:')) {
        let cid = source.slice(4);
        try { cid = decodeURIComponent(cid); } catch { return; }
        cid = cid.replace(/^<|>$/g, '');
        if (cids.size < 64) cids.add(cid);
        const image = inline.get(cid);
        // Repeated CID references must not amplify a small mail into an enormous document.
        if (image && embeddedLength + image.length <= MAX_INLINE_DATA_LENGTH) {
          embeddedLength += image.length;
          node.setAttribute('src', image);
        }
      } else {
        try {
          const url = new URL(source);
          if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
            hasRemoteImages = true;
            if (remote) node.setAttribute('src', url.href);
          }
        } catch { /* No relative, data, SVG or sender-supplied blob resources. */ }
      }
      node.setAttribute('referrerpolicy', 'no-referrer');
    }
  });
  const body = purifier.sanitize(html, {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'style', 'width', 'height', 'colspan', 'rowspan', 'align'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  const policy = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:${remote ? ' http: https:' : ''}; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'`;
  return {
    document: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>${emailContentStyles}</style></head><body>${body}</body></html>`,
    links, hasRemoteImages, cids,
  };
}

/** Fetch CID in the authenticated parent, then embed bounded raster data in the opaque frame. */
export async function loadInlineImages(cids: Set<string>, attachments: InlineAttachment[], base: string, signal: AbortSignal) {
  const images = new Map<string, string>();
  let total = 0;
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  try {
    for (const cid of cids) {
      const attachment = attachments.slice(0, 256).find((item) => item.cid?.replace(/^<|>$/g, '') === cid);
      if (!attachment || !rasterTypes.has(attachment.contentType || '')) continue;
      const response = await fetch(`${base}/${encodeURIComponent(attachment.id)}`, { signal: downloadSignal, credentials: 'same-origin', redirect: 'error' });
      if (!response.ok || !response.body) continue;
      const type = response.headers.get('content-type')?.split(';')[0];
      if (!type || !rasterTypes.has(type)) { await response.body.cancel(); continue; }
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_INLINE_BYTES) throw new Error('Inline image budget exceeded');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob(chunks, { type }));
      });
      images.set(cid, data);
    }
    return images;
  } catch (error) {
    images.clear();
    throw error;
  }
}
