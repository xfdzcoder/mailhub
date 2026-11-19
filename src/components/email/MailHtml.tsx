'use client';

import { useEffect, useMemo, useState } from 'react';
import type { sanitizeMail, InlineAttachment } from '@/lib/email/safe-html';
import { MAX_MAIL_HTML_LENGTH } from '@/lib/email/display-budget';

type Props = { html: string; accountId: string; emailId: string; attachments: InlineAttachment[] };

export function MailHtml(props: Props) {
  // A new message always gets new consent, including when the parent keeps this component mounted.
  return <MailHtmlMessage key={`${props.accountId}:${props.emailId}`} {...props} />;
}

function MailHtmlMessage({ html, accountId, emailId, attachments }: Props) {
  const [remote, setRemote] = useState(false);
  const [loaded, setLoaded] = useState<{ html: string; images: Map<string, string>; sanitize: typeof sanitizeMail } | null>(null);
  const content = useMemo(() => loaded?.sanitize(loaded.html, remote, loaded.images), [loaded, remote]);
  const [renderError, setRenderError] = useState(false);
  const [inlineError, setInlineError] = useState(false);
  const oversized = html.length > MAX_MAIL_HTML_LENGTH;
  useEffect(() => {
    if (oversized) return;
    const controller = new AbortController();
    let inlineImages = new Map<string, string>();
    // Load the DOM-based sanitizer only in the browser, never during server rendering.
    void import('@/lib/email/safe-html').then(async ({ sanitizeMail, loadInlineImages }) => {
      if (controller.signal.aborted) return;
      const initial = sanitizeMail(html, false, inlineImages);
      setLoaded({ html, images: inlineImages, sanitize: sanitizeMail });
      setInlineError(false);
      const base = `/api/accounts/${encodeURIComponent(accountId)}/emails/${encodeURIComponent(emailId)}/attachments`;
      try {
        const images = await loadInlineImages(initial.cids, attachments, base, controller.signal);
        if (controller.signal.aborted) {
          images.clear();
          return;
        }
        inlineImages = images;
        setLoaded({ html, images, sanitize: sanitizeMail });
      } catch {
        if (!controller.signal.aborted) setInlineError(true);
      }
    }).catch(() => { if (!controller.signal.aborted) setRenderError(true); });
    return () => {
      controller.abort();
      inlineImages.clear();
    };
  }, [html, accountId, emailId, attachments, oversized]);

  if (oversized) return <p role="status">This message is too large to display safely. View it in your mail provider.</p>;
  if (renderError) return <p role="status">This message could not be displayed safely. View it in your mail provider.</p>;
  return (
    <div className="flex h-full min-h-96 flex-col gap-3">
      {content?.hasRemoteImages && (
        <div className="flex flex-wrap items-center gap-3 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
          <span>{remote ? 'Remote images are enabled for this message.' : 'Remote images are blocked to protect your privacy.'}</span>
          <button type="button" className="font-medium text-blue-700 underline" onClick={() => setRemote(!remote)}>
            {remote ? 'Block remote images' : 'Load remote images for this message'}
          </button>
        </div>
      )}
      {inlineError && <p role="status" className="text-sm text-gray-600">Some inline images could not be loaded.</p>}
      {content && <iframe title="Email Content" className="block min-h-80 w-full flex-1 border-none" srcDoc={content.document} sandbox="" referrerPolicy="no-referrer" translate="yes" />}
      {!!content?.links.length && (
        <details className="text-sm text-gray-700">
          <summary>Links in this message ({content.links.length})</summary>
          <ul className="space-y-2 p-3">
            {content.links.map((link, index) => <li key={index}><a href={link.url} target="_blank" rel="noopener noreferrer" className="break-all text-blue-700 underline">{link.label} — {link.url}</a></li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
