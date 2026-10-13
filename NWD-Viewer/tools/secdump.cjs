// node tools/secdump.cjs file section offset [bytes]
const fs=require('fs'); const NWD=require('../src/core.js');
function src(p){const fd=fs.openSync(p,'r'),size=fs.fstatSync(fd).size;return{size,read:async(o,l)=>{const b=Buffer.alloc(l);fs.readSync(fd,b,0,l,o);return new Uint8Array(b.buffer,b.byteOffset,l);}};}
(async()=>{ const [,,p,sec,off,n]=process.argv; const f=await NWD.openFile(src(p)); const b=Buffer.from(await NWD.readSection(f,f.section(sec)));
 const o=+off, N=+(n||400); for(let q=o&~3;q<Math.min(b.length,o+N);q+=16){ const w=[]; for(let k=0;k<16&&q+k+4<=b.length;k+=4) w.push(b.readUInt32LE(q+k).toString(16).padStart(8)); const d=q%8===0?[b.readDoubleLE(q).toPrecision(6),b.readDoubleLE(q+8).toPrecision(6)].join(' '):''; console.log(String(q).padStart(10), w.join(' '), ' ', b.subarray(q,q+16).toString('latin1').replace(/[^\x20-\x7e]/g,'.'), ' ', d); } })();
