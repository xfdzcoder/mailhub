import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('isolates synthetic HTML, blocks network resources, preserves CID and reading, and scopes consent', async ({ page, context }) => {
  const remoteRequests: string[] = [];
  const unexpected: string[] = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') { unexpected.push(url.href); await route.abort(); return; }
    if (url.pathname.startsWith('/remote/')) {
      remoteRequests.push(url.pathname);
      expect(route.request().headers()['referer']).toBeUndefined();
    }
    await route.continue();
  });
  await context.addCookies([{ name: 'fixture-session', value: 'synthetic', url: 'http://127.0.0.1:3219', sameSite: 'Strict', httpOnly: true }]);
  await page.goto('/');
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Team lunch on Thursday' })).toBeVisible();
  await expect(frame.getByRole('cell', { name: 'Lunch and discussion' })).toBeVisible();
  await expect(frame.getByAltText('Inline team logo')).toHaveJSProperty('naturalWidth', 1);
  await expect(page.getByRole('button', { name: 'Load remote images for this message' })).toBeVisible();
  expect(remoteRequests).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(await page.locator('iframe').getAttribute('sandbox')).toBe('');
  expect(await page.locator('iframe').evaluate((el: HTMLIFrameElement) => el.contentDocument)).toBeNull();
  expect(await page.locator('body').getAttribute('data-compromised')).toBeNull();
  expect(await frame.locator('script, form, input, iframe, object, svg, meta[http-equiv="refresh"], base').count()).toBe(0);
  expect(await frame.locator('a[href], [onerror], [srcset]').count()).toBe(0);
  await frame.getByText('Lunch details').click();
  expect(page.url()).toBe('http://127.0.0.1:3219/');
  expect(context.pages()).toHaveLength(1);
  await expect(frame.getByText('Safe typography')).toHaveCSS('position', 'static');
  await expect(frame.getByText('Safe typography')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await page.getByText('Links in this message').click();
  await expect(page.getByRole('link', { name: /Lunch details/ })).toHaveAttribute('rel', 'noopener noreferrer');
  await mkdir('test-results/previews', { recursive: true });
  await page.locator('iframe').locator('..').screenshot({ path: 'test-results/previews/mail-remote-images-blocked.png' });
  await page.getByRole('button', { name: 'Load remote images for this message' }).click();
  await expect(frame.getByAltText('Remote event photo')).toHaveJSProperty('naturalWidth', 1);
  expect(remoteRequests).toEqual(['/remote/tracker.png']);
  await page.getByRole('button', { name: 'Block remote images' }).click();
  await expect(frame.getByAltText('Remote event photo')).not.toHaveAttribute('src');
  await page.getByRole('button', { name: 'Load remote images for this message' }).click();
  await expect(frame.getByAltText('Remote event photo')).toHaveJSProperty('naturalWidth', 1);
  await page.getByRole('button', { name: 'Next message' }).click();
  await expect(page.getByRole('button', { name: 'Load remote images for this message' })).toBeVisible();
  await expect(frame.getByAltText('Inline team logo')).toHaveJSProperty('naturalWidth', 1);
  expect(remoteRequests).toEqual(['/remote/tracker.png', '/remote/tracker.png']);
  expect(unexpected).toEqual([]);
  await page.getByRole('button', { name: 'Oversized message' }).click();
  await expect(page.getByRole('status')).toContainText('too large');
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('enforces sandbox and CSP even if active markup reaches the document', async ({ page, context }) => {
  const requests: string[] = [];
  await context.route('**/remote/**', async route => { requests.push(route.request().url()); await route.abort(); });
  await context.addCookies([{ name: 'fixture-session', value: 'synthetic', url: 'http://127.0.0.1:3219', sameSite: 'Strict', httpOnly: true }]);
  await page.goto('/');
  await expect(page.frameLocator('iframe').getByAltText('Inline team logo')).toHaveJSProperty('naturalWidth', 1);
  await expect(page.locator('iframe')).toBeVisible();
  await page.locator('iframe').evaluate((el: HTMLIFrameElement) => {
    const origin = location.origin;
    el.srcdoc = el.srcdoc.replace('</body>', `
      <script>parent.document.body.dataset.compromised='yes';window.open('${origin}/remote/popup')</script>
      <form action="${origin}/remote/form"><button>Unsafe submit</button></form>
      <a href="${origin}/remote/top" target="_top">Unsafe navigation</a>
      <a href="${origin}/remote/popup" target="_blank">Unsafe popup</a>
      <style>@import '${origin}/remote/import';body{background-image:url('${origin}/remote/css')}</style>
      <img src="${origin}/remote/injected" alt="Injected remote image">
      </body>`);
  });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Unsafe submit' }).click();
  await frame.getByText('Unsafe navigation').click();
  await frame.getByText('Unsafe popup').click();
  expect(page.url()).toBe('http://127.0.0.1:3219/');
  expect(context.pages()).toHaveLength(1);
  expect(await page.locator('body').getAttribute('data-compromised')).toBeNull();
  expect(requests).toEqual([]);
});

test('bounds actual CID response bytes while leaving mail readable', async ({ page, context }) => {
  await context.route('**/attachments/logo', route => route.fulfill({
    contentType: 'image/png', body: Buffer.alloc(10 * 1024 * 1024 + 1),
  }));
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('inline images could not be loaded');
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Team lunch on Thursday' })).toBeVisible();
  await expect(frame.getByAltText('Inline team logo')).not.toHaveAttribute('src');
});

test('limits embedded output when many elements repeat the same CID', async ({ page, context }) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQTX79HwAElwJzVt2vfAAAAABJRU5ErkJggg==', 'base64');
  await context.route('**/attachments/logo', route => route.fulfill({
    contentType: 'image/png', body: Buffer.concat([png, Buffer.alloc(512 * 1024)]),
  }));
  await page.goto('/?repeat-cid');
  const frame = page.frameLocator('iframe');
  await expect(frame.getByAltText('Repeated logo').first()).toHaveAttribute('src', /^data:image\/png/);
  expect(await frame.locator('img[src]').count()).toBeLessThan(80);
  expect((await page.locator('iframe').getAttribute('srcdoc'))!.length).toBeLessThan(15 * 1024 * 1024);
});
