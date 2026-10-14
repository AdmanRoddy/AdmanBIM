// Node test harness for src/core.js:  node tools/test-core.cjs <file.nwd>
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const NWD = require(path.join(__dirname, '..', 'src', 'core.js'));

function fileSource(p) {
  const fd = fs.openSync(p, 'r'), size = fs.fstatSync(fd).size;
  return { size, name: path.basename(p), read: async (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, len); } };
}
const t = () => process.hrtime.bigint();
const ms = a => Number(t() - a) / 1e6 | 0;

(async () => {
  // inflate self-test against node zlib
  for (const sz of [0, 1, 100, 70000, 3e6]) {
    const src = Buffer.alloc(sz); for (let i = 0; i < sz; i++) src[i] = (i * 7 + (i >> 5)) & 255;
    for (const level of [0, 1, 9]) {
      const z = zlib.deflateSync(src, { level });
      const out = NWD.inflate(z, 0).data;
      if (Buffer.compare(Buffer.from(out), src) !== 0) throw new Error(`inflate mismatch size ${sz} level ${level}`);
    }
  }
  console.log('inflate self-test ok');

  const f = await NWD.openFile(fileSource(process.argv[2]));
  console.log(f.header, f.sections.length, 'sections');
  let a = t();
  const fr = NWD.parseFragments(await NWD.readSection(f, f.section('LcOpNwdFragments')));
  console.log('fragments', fr.count, 'materials', fr.materials.length, 'transforms', fr.xfT.length / 3, ms(a) + 'ms');
  a = t();
  const h = NWD.parseHierarchy(await NWD.readSection(f, f.section('LcOpNwdLogicalHierarchy')));
  console.log('tree nodes', h.nodes.count, 'walk', h.walk.count, 'strings', h.strings.length, 'props', h.props.length, ms(a) + 'ms');
  let bad = 0; for (let i = 0; i < fr.count; i++) { const n = h.walk.node[fr.node[i]]; if (n === undefined || h.nodes.cls[n] !== 22) bad++; }
  console.log('fragments not landing on geometry nodes:', bad);
  const sv = f.section('LcOpSavedViewsElement');
  if (sv) { const views = NWD.parseSavedViews(await NWD.readSection(f, sv)); console.log('viewpoints', views.length, views.slice(0, 4).map(v => v.name)); }
  a = t();
  const g = await NWD.openGeometry(f);
  const pick = []; for (let i = 0; i < 2000; i++) pick.push(Math.floor(Math.random() * g.nRec));
  const recs = await NWD.fetchRecords(f, g, pick, new Map());
  let tris = 0, errs = 0;
  for (const [i, b] of recs) { try { const r = NWD.parseRecord(b); if (r.kind === 94) tris += NWD.meshTriangles(r).tris; else if (r.kind === 95) NWD.lineSegments(r); } catch (e) { errs++; if (errs < 4) console.log('record', i, e.message); } }
  console.log('random records', recs.size, 'triangles', tris, 'errors', errs, ms(a) + 'ms');
})().catch(e => { console.error('FAILED', e); process.exit(1); });
