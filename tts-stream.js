// The saved voice streamed through the hub (real-time chat spec 2026-10-27
// §3.4): the service's streaming endpoint is read chunk by chunk and every
// chunk goes on to the page at once, so a clip that was not prefetched starts
// at its first bytes. The whole clip is cached (tmp, then rename) only when it
// completed; a failure leaves nothing behind. A page that leaves early does not
// stop the download: the clip was paid for, so it is still cached.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

async function streamSpeech({ fetch: fetcher = globalThis.fetch, url, headers, body, cacheFile, res, contentType = 'audio/mpeg', maxBytes = 4194304, timeoutMs = 20000 }) {
  let cached = null;
  try { cached = fs.readFileSync(cacheFile); } catch { /* not cached yet */ }
  if (cached) { res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'max-age=86400' }); res.end(cached); return { cached: true, bytes: cached.length }; }
  // A stalled voice service never holds the request (or a pooled socket) forever.
  const response = await fetcher(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw new Error('voice-service ' + response.status);
  const chunks = []; let bytes = 0, open = true;
  for await (const chunk of response.body) {
    const piece = Buffer.from(chunk);
    bytes += piece.length;
    if (bytes > maxBytes) throw new Error('voice-too-large');
    chunks.push(piece);
    if (open) {
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'max-age=86400' });
      if (res.destroyed || res.writableEnded) open = false; else res.write(piece);
    }
  }
  if (!bytes) throw new Error('voice-empty');
  const temporary = cacheFile + '.' + process.pid + '.' + Date.now() + '.tmp';
  try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(temporary, Buffer.concat(chunks)); fs.renameSync(temporary, cacheFile); }
  catch { try { fs.rmSync(temporary, { force: true }); } catch {} }
  if (open && !res.writableEnded) res.end();
  return { cached: false, bytes };
}

module.exports = { streamSpeech };
