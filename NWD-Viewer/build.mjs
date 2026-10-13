import { fileURLToPath } from 'url';
// Builds the single-file app: src/* -> index.html   (node build.mjs)
import fs from 'fs';
import path from 'path';
const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(dir, 'src', f), 'utf8');
const parts = { CSS: read('style.css'), CORE: read('core.js'), WORKER: read('worker.js'), APP: read('app.js') };
for (const [k, v] of Object.entries(parts)) if (/<\/script/i.test(v)) throw new Error(k + ' contains </script>');
let html = read('index.template.html');
for (const [k, v] of Object.entries(parts)) html = html.replace('/*' + k + '*/', () => v);
fs.writeFileSync(path.join(dir, 'index.html'), html);
console.log('index.html', (html.length / 1024).toFixed(0) + ' KB');
