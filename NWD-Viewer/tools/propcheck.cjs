// Checks element properties: scan, link to the tree, and read sample items back on their own.
// node tools/propcheck.cjs model.nwd [name filter]
const fs = require('fs'); const NWD = require('../src/core.js');
function src(p) { const fd = fs.openSync(p, 'r'), size = fs.fstatSync(fd).size; return { size, read: async (o, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, o); return new Uint8Array(b.buffer, b.byteOffset, l); } }; }
const norm = s => { const p = String(s).split(':').map(x => x.trim()).filter(Boolean); return p.length >= 3 ? p[0] + ': ' + p[p.length - 1] : p.join(': '); };
(async () => {
  const f = await NWD.openFile(src(process.argv[2]));
  const P = await NWD.openPartitionProps(f); if (!P) { console.log('no element properties in this file'); return; }
  const t0 = Date.now(); const scan = await NWD.scanPartitionProps(P); const t1 = Date.now();
  const H = NWD.parseHierarchy(await NWD.readSection(f, f.section('LcOpNwdLogicalHierarchy')));
  const L = NWD.linkPartitionProps(scan.labels, H);
  console.log('chunks', P.n, 'items', scan.count, 'linked', L.linked, '/', L.nodes, 'scan ms', t1 - t0, scan.error ? 'skipped ' + scan.skipped + ' (' + scan.error + ')' : '');
  // read items back one at a time; the Element tab must give the label the scan saw
  let ok = 0, bad = 0, n = 0;
  for (let k = 0; k < 60; k++) {
    const gi = Math.floor(Math.random() * scan.count); const lb = scan.labels[gi]; if (!lb || lb[0] === '\u0001') continue;
    const it = await NWD.readPartitionItem(P, scan, gi); const e = it.tabs.find(t => t.name === 'Element'); if (!e) continue; n++;
    const v = key => { const r = e.rows.find(r => r[0] === key); return r && r[2] !== null ? String(r[2]) : ''; };
    if (norm(v('Category') + ': ' + v('Family') + ': ' + v('Type')) === lb) ok++; else { bad++; if (bad < 4) console.log('  differs', gi, lb, '|', v('Category'), v('Family'), v('Type')); }
  }
  console.log('read back', n, 'items with an Element tab:', ok, 'match', bad, 'differ');
  const filt = process.argv[3]; if (!filt) return;
  const S = H.strings, N = H.nodes;
  for (let q = 0; q < N.count; q++) {
    if (L.of[q] < 0 || !(N.name[q] >= 0 && S[N.name[q]].includes(filt))) continue;
    const it = await NWD.readPartitionItem(P, scan, L.of[q]); console.log('node', S[N.name[q]], 'id', it.id);
    for (const t of it.tabs) console.log('  ', t.name, JSON.stringify((t.rows || t.links).map(r => [r[0], r[2] && r[2].len !== undefined ? r[2].len : r[2]])).slice(0, 300));
    break;
  }
})().catch(e => console.log('ERR', e.message));
