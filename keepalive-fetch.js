// A fetch-shaped client whose connections stay warm for the hub's lifetime
// (real-time chat spec 2026-10-27 §3.3): the reply and saved-voice services are
// reached over kept-alive sockets, so a turn after a quiet minute pays no new
// TLS handshake. Node's own fetch drops idle connections after about four
// seconds and exposes no agent. Only what the hub's callers use is offered:
// method, headers, body, signal, redirect (never followed: a 3xx is not ok);
// the response has ok, status, headers.get, an async-iterable body, json(),
// text() and arrayBuffer().
'use strict';
const http = require('node:http');
const https = require('node:https');

function createKeepAliveFetch(options = {}) {
  const agents = {
    'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: options.maxSockets || 8 }),
    'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: options.maxSockets || 8 }),
  };
  function fetcher(target, init = {}) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(String(target)); } catch (error) { reject(new TypeError('invalid url')); return; }
      const transport = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
      if (!transport) { reject(new TypeError('unsupported protocol')); return; }
      const signal = init.signal;
      const aborted = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      if (signal?.aborted) { reject(aborted()); return; }
      const body = init.body === undefined || init.body === null ? null : Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body));
      const headers = { ...init.headers, ...(body ? { 'Content-Length': String(body.length) } : {}) };
      const request = transport.request(url, { method: init.method || 'GET', headers, agent: agents[url.protocol] });
      let current = null;
      const onAbort = () => { if (current) current.destroy(aborted()); request.destroy(aborted()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      request.on('error', error => { signal?.removeEventListener('abort', onAbort); reject(signal?.aborted ? aborted() : error); });
      request.on('response', response => {
        current = response;
        response.on('end', () => signal?.removeEventListener('abort', onAbort));
        response.on('error', () => {});
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        let read = async () => { const chunks = []; for await (const chunk of response) chunks.push(chunk); return Buffer.concat(chunks); };
        let body = response;
        // An error answer is read off the socket at once (bounded) whether or
        // not the caller reads it: an unread body would hold its pooled socket
        // and a short burst of refusals would jam every later request.
        if (!ok) {
          const drained = new Promise(done => {
            const chunks = []; let size = 0;
            response.on('data', chunk => { size += chunk.length; if (size <= 65536) chunks.push(chunk); else response.destroy(); });
            response.on('end', () => done(Buffer.concat(chunks)));
            response.on('close', () => done(Buffer.concat(chunks)));
          });
          read = () => drained;
          body = (async function* () { const bytes = await drained; if (bytes.length) yield bytes; })();
        }
        resolve({ ok, status: response.statusCode,
          headers: { get: name => { const value = response.headers[String(name).toLowerCase()]; return value === undefined ? null : Array.isArray(value) ? value.join(', ') : String(value); } },
          body,
          text: async () => (await read()).toString('utf8'),
          json: async () => JSON.parse((await read()).toString('utf8')),
          arrayBuffer: async () => { const bytes = await read(); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); } });
      });
      if (body) request.end(body); else request.end();
    });
  }
  fetcher.close = () => { for (const agent of Object.values(agents)) agent.destroy(); };
  return fetcher;
}

module.exports = { createKeepAliveFetch };
