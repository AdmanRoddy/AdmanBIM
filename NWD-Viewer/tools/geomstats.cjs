// Decode every geometry record referenced by fragments; report kinds and failures. node tools/geomstats.cjs file
const fs=require('fs'); const NWD=require('../src/core.js');
function src(p){const fd=fs.openSync(p,'r'),size=fs.fstatSync(fd).size;return{size,read:async(o,l)=>{const b=Buffer.alloc(l);fs.readSync(fd,b,0,l,o);return new Uint8Array(b.buffer,b.byteOffset,l);}};}
(async()=>{ const f=await NWD.openFile(src(process.argv[2])); const F=NWD.parseFragments(await NWD.readSection(f,f.section('LcOpNwdFragments'))); const G=await NWD.openGeometry(f);
 const used=new Map(); for(let i=0;i<F.count;i++){ const g=F.geom[i]; if(g>=0) used.set(g,(used.get(g)||0)+1); }
 const list=[...used.keys()]; const kinds={}, errs={}, errEx={}; let noGeo=0; for(let i=0;i<F.count;i++) if(F.geom[i]<0) noGeo++;
 for(let s=0;s<list.length;s+=2000){ const recs=await NWD.fetchRecords(f,G,list.slice(s,s+2000),new Map());
  for(const [r,b] of recs){ const n=used.get(r); try{ const rec=NWD.parseRecord(b); const k=rec.skip?'skip'+rec.kind:rec.kind; kinds[k]=(kinds[k]||0)+n; if(rec.kind===94) NWD.meshTriangles(rec); }catch(e){ errs[e.message]=(errs[e.message]||0)+n; errEx[e.message]??=r; } } }
 console.log({fragments:F.count, noGeometry:noGeo, records:list.length, byKind:kinds, errors:errs, example:errEx});
})();
