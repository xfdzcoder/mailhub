import React from 'react';
import { createRoot } from 'react-dom/client';
import { MailHtml } from '../../src/components/email/MailHtml';
import { MAX_MAIL_HTML_LENGTH } from '../../src/lib/email/display-budget';

const origin = location.origin;
const attachments = [{ id: 'logo', cid: '<logo@fixture>', contentType: 'image/png' }];
const html = `
<h1>Team lunch on Thursday</h1>
<p>Hello team,</p><p>Let’s meet at <strong>12:30</strong>. Please bring your ideas for the next release.</p>
<table style="border-collapse:collapse"><tr><th>Time</th><th>Plan</th></tr><tr><td>12:30</td><td>Lunch and discussion</td></tr></table>
<p><img src="cid:logo%40fixture" alt="Inline team logo" width="48"></p>
<p><img src="${origin}/remote/tracker.png" alt="Remote event photo" width="240"></p>
<p><a href="https://example.test/lunch" target="_top">Lunch details</a></p>
<script>parent.document.body.dataset.compromised='yes';fetch('${origin}/remote/script')</script>
<img src="javascript:alert(1)" onerror="parent.document.body.dataset.compromised='yes'">
<iframe src="${origin}/remote/frame"></iframe><object data="${origin}/remote/object"></object>
<meta http-equiv="refresh" content="0;url=${origin}/remote/refresh"><base href="${origin}/remote/">
<form action="${origin}/remote/form" target="_top"><input name="secret" value="synthetic"><button>Submit</button></form>
<a href="javascript:alert(1)">Bad link</a><a href="//example.test/path" target="_blank">Relative link</a>
<svg><a href="${origin}/remote/svg"><text>SVG</text></a></svg>
<style>@import '${origin}/remote/import'; body {background:url('${origin}/remote/css')}</style>
<div style="background-image:url('${origin}/remote/inline');position:fixed;inset:0;color:#123456">Safe typography</div>
<img srcset="${origin}/remote/srcset 2x" src="/remote/relative">
<img src="data:image/svg+xml,%3Csvg onload='alert(1)'%3E">
`;
const fixtureHtml = new URLSearchParams(location.search).has('repeat-cid')
  ? '<h1>Repeated inline images</h1>' + '<img src="cid:logo%40fixture" alt="Repeated logo">'.repeat(80)
  : html;
function Fixture() {
  const [id, setId] = React.useState('one');
  const [large, setLarge] = React.useState(false);
  return <main style={{ maxWidth: 800, margin: '24px auto', height: 640 }}>
    <h2>Message from the product team</h2>
    <button onClick={() => setId(id === 'one' ? 'two' : 'one')}>Next message</button>{' '}
    <button onClick={() => setLarge(true)}>Oversized message</button>
    <MailHtml html={large ? 'x'.repeat(MAX_MAIL_HTML_LENGTH + 1) : fixtureHtml} accountId="fixture" emailId={id} attachments={attachments} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
