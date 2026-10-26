#!/usr/bin/env node
// Optional standalone wrapper around the installed shared choices core.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createChoicesAdapter, createChoicesServer, adapterPort } = require('../chat-choices.js');
export { createChoicesAdapter, createChoicesServer, adapterPort };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('node tools/chat-choices-adapter.mjs\nSet ERA_CHAT_TEXT_URL, ERA_CHAT_TEXT_MODEL and ERA_CHAT_TEXT_TOKEN outside the checkout.\nERA_CHAT_TEXT_PORT: 8380–8389 (default 8385).');
  else {
    try {
      const server = createChoicesServer(), port = adapterPort();
      server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Adapter port is occupied.' : 'Adapter could not start.'); process.exitCode = 1; });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
      server.listen(port, 'localhost', () => console.log('Chat choices adapter listening on port ' + port));
    } catch { console.error('Adapter configuration is invalid.'); process.exitCode = 1; }
  }
}
