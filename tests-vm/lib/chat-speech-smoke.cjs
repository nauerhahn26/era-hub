'use strict';
// Run with the installed Node: <this file> <installed app directory> <fixture.wav>.
// Only a loopback mock receives audio. The installed worker/model are untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

function pcmFromWave(wav) {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let pcm;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), body = offset + 8;
    if (name === 'fmt ') {
      assert.equal(wav.readUInt16LE(body), 1); assert.equal(wav.readUInt16LE(body + 2), 1);
      assert.equal(wav.readUInt32LE(body + 4), 16000); assert.equal(wav.readUInt16LE(body + 14), 16);
    }
    if (name === 'data') pcm = wav.subarray(body, body + size);
    offset = body + size + size % 2;
  }
  assert.ok(pcm?.length); return pcm;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition, label, milliseconds = 10000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { const value = condition(); if (value) return value; await delay(20); }
  throw new Error(label + ' timed out');
}
async function main() {
  const [root, fixturePath] = process.argv.slice(2);
  assert.ok(root && fixturePath);
  const pcm = pcmFromWave(fs.readFileSync(fixturePath)), requests = [], protocol = [];
  const errors = [];
  let pendingResponse, cancelClosedTransport = false, child, stderr = '', lines = '';
  const server = http.createServer((req, res) => {
    (async () => {
      assert.equal(req.url, '/transcribe'); assert.equal(req.headers.authorization, 'Bearer synthetic-credential');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; assert.ok(size < 600000); chunks.push(chunk); }
      const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
      assert.equal(form.get('model'), 'configured-tier');
      const audio = pcmFromWave(Buffer.from(await form.get('file').arrayBuffer()));
      requests.push({ bytes: audio.length });
      if (requests.length === 1) assert.deepEqual(audio, Buffer.concat([pcm, Buffer.alloc(48000)]));
      if (requests.length === 2) {
        pendingResponse = res;
        res.on('close', () => { if (!res.writableEnded) cancelClosedTransport = true; });
        return;
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ text: 'A synthetic question.' }));
    })().catch(() => { errors.push('mock-request-invalid'); res.statusCode = 500; res.end(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const env = {};
    for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, { ERA_CHAT_SPEECH_URL: `http://127.0.0.1:${server.address().port}/transcribe`, ERA_CHAT_SPEECH_MODEL: 'configured-tier', ERA_CHAT_SPEECH_TOKEN: 'synthetic-credential' });
    child = spawn(process.execPath, [path.join(root, 'chat-speech-worker.js')], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', data => {
      lines += data.toString(); let end;
      while ((end = lines.indexOf('\n')) >= 0) { protocol.push(JSON.parse(lines.slice(0, end))); lines = lines.slice(end + 1); }
    });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', () => errors.push('worker-start-failed'));
    const send = (type, generation, fields = {}) => child.stdin.write(JSON.stringify({ type, generation, ...fields }) + '\n');
    function audio(data, generation) { for (let offset = 0; offset < data.length; offset += 3200) send('audio', generation, { pcm: data.subarray(offset, offset + 3200).toString('base64') }); }
    const ready = await waitFor(() => protocol.find(event => event.type === 'ready'), 'installed model readiness', 20000);
    assert.equal(ready.sampleRate, 16000); assert.equal(ready.capabilities.wake, false);
    assert.equal(ready.capabilities.partial, false); assert.equal(ready.capabilities.automaticEndpoint, false);
    send('ask', 1); audio(Buffer.alloc(16000), 1); send('finish', 1);
    const silence = await waitFor(() => protocol.find(event => event.generation === 1 && event.type === 'error'), 'silence rejection');
    assert.equal(silence.message, 'no_speech'); assert.equal(requests.length, 0);
    send('ask', 2); audio(pcm, 2); audio(Buffer.alloc(48000), 2); await delay(250);
    assert.equal(requests.length, 0); assert.equal(protocol.filter(event => event.type === 'final').length, 0);
    send('finish', 2); send('finish', 2);
    const firstFinal = await waitFor(() => protocol.find(event => event.generation === 2 && event.type === 'final'), 'release recognition');
    assert.equal(firstFinal.text, 'A synthetic question.'); assert.equal(firstFinal.timings.audioMs, pcm.length / 32 + 1500);
    assert.equal(requests.length, 1);
    send('ask', 3); audio(pcm, 3); send('finish', 3);
    await waitFor(() => requests.length === 2 && pendingResponse, 'pending cancellable recognition');
    send('cancel', 4);
    await waitFor(() => cancelClosedTransport, 'cancelled transport closure');
    pendingResponse.end(JSON.stringify({ text: 'An obsolete result.' })); await delay(100);
    assert.equal(protocol.filter(event => event.type === 'final' && event.generation === 3).length, 0);
    send('ask', 5); audio(pcm, 5); send('finish', 5);
    await waitFor(() => protocol.find(event => event.generation === 5 && event.type === 'final'), 'recognition after cancel');
    assert.deepEqual(errors, []); assert.equal(stderr, '');
    send('close', 6); child.stdin.end();
    const [code] = await once(child, 'close'); assert.equal(code, 0);
    process.stdout.write(JSON.stringify({ ok: true, platform: process.platform, activity: 'actual bundled inference', recognition: 'loopback mock; no paid calls',
      silenceRejected: true, uploadsBeforeRelease: 0, releaseFinals: protocol.filter(event => event.generation === 2 && event.type === 'final').length,
      fixtureAcceptedByActivity: true, cancelClosedTransport, staleFinals: 0, recoveredAfterCancel: true, wakeAdvertised: ready.capabilities.wake }) + '\n');
  } finally {
    if (child && child.exitCode === null) { child.stdin.end(); child.kill(); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(() => { process.stdout.write(JSON.stringify({ ok: false, error: 'installed speech smoke failed' }) + '\n'); process.exitCode = 1; });
