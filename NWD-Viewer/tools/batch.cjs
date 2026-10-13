// Runs the reader over many files: node tools/batch.cjs list.txt
const fs=require('fs'),path=require('path'); const NWD=require('../src/core.js');
function src(p){const fd=fs.openSync(p,'r'),size=fs.fstatSync(fd).size;return{size,fd,read:async(o,l)=>{const b=Buffer.alloc(l);fs.readSync(fd,b,0,l,o);return new Uint8Array(b.buffer,b.byteOffset,l);}};}
(async()=>{ const files=fs.readFileSync(process.argv[2],'utf8').split('\n').map(s=>s.trim()).filter(Boolean);
 for(const p of files){ const t0=Date.now(); let stage='open', s;
  try { s=src(p); const f=await NWD.openFile(s);
   stage='fragments'; const F=NWD.parseFragments(await NWD.readSection(f,f.section('LcOpNwdFragments')));
   stage='tree'; const H=NWD.parseHierarchy(await NWD.readSection(f,f.section('LcOpNwdLogicalHierarchy')));
   let bad=0; for(let i=0;i<F.count;i++){ const n=H.walk.node[F.node[i]]; if(n===undefined||H.nodes.cls[n]!==22) bad++; }
   stage='views'; let vinfo='-'; const sv=f.section('LcOpSavedViewsElement'); if(sv){ const vb=await NWD.readSection(f,sv); try{ NWD.parseViewTree(vb); vinfo='tree'; }catch(e){ vinfo='flat:'+NWD.parseSavedViews(vb).length; } }
   stage='geometry'; const G=await NWD.openGeometry(f); const pick=[]; for(let i=0;i<150;i++) pick.push(Math.floor(Math.random()*G.nRec)); const recs=await NWD.fetchRecords(f,G,pick,new Map()); let ge=0; for(const b of recs.values()){ try{ const r=NWD.parseRecord(b); if(r.kind===94) NWD.meshTriangles(r); }catch(e){ ge++; } }
   console.log('OK  ', path.basename(p), `frags ${F.count} nodes ${H.nodes.count} badLink ${bad} views ${vinfo} geomErr ${ge}/${recs.size}`, ((Date.now()-t0)/1000).toFixed(1)+'s');
  } catch(e){ console.log('FAIL', path.basename(p), stage+':', String(e.message).slice(0,160)); }
  finally { if(s) fs.closeSync(s.fd); } }
})();
