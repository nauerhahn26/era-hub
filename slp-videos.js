// Local practice media and device-only recordings. No cloud credentials or API calls.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v'];
const MAX_RECORDING_BYTES = 128 * 1024 * 1024;

function createSlpVideos({ dataDir, localFolder = () => null, serveMedia, maxRecordingBytes = MAX_RECORDING_BYTES }) {
  const root = path.join(dataDir, 'slp-videos');
  const library = path.join(root, 'library'), recordings = path.join(root, 'recordings');
  const configFile = path.join(root, 'config.json');
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function selected() {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') return { folder: '', source: 'configured', available: false };
    }
    const shared = localFolder();
    const sharedDir = shared && path.join(shared, 'slp-videos');
    const folder = config.folder || (sharedDir && fs.existsSync(sharedDir) ? sharedDir : library);
    const source = config.folder ? 'configured' : folder === library ? 'local' : 'shared';
    let available = false;
    try { available = fs.statSync(folder).isDirectory(); } catch {}
    return { folder, source, available: available || source === 'local' };
  }
  function scan(folder, kind) {
    let names;
    try { names = fs.readdirSync(folder); } catch { return []; }
    return names.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).flatMap(name => {
      if (name.startsWith('.') || !VIDEO_EXTS.includes(path.extname(name).toLowerCase())) return [];
      const file = path.join(folder, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch { return []; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return [];
      const id = kind === 'recordings' ? name : crypto.createHash('sha256').update(folder+'\0'+name).digest('hex');
      return [{ id, title: path.basename(name,path.extname(name)).replace(/[_]+/g,' '), bytes: stat.size,
        modified: stat.mtime.toISOString(), url: `/api/slp-videos/${kind}/${encodeURIComponent(id)}?v=${stat.mtimeMs}-${stat.size}`, name, folder }];
    });
  }
  const publicItems = items => items.map(({name,folder,...item})=>item);
  function libraryItems(config = selected()) {
    return [...scan(library,'library'), ...(config.folder && config.folder !== library ? scan(config.folder,'library') : [])];
  }
  async function body(req) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new Error('too large'); }
    return JSON.parse(raw);
  }
  async function upload(req,res,folder,name,limit) {
    fs.mkdirSync(folder,{recursive:true});
    const temp = path.join(folder,'.upload-'+crypto.randomUUID()+'.part');
    let bytes = 0;
    // Do not destroy the request on an oversized upload: drain it, then answer 413.
    const meter = new Transform({transform(chunk,encoding,done) {
      bytes += chunk.length;
      done(null, bytes <= limit ? chunk : Buffer.alloc(0));
    }});
    try {
      await pipeline(req,meter,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
      if (bytes > limit) { json(res,413,{error:'File is too large.'}); return; }
      if (!bytes) { json(res,400,{error:'The recording or video was empty.'}); return; }
      fs.renameSync(temp,path.join(folder,name));
      json(res,201,{saved:true,id:name});
    } finally { try { fs.unlinkSync(temp); } catch {} }
  }
  async function route(req,res,url) {
    const suffix = url.pathname.slice('/api/slp-videos'.length);
    if (suffix === '/config' && req.method === 'PUT') {
      let value;
      try { value = await body(req); } catch { json(res,400,{error:'Invalid folder configuration.'}); return; }
      if (!value || typeof value.folder !== 'string' || value.folder.length > 4096) { json(res,400,{error:'Choose a local folder.'}); return; }
      let folder = value.folder.trim();
      if (folder) {
        try {
          if (!path.isAbsolute(folder) || !fs.statSync(folder).isDirectory()) throw new Error();
          folder = fs.realpathSync(folder);
          if (folder === root || folder === recordings || folder.startsWith(recordings+path.sep)) throw new Error();
        } catch { json(res,400,{error:'That folder is unavailable on this device.'}); return; }
      }
      fs.mkdirSync(root,{recursive:true});
      const temp = configFile+'.part'; fs.writeFileSync(temp,JSON.stringify({folder}),{mode:0o600}); fs.renameSync(temp,configFile);
      json(res,200,selected()); return;
    }
    if (suffix === '/library' && req.method === 'GET') {
      const config = selected(); json(res,200,{...config,videos:publicItems(libraryItems(config))}); return;
    }
    if (suffix === '/recordings' && req.method === 'GET') {
      json(res,200,{recordings:publicItems(scan(recordings,'recordings'))}); return;
    }
    if (suffix === '/recordings' && req.method === 'POST') {
      const mime = (req.headers['content-type']||'').split(';')[0].trim();
      if (!['video/webm','video/mp4'].includes(mime)) { json(res,415,{error:'Unsupported recording format.'}); return; }
      const name = new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID()+(mime==='video/mp4'?'.mp4':'.webm');
      await upload(req,res,recordings,name,maxRecordingBytes); return;
    }
    if (suffix === '/library' && req.method === 'PUT') {
      const name = url.searchParams.get('name') || '';
      if (!name || name.length>180 || /[\\/\x00-\x1f<>:"|?*]/.test(name) || name.startsWith('.') || !VIDEO_EXTS.includes(path.extname(name).toLowerCase())) {
        json(res,400,{error:'Choose an MP4, WebM or MOV video.'}); return;
      }
      // Imports are always local; never write into a configured or shared folder.
      await upload(req,res,library,name,512*1024*1024); return;
    }
    const media = /^\/(library|recordings)\/([^/]+)$/.exec(suffix);
    if (media && ['GET','HEAD'].includes(req.method)) {
      const items = media[1] === 'recordings' ? scan(recordings,'recordings') : libraryItems();
      const item = items.find(item => item.id === decodeURIComponent(media[2]));
      if (!item) { json(res,404,{error:'Video unavailable.'}); return; }
      // The existing music jail serves WebM as audio; this jail carries camera video.
      const writeHead = res.writeHead.bind(res);
      res.writeHead = (status,headers) => writeHead(status,{...headers,'Content-Type':path.extname(item.name).toLowerCase()==='.webm'?'video/webm':path.extname(item.name).toLowerCase()==='.mov'?'video/quicktime':'video/mp4'});
      serveMedia(req,res,item.folder,item.name,VIDEO_EXTS,VIDEO_EXTS,[],null,'no-store'); return;
    }
    json(res,404,{error:'Unknown practice video action.'});
  }
  function handle(req,res) {
    if (!/^\/api\/slp-videos(?:\/|\?|$)/.test(req.url||'')) return false;
    try {
      const host = new URL('http://'+req.headers.host);
      const local = ['localhost','127.0.0.1','[::1]'];
      const peer = req.socket.remoteAddress || '';
      if (!local.includes(host.hostname) || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer) ||
          (req.headers.origin && req.headers.origin !== host.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
        json(res,403,{error:'Open this app on the device running the hub.'}); return true;
      }
      const url = new URL(req.url,host);
      route(req,res,url).catch(()=>{if(!res.headersSent)json(res,500,{error:'Could not save or read the local file. Check available storage.'});else res.destroy();});
    } catch { json(res,400,{error:'Invalid request.'}); }
    return true;
  }
  return { handle };
}
module.exports = { createSlpVideos, VIDEO_EXTS, MAX_RECORDING_BYTES };
