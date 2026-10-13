const fs=require('fs'); const NWD=require('../src/core.js');
function src(p){const fd=fs.openSync(p,'r'),size=fs.fstatSync(fd).size;return{size,read:async(o,l)=>{const b=Buffer.alloc(l);fs.readSync(fd,b,0,l,o);return new Uint8Array(b.buffer,b.byteOffset,l);}};}
(async()=>{ for(const p of process.argv.slice(2)){ const f=await NWD.openFile(src(p)); const F=NWD.parseFragments(await NWD.readSection(f,f.section('LcOpNwdFragments')));
 let noXf=0,noXfOff=0,xfOff=0,xf=0; const exN=[],exX=[];
 for(let i=0;i<F.count;i++){ const g=F.gbox[i]; if(g<0) continue; const o=[F.offsets[g*3],F.offsets[g*3+1],F.offsets[g*3+2]]; const nz=o.some(v=>Math.abs(v)>1e-6);
  if(F.xf[i]<0){ noXf++; if(nz){ noXfOff++; if(exN.length<2) exN.push(o.map(v=>+v.toFixed(1))); } } else { xf++; if(nz){ xfOff++; if(exX.length<2) exX.push({off:o.map(v=>+v.toFixed(1)), t:Array.from(F.xfT.subarray(F.xf[i]*3,F.xf[i]*3+3)).map(v=>+v.toFixed(1))}); } } }
 console.log(p.split('/').pop(), {noXf, noXfWithOffset:noXfOff, withXf:xf, withXfAndOffset:xfOff}, JSON.stringify(exN), JSON.stringify(exX)); } })();
