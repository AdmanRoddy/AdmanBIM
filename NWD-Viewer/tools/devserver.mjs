import { fileURLToPath } from 'url';
// Development server: serves the app folder and (with Range support) a few local model files for testing.
//   node tools/devserver.mjs 8770
import http from 'http'; import fs from 'fs'; import path from 'path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8770);
// Model files for testing: tools/models.local.json  { "name.nwd": "C:/path/to/Model.nwd" }  (kept out of git)
const modelsFile = path.join(root, 'tools', 'models.local.json');
const MODELS = fs.existsSync(modelsFile) ? JSON.parse(fs.readFileSync(modelsFile, 'utf8')) : {};
const types = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.png': 'image/png', '.css': 'text/css' };
http.createServer((q, s) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  const m = u.match(/^\/models\/(.+)$/);
  let file;
  if (m) file = MODELS[m[1]];
  else { file = path.join(root, u.endsWith('/') ? u + 'index.html' : u); if (!file.startsWith(root)) file = null; }
  if (!file || !fs.existsSync(file)) { s.writeHead(404); return s.end(); }
  const size = fs.statSync(file).size, h = { 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length', 'Cache-Control': 'no-store' };
  h['Content-Type'] = types[path.extname(file)] || 'application/octet-stream';
  const r = q.headers.range && /bytes=(\d+)-(\d*)/.exec(q.headers.range);
  if (r) {
    const a = +r[1], b = r[2] ? Math.min(+r[2], size - 1) : size - 1;
    s.writeHead(206, Object.assign(h, { 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 }));
    fs.createReadStream(file, { start: a, end: b }).pipe(s);
  } else { s.writeHead(200, Object.assign(h, { 'Content-Length': size })); fs.createReadStream(file).pipe(s); }
}).listen(port, () => console.log('dev server on', port, 'root', root));
