#!/usr/bin/env node
// Standalone prototype: no installed-hub services, accounts or background jobs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChatApi } = require('../chat-api.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

// --pictures: the picture-style preview on a scratch hub (tools/chat-pictures-preview.mjs).
export function previewArguments(argv) {
  const value = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  return { pictures: argv.includes('--pictures'), out: value('--out'), data: value('--data') };
}
export function previewPort(env = process.env) {
  const port = Number(env.ERA_TEST_PORT || 8386);
  if (!Number.isInteger(port) || port < 8380 || port > 8389) throw Error('Use ERA_TEST_PORT between 8380 and 8389.');
  return port;
}
function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function serve(req, res, root, relative) {
  if (relative.split(/[\\/]/).some(part => part === '..' || part === '.') || relative.includes('\0')) return reply(res, 404, { error: 'not-found' });
  try {
    const realRoot = await fs.promises.realpath(root);
    const filename = await fs.promises.realpath(path.join(realRoot, relative));
    if (!filename.startsWith(realRoot + path.sep)) return reply(res, 404, { error: 'not-found' });
    const stat = await fs.promises.stat(filename);
    const type = MIME[path.extname(filename)];
    if (!stat.isFile() || !type) return reply(res, 404, { error: 'not-found' });
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    const input = fs.createReadStream(filename);
    input.on('error', () => res.destroy()); res.on('close', () => input.destroy()); input.pipe(res);
  } catch { reply(res, 404, { error: 'not-found' }); }
}
export function createPreviewServer(options = {}) {
  const api = options.api || createChatApi({ env: options.env || process.env });
  const server = http.createServer((req, res) => {
    if (api.handle(req, res)) return;
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return reply(res, 400, { error: 'invalid-path' }); }
    if (req.method === 'GET' && pathname === '/settings') return reply(res, 200, {
      preview: true, dwellMs: 1200, settleMs: 250, childName: 'friend', doorGoes: 'home', pauseGoes: 'home',
    });
    if (req.method === 'POST' && ['/kiosk/exit', '/kiosk/pause'].includes(pathname)) return reply(res, 200, { action: 'home' });
    if (pathname === '/tts') return reply(res, 503, { error: 'preview-uses-device-voice' });
    if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: 'method-not-allowed' });
    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Chat preview</title><h1>Chat preview</h1><p>This is a standalone prototype.</p><p><a href="/chat/">Open Chat</a></p></html>');
    }
    if (pathname === '/chat' || pathname === '/chat/') return void serve(req, res, path.join(PUBLIC, 'chat'), 'index.html');
    for (const folder of ['chat', 'lib']) if (pathname.startsWith('/' + folder + '/'))
      return void serve(req, res, path.join(PUBLIC, folder), pathname.slice(folder.length + 2));
    if (['/dwell.js', '/speech.js', '/favicon.ico'].includes(pathname)) {
      // These fixed shared entry points are intentional workspace symlinks.
      fs.promises.realpath(path.join(PUBLIC, pathname.slice(1))).then(file =>
        serve(req, res, path.dirname(file), path.basename(file))).catch(() => reply(res, 404, { error: 'not-found' }));
      return;
    }
    reply(res, 404, { error: 'not-found' });
  });
  server.on('close', () => api.close());
  server.on('error', () => { if (!server.listening) api.close(); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = previewArguments(process.argv.slice(2));
  if (process.argv.includes('--help')) {
    console.log('node tools/chat-preview.mjs\nERA_TEST_PORT: 8380–8389 (default 8386)\nOptional: ERA_CHAT_RUNTIME, ERA_CHAT_RUNTIME_ARGS, ERA_CHAT_CHOICES_URL, ERA_CHAT_CHOICES_TOKEN.'
      + '\nnode tools/chat-preview.mjs --pictures [--out DIR] [--data DIR]: picture styles side by side on a scratch hub, ERA_TEST_PORT 8480–8499 (default 8493);'
      + ' PNGs default to ~/.cache/era-chat/pictures-preview/.');
  } else if (args.pictures) {
    const { runPicturesPreview } = await import('./chat-pictures-preview.mjs');
    try {
      for (const file of await runPicturesPreview({ ...(args.out ? { out: args.out } : {}), ...(args.data ? { data: args.data } : {}) })) console.log(file);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  } else {
    try {
      const port = previewPort();
      const server = createPreviewServer();
      server.on('error', error => {
        console.error(error.code === 'EADDRINUSE' ? 'Preview port is occupied; choose another ERA_TEST_PORT.' : 'Preview could not start.');
        process.exitCode = 1;
      });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        server.closeAllConnections(); server.close();
      });
      server.listen(port, 'localhost', () => console.log('Chat preview listening on port ' + port));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
