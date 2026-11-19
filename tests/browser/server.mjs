import { createServer } from 'node:http';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFile } from 'node:fs/promises';
const bundle = await build({ entryPoints: ['tests/browser/mail-fixture.tsx'], bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const css = await postcss([tailwind()]).process(await readFile('src/app/globals.css', 'utf8'), { from: 'src/app/globals.css' });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQTX79HwAElwJzVt2vfAAAAABJRU5ErkJggg==', 'base64');
createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
  else if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css); }
  else if (req.url?.includes('/attachments/') && !req.headers.cookie?.includes('fixture-session=synthetic')) { res.writeHead(401); res.end(); }
  else if (req.url?.includes('/attachments/') || req.url?.startsWith('/remote/')) { res.setHeader('Content-Type', 'image/png'); res.end(png); }
  else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); }
}).listen(3219, '127.0.0.1');
