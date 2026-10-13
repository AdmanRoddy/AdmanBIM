/* NWD/NWC decoder — independent implementation written from analysis of sample files.
   Runs in a browser Web Worker (iPad Safari) and in Node for testing. No dependencies.
   Exposes a single global: NWD. */
var NWD = (function () {
  'use strict';

  /* ------------------------------------------------------------------ inflate (RFC 1950/1951) */
  var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  // Lookup table indexed by the next `bits` input bits (LSB first); entry = symbol << 4 | codeLength.
  function buildTable(lengths, n) {
    var max = 0, i;
    for (i = 0; i < n; i++) if (lengths[i] > max) max = lengths[i];
    if (max === 0) max = 1;
    var count = new Uint16Array(16), next = new Uint16Array(16);
    for (i = 0; i < n; i++) count[lengths[i]]++;
    count[0] = 0;
    var code = 0;
    for (var b = 1; b < 16; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
    var size = 1 << max, table = new Uint32Array(size);
    for (var sym = 0; sym < n; sym++) {
      var len = lengths[sym]; if (!len) continue;
      var c = next[len]++, r = 0;
      for (var k = 0; k < len; k++) r = (r << 1) | ((c >> k) & 1);
      for (var j = r; j < size; j += 1 << len) table[j] = (sym << 4) | len;
    }
    return { t: table, bits: max };
  }
  var FIXED_L, FIXED_D;
  function fixedTables() {
    if (!FIXED_L) {
      var l = new Uint8Array(288), i;
      for (i = 0; i < 144; i++) l[i] = 8; for (; i < 256; i++) l[i] = 9; for (; i < 280; i++) l[i] = 7; for (; i < 288; i++) l[i] = 8;
      FIXED_L = buildTable(l, 288);
      var d = new Uint8Array(30); d.fill(5); FIXED_D = buildTable(d, 30);
    }
  }

  // Inflates one zlib stream starting at src[start]. Returns { data, consumed } (consumed includes header and adler32).
  function inflate(src, start, sizeHint) {
    var pos = start || 0;
    var cmf = src[pos], flg = src[pos + 1];
    if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31 !== 0) throw new Error('not a zlib stream');
    pos += 2; if (flg & 32) pos += 4;
    var out = new Uint8Array(sizeHint > 0 ? sizeHint : Math.max(65536, (src.length - pos) * 4)), op = 0;
    var bb = 0, bc = 0;
    function need(n) { while (bc < n) { bb |= (pos < src.length ? src[pos] : 0) << bc; pos++; bc += 8; } }
    function bits(n) { need(n); var v = bb & ((1 << n) - 1); bb >>>= n; bc -= n; return v; }
    function grow(min) { var n = out.length * 2; while (n < min) n *= 2; var o = new Uint8Array(n); o.set(out.subarray(0, op)); out = o; }
    function decodeSym(tb) {
      need(tb.bits); var e = tb.t[bb & ((1 << tb.bits) - 1)], l = e & 15;
      bb >>>= l; bc -= l; return e >>> 4;
    }
    var final = 0;
    while (!final) {
      final = bits(1); var type = bits(2);
      if (type === 0) {
        pos -= bc >> 3; bb = 0; bc = 0;     // byte align: return unused whole bytes, drop partial bits
        var len = src[pos] | (src[pos + 1] << 8); pos += 4;
        if (op + len > out.length) grow(op + len);
        out.set(src.subarray(pos, pos + len), op); op += len; pos += len;
        continue;
      }
      var lt, dt;
      if (type === 1) { fixedTables(); lt = FIXED_L; dt = FIXED_D; }
      else if (type === 2) {
        var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        var cl = new Uint8Array(19), i;
        for (i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
        var ct = buildTable(cl, 19), lens = new Uint8Array(hlit + hdist);
        for (i = 0; i < hlit + hdist;) {
          var s = decodeSym(ct);
          if (s < 16) lens[i++] = s;
          else if (s === 16) { var prev = lens[i - 1], r = 3 + bits(2); while (r--) lens[i++] = prev; }
          else if (s === 17) { var z = 3 + bits(3); while (z--) lens[i++] = 0; }
          else { var z2 = 11 + bits(7); while (z2--) lens[i++] = 0; }
        }
        lt = buildTable(lens.subarray(0, hlit), hlit); dt = buildTable(lens.subarray(hlit), hdist);
      } else throw new Error('bad deflate block');
      var lmask = (1 << lt.bits) - 1, dmask = (1 << dt.bits) - 1, ltab = lt.t, dtab = dt.t, lbits = lt.bits, dbits = dt.bits;
      for (;;) {
        if (bc < lbits) need(lbits);
        var e = ltab[bb & lmask], l = e & 15; bb >>>= l; bc -= l; var sym = e >>> 4;
        if (sym < 256) { if (op >= out.length) grow(op + 1); out[op++] = sym; continue; }
        if (sym === 256) break;
        sym -= 257;
        var length = LBASE[sym]; if (LEXT[sym]) length += bits(LEXT[sym]);
        if (bc < dbits) need(dbits);
        var e2 = dtab[bb & dmask], l2 = e2 & 15; bb >>>= l2; bc -= l2; var ds = e2 >>> 4;
        var dist = DBASE[ds]; if (DEXT[ds]) dist += bits(DEXT[ds]);
        if (op + length > out.length) grow(op + length);
        var from = op - dist;
        if (dist >= length) { out.copyWithin(op, from, from + length); op += length; }
        else { for (var q = 0; q < length; q++) out[op++] = out[from + q]; }
      }
    }
    // return unused whole bytes of the bit buffer, then skip adler32
    pos -= bc >> 3;
    pos += 4;
    return { data: op === out.length ? out : out.subarray(0, op), consumed: pos - (start || 0) };
  }

  /* ------------------------------------------------------------------ file access */
  // source: { size, read(offset, length) -> Promise<Uint8Array> }
  function blobSource(blob) {
    return {
      size: blob.size, name: blob.name,
      read: function (off, len) { return blob.slice(off, off + len).arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
    };
  }

  // Remote file read with HTTP range requests (server must allow Range + CORS).
  async function urlSource(url) {
    var r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    var cr = r.headers.get('Content-Range'), size = cr ? +cr.split('/')[1] : +r.headers.get('Content-Length');
    if (!size) throw new Error('Server did not report the file size');
    return {
      size: size, name: decodeURIComponent(url.split('/').pop().split('?')[0]),
      read: function (off, len) {
        return fetch(url, { headers: { Range: 'bytes=' + off + '-' + (off + len - 1) } }).then(function (res) {
          if (res.status !== 206 && !(res.status === 200 && off === 0)) throw new Error('Range request failed (' + res.status + ')');
          return res.arrayBuffer();
        }).then(function (b) { return new Uint8Array(b, 0, Math.min(len, b.byteLength)); });
      }
    };
  }

  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  var TD = new TextDecoder('utf-8');

  async function openFile(src) {
    var head = await src.read(0, 128);
    var hl = head.indexOf(10) + 1;
    var header = TD.decode(head.subarray(0, hl - 1));
    if (header.indexOf('#LcUStream') !== 0) throw new Error('Not a Navisworks file (missing LcUStream header)');
    var m = /lichunk-(\d+)/.exec(header);
    if (!m || +m[1] < 8) throw new Error('This file uses an older Navisworks format (' + (m ? 'lichunk-' + m[1] : 'unknown') + '). Save it from Navisworks 2015 or newer.');
    var tail = await src.read(src.size - hl - 8, hl + 8);
    var dirOff = u32(tail, 0) + u32(tail, 4) * 4294967296;
    var dlen = Math.min(1 << 21, src.size - dirOff);
    var dblk = await src.read(dirOff, dlen);
    var dhl = dblk.indexOf(10) + 1;
    var z = (dhl + 7) & ~7; if (dblk[z] !== 0x78) z += 8;
    var dir = inflate(dblk, z).data;
    var r = new Reader(dir);
    r.u32(); var count = r.u32(), sections = [];
    for (var k = 0; k < count; k++) {
      var name = r.str(), version = r.u32(), offset = r.u64(), length = r.u64(), a = r.u32(), b = r.u32();
      sections.push({ name: name.split('\\').pop(), version: version, offset: offset, length: length, a: a, b: b });
    }
    var f = { src: src, header: header, sections: sections, size: src.size };
    f.section = function (n) { for (var i = 0; i < sections.length; i++) if (sections[i].name === n) return sections[i]; return null; };
    return f;
  }

  // Decompress a whole section.
  async function readSection(f, sec, onProgress) {
    if (!sec) return null;
    var raw = await f.src.read(sec.offset, sec.length);
    if (sec.a === 4 && raw[4] === 0x78) {               // [u32 chunkSize] + zlib chunks (+ index member at end)
      var parts = [], total = 0, p = 4, end = sec.length - (sec.b || 0);
      while (p < end && raw[p] === 0x78) {
        var res = inflate(raw, p, u32(raw, 0)); parts.push(res.data); total += res.data.length; p += res.consumed;
        if (onProgress && parts.length % 64 === 0) onProgress(p / end);
      }
      var outb = new Uint8Array(total), o = 0;
      for (var i = 0; i < parts.length; i++) { outb.set(parts[i], o); o += parts[i].length; }
      return outb;
    }
    if (raw[0] === 0x78) return inflate(raw, 0).data;
    return raw;
  }

  /* ------------------------------------------------------------------ binary reader with natural alignment */
  function Reader(b) { this.b = b; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); this.p = 0; }
  Reader.prototype.u32 = function () { this.p = (this.p + 3) & ~3; var v = this.dv.getUint32(this.p, true); this.p += 4; return v; };
  Reader.prototype.i32 = function () { this.p = (this.p + 3) & ~3; var v = this.dv.getInt32(this.p, true); this.p += 4; return v; };
  Reader.prototype.f32 = function () { this.p = (this.p + 3) & ~3; var v = this.dv.getFloat32(this.p, true); this.p += 4; return v; };
  Reader.prototype.f64 = function () { this.p = (this.p + 7) & ~7; var v = this.dv.getFloat64(this.p, true); this.p += 8; return v; };
  Reader.prototype.u64 = function () { this.p = (this.p + 7) & ~7; var lo = this.dv.getUint32(this.p, true), hi = this.dv.getUint32(this.p + 4, true); this.p += 8; return hi * 4294967296 + lo; };
  Reader.prototype.str = function () {
    var n = this.i32(); if (n < 0) return null;
    var s = TD.decode(this.b.subarray(this.p, this.p + n)); this.p += n; this.p = (this.p + 3) & ~3;
    var z = s.indexOf('\0'); return z >= 0 ? s.slice(0, z) : s;
  };
  Reader.prototype.skipStr = function () { var n = this.i32(); if (n > 0) { this.p += n; this.p = (this.p + 3) & ~3; } };

  /* ------------------------------------------------------------------ geometry store (random access) */
  // Index member at the end of LcOpNwdGeometry: [nRecords][nChunks][chunk compressed sizes][record sizes].
  async function openGeometry(f) {
    var sec = f.section('LcOpNwdGeometry'); if (!sec) return null;
    var pre = await f.src.read(sec.offset, 4);
    var ixc = await f.src.read(sec.offset + sec.length - sec.b, sec.b);
    var ix = inflate(ixc, 0).data;
    var nRec = u32(ix, 0), nCh = u32(ix, 4);
    var g = { sec: sec, chunkSize: u32(pre, 0), nRec: nRec, nCh: nCh,
      chunkOff: new Float64Array(nCh + 1), recOff: new Float64Array(nRec + 1), recSize: new Uint32Array(nRec) };
    g.chunkOff[0] = sec.offset + 4;
    for (var i = 0; i < nCh; i++) g.chunkOff[i + 1] = g.chunkOff[i] + u32(ix, 8 + i * 4);
    for (i = 0; i < nRec; i++) { var s = u32(ix, 8 + nCh * 4 + i * 4); g.recSize[i] = s; g.recOff[i + 1] = g.recOff[i] + s; }
    return g;
  }
  // Fetch raw bytes of many records with as few reads as possible. Returns Map(recordIndex -> Uint8Array).
  async function fetchRecords(f, g, list, chunkCache) {
    var cs = g.chunkSize, need = new Map();
    for (var i = 0; i < list.length; i++) {
      var r = list[i], c0 = Math.floor(g.recOff[r] / cs), c1 = Math.floor((g.recOff[r + 1] - 1) / cs);
      for (var c = c0; c <= c1; c++) if (!chunkCache.has(c)) need.set(c, true);
    }
    var chunks = Array.from(need.keys()).sort(function (a, b) { return a - b; });
    // group consecutive chunks into single reads (up to 4 MB)
    for (var k = 0; k < chunks.length;) {
      var a = chunks[k], b = a; k++;
      while (k < chunks.length && chunks[k] === b + 1 && g.chunkOff[chunks[k] + 1] - g.chunkOff[a] < 4194304) { b = chunks[k]; k++; }
      var base = g.chunkOff[a], bytes = await f.src.read(base, g.chunkOff[b + 1] - base);
      for (var c2 = a; c2 <= b; c2++) chunkCache.set(c2, inflate(bytes, g.chunkOff[c2] - base, cs).data);
    }
    var out = new Map();
    for (i = 0; i < list.length; i++) {
      r = list[i];
      var s = g.recOff[r], e = g.recOff[r + 1], first = Math.floor(s / cs), last = Math.floor((e - 1) / cs);
      var buf = new Uint8Array(e - s + 64), o = 0;
      for (c = first; c <= last; c++) {
        var ch = chunkCache.get(c), from = c === first ? s - c * cs : 0, to = c === last ? e - c * cs : ch.length;
        buf.set(ch.subarray(from, to), o); o += to - from;
      }
      out.set(r, buf);
    }
    return out;
  }

  /* ------------------------------------------------------------------ geometry records */
  // Ref stream: 00-3f run of (c+1) new items; 40-7f copy (c-0x40) back; 80-bf repeat previous (c-0x7f) times;
  // c0-df copy (c-0x40) back; e0-ef xx copy 12-bit distance back; f0-ff xx yy copy absolute 20-bit index.
  function decodeRefStream(b, p, n) {
    var idx = new Int32Array(n), out = 0, next = 0, c, k;
    while (out < n) {
      c = b[p++];
      if (c < 0x40) { for (k = 0; k <= c && out < n; k++) idx[out++] = next++; }
      else if (c < 0x80) { idx[out] = idx[out - (c - 0x40)]; out++; }
      else if (c < 0xc0) { for (k = 0; k <= c - 0x80 && out < n; k++) { idx[out] = idx[out - 1]; out++; } }
      else if (c < 0xe0) { idx[out] = idx[out - (c - 0x40)]; out++; }
      else if (c < 0xf0) { idx[out] = idx[out - (((c & 15) << 8) | b[p++])]; out++; }
      else { idx[out] = idx[((c & 15) << 16) | (b[p] << 8) | b[p + 1]]; p += 2; out++; }
    }
    return { idx: idx, p: p, newCount: next };
  }
  function skipCodes(b, p, n) {
    var out = 0, c;
    while (out < n) {
      c = b[p++];
      if (c < 0x40) out += c + 1;
      else if (c >= 0x80 && c < 0xc0) out += c - 0x7f;
      else if (c < 0xe0) out++;
      else if (c < 0xf0) { p++; out++; }
      else { p += 2; out++; }
    }
    return p;
  }
  var normalBytesHint = 6;

  // Parses a geometry record at offset 0 of b. Returns { kind, pos:{n,vals,idx}, strips|polylines } or { kind, skip:true }.
  function parseRecord(b) {
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    var U = function (q) { return dv.getUint32(q, true); }, I = function (q) { return dv.getInt32(q, true); };
    var al4 = function (q) { return (q + 3) & ~3; };
    if (U(0) !== 100) throw new Error('not a geometry record');
    var kind = U(4), p = 8, rec = { kind: kind };
    if (kind !== 94 && kind !== 95 && kind !== 96) { rec.skip = true; return rec; }
    if (U(p) !== 101 || U(p + 4) !== 60) throw new Error('expected positions');
    p += 8;
    function readArray(dim) {
      var n = U(p), nf = U(p + 4); p += 8;
      if (nf % dim) throw new Error('bad array');
      var vals = new Float32Array(nf);
      for (var k = 0; k < nf; k++) vals[k] = dv.getFloat32(p + k * 4, true);
      p += nf * 4;
      var idx = null;
      if (nf / dim < n) { var r = decodeRefStream(b, p, n); idx = r.idx; p = al4(r.p); }
      return { n: n, vals: vals, idx: idx };
    }
    rec.pos = readArray(3);
    var n = rec.pos.n, id = 102;
    if (kind === 96) return rec;
    function readPacked(q, count, bitsPer) {
      var lens = new Uint32Array(count), bit = 0, sum = 0;
      for (var k = 0; k < count; k++) {
        var v = 0;
        for (var j = 0; j < bitsPer; j++, bit++) { var w = U(q + (bit >> 5) * 4); v = (v << 1) | ((w >>> (31 - (bit & 31))) & 1); }
        lens[k] = v; sum += v;
      }
      return { lens: lens, sum: sum, end: q + Math.ceil(bitsPer * count / 32) * 4 };
    }
    if (kind === 95) {
      var g = 0; while (g < 64 && U(p) === 0) { p += 4; g += 4; }
      if (U(p) === id && U(p + 4) === 58) {
        p += 8; var nc = -I(p + 4), ne = U(p + 8); p += 12;
        rec.colors = []; for (var k = 0; k < ne; k++) rec.colors.push(U(p + k * 4)); p += ne * 4;
        p = al4(skipCodes(b, p, nc));
      }
      for (var q = p; q < p + 32; q += 4) {
        var B = U(q + 4), C = U(q + 8);
        if (B < 1 || B > 32 || C < 1 || C > n) continue;
        var pk = readPacked(q + 12, C, B);
        if (pk.sum === n) { rec.polylines = pk.lens; return rec; }
      }
      throw new Error('bad polyline table');
    }
    function readStrips(q) { try { return readStripsAt(q); } catch (e) { return null; } }
    function readStripsAt(q) {
      if (q + 12 > b.length) return null;
      var A = U(q), B = U(q + 4), C = U(q + 8);
      if (B < 1 || B > 32 || C < 1 || C > 5e6) return null;
      var pk = readPacked(q + 12, C, B), e = pk.end;
      var nIdx = U(e); e += 4; var indices = null;
      if (nIdx) {
        if (nIdx !== pk.sum) return null;
        var r = decodeRefStream(b, e, nIdx); if (r.newCount > n) return null;
        indices = r.idx; e = al4(r.p);
      } else if (pk.sum !== n) return null;
      return { lens: pk.lens, indices: indices, end: e };
    }
    function valid(q, k, nextId) {
      if (k === 0) return readStrips(q) !== null || (U(q) === 0 && readStrips(q + 4) !== null);
      if (U(q) === 0) return valid(q + 4, k - 1, nextId);
      var c = U(q + 4); return U(q) === nextId && (c === 61 || c === 100 || c === 58);
    }
    for (var slot = 0; slot < 3; slot++) {
      if (U(p) === 0) { p += 4; continue; }
      if (U(p) !== id) throw new Error('bad mesh slot');
      var t = U(p + 4); p += 8; id++;
      var remaining = 2 - slot;
      if (t === 61) {
        if (I(p) >= 0) { readArray(2); continue; }
        var un = -I(p), lim = Math.min(b.length - 16, p + 16 * un + 8192), qq = p + 4;
        while (qq <= lim && !(U(qq) === id && I(qq + 8) === -un && (U(qq + 4) === 100 || U(qq + 4) === 58)) && !valid(qq, remaining, id)) qq += 4;
        if (qq > lim) throw new Error('quantized uv end not found');
        p = qq;
      } else if (t === 100) {
        var nn = -I(p), nex = U(p + 4); p += 8;
        var sizes = normalBytesHint === 3 ? [3, 6] : [6, 3], done = false;
        for (var si = 0; si < 2 && !done; si++) {
          var cs = al4(p + nex * sizes[si]), e2 = nex === nn ? cs : al4(skipCodes(b, cs, nn));
          if (valid(e2, remaining, id)) { p = e2; normalBytesHint = sizes[si]; done = true; }
        }
        if (!done) throw new Error('normals end not found');
      } else if (t === 58) {
        var nc2 = -I(p + 4), ne2 = U(p + 8); p += 12;
        rec.colors = []; for (var k2 = 0; k2 < ne2; k2++) rec.colors.push(U(p + k2 * 4)); p += ne2 * 4;
        p = al4(skipCodes(b, p, nc2));
      } else throw new Error('unknown mesh child ' + t);
    }
    var s = readStrips(p); if (!s && U(p) === 0) s = readStrips(p + 4);
    if (!s) throw new Error('bad strip table');
    rec.strips = s;
    return rec;
  }

  // Turns a parsed mesh record into indexed triangles with smooth per-strip normals.
  // Returns { pos: Float32Array(n*3), nrm: Int8Array(n*3), index: Uint32Array, tris } in record-local coordinates.
  function meshTriangles(rec) {
    var P = rec.pos, n = P.n, vals = P.vals, idx = P.idx;
    var pos = new Float32Array(n * 3);
    for (var k = 0; k < n; k++) { var u = (idx ? idx[k] : k) * 3; pos[k * 3] = vals[u]; pos[k * 3 + 1] = vals[u + 1]; pos[k * 3 + 2] = vals[u + 2]; }
    var I = rec.strips.indices, lens = rec.strips.lens, total = 0, i;
    for (i = 0; i < lens.length; i++) if (lens[i] > 2) total += lens[i] - 2;
    var tri = new Uint32Array(total * 3), t = 0, s = 0;
    var acc = new Float32Array(n * 3);
    for (i = 0; i < lens.length; i++) {
      var len = lens[i];
      for (var j = 2; j < len; j++) {
        var a = I ? I[s + j - 2] : s + j - 2, b = I ? I[s + j - 1] : s + j - 1, c = I ? I[s + j] : s + j;
        if (a === b || b === c || a === c) continue;
        if (j & 1) { var x = a; a = b; b = x; }
        tri[t++] = a; tri[t++] = b; tri[t++] = c;
        var ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
        var e1x = pos[b * 3] - ax, e1y = pos[b * 3 + 1] - ay, e1z = pos[b * 3 + 2] - az;
        var e2x = pos[c * 3] - ax, e2y = pos[c * 3 + 1] - ay, e2z = pos[c * 3 + 2] - az;
        var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        acc[a * 3] += nx; acc[a * 3 + 1] += ny; acc[a * 3 + 2] += nz;
        acc[b * 3] += nx; acc[b * 3 + 1] += ny; acc[b * 3 + 2] += nz;
        acc[c * 3] += nx; acc[c * 3 + 1] += ny; acc[c * 3 + 2] += nz;
      }
      s += len;
    }
    var nrm = new Int8Array(n * 3);
    for (k = 0; k < n; k++) {
      var X = acc[k * 3], Y = acc[k * 3 + 1], Z = acc[k * 3 + 2], L = Math.sqrt(X * X + Y * Y + Z * Z) || 1;
      nrm[k * 3] = Math.round(X / L * 127); nrm[k * 3 + 1] = Math.round(Y / L * 127); nrm[k * 3 + 2] = Math.round(Z / L * 127);
    }
    return { pos: pos, nrm: nrm, index: t === tri.length ? tri : tri.subarray(0, t), tris: t / 3 };
  }
  function lineSegments(rec) {
    var P = rec.pos, n = P.n, pos = new Float32Array(n * 3);
    for (var k = 0; k < n; k++) { var u = (P.idx ? P.idx[k] : k) * 3; pos[k * 3] = P.vals[u]; pos[k * 3 + 1] = P.vals[u + 1]; pos[k * 3 + 2] = P.vals[u + 2]; }
    var seg = [], s = 0;
    for (var i = 0; i < rec.polylines.length; i++) { var L = rec.polylines[i]; for (var j = 1; j < L; j++) seg.push(s + j - 1, s + j); s += L; }
    return { pos: pos, index: Uint32Array.from(seg) };
  }

  /* ------------------------------------------------------------------ growable typed arrays */
  function Grow(T, n) { this.T = T; this.a = new T(n || 1024); this.n = 0; }
  Grow.prototype.push = function (v) { if (this.n >= this.a.length) { var b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; return this.n - 1; };
  Grow.prototype.done = function () { return this.a.subarray(0, this.n); };

  function quatMat(x, y, z, w) {
    return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
  }
  /* ------------------------------------------------------------------ fragments */
    var X = { t: new Grow(Float64Array, 1 << 16), m: new Grow(Float32Array, 1 << 17), n: 0 };
  function parseFragments(buf) {
    var r = new Reader(buf), dv = r.dv;
    var kindOf = new Grow(Int32Array, 1 << 16), idxOf = new Grow(Int32Array, 1 << 16);  // by object id - 100
    var nextId = 100;
    var X = { t: new Grow(Float64Array, 1 << 16), m: new Grow(Float32Array, 1 << 17), n: 0 };
    var G = { geom: new Grow(Int32Array), box: new Grow(Float32Array), off: new Grow(Float64Array), n: 0 };
    var mats = [], apps = [];
    var F = { geo: new Grow(Int32Array, 1 << 16), node: new Grow(Int32Array, 1 << 16), xf: new Grow(Int32Array, 1 << 16), app: new Grow(Int32Array, 1 << 16) };
    var K_FRAG = 1, K_XF = 2, K_APP = 3, K_MAT = 4, K_GEO = 5, K_OTHER = 6;
    function reg(id, kind, index) { var k = id - 100; while (kindOf.n <= k) { kindOf.push(0); idxOf.push(-1); } kindOf.a[k] = kind; idxOf.a[k] = index; }
    function ptr() {
      var at = r.p, v = r.u32();
      if (v === 0) return null;
      if (v === 1) { var id = r.u32(); return { kind: kindOf.a[id - 100], index: idxOf.a[id - 100] }; }
      if (v !== nextId) throw new Error('fragments: expected object ' + nextId + ' at ' + at);
      nextId++; var cls = r.u32(); return readObject(v, cls);
    }
    function readObject(id, cls) {
      var o;
      switch (cls) {
        case 13: {
          r.f64(); r.u32(); r.u32(); r.u32(); var x = r.u32();
          var fi = F.node.push(x); F.geo.push(-1); F.xf.push(-1); F.app.push(-1);
          reg(id, K_FRAG, fi);
          var xf = ptr(), ap = ptr(), ge = ptr();
          F.xf.a[fi] = xf ? xf.index : -1; F.app.a[fi] = ap ? ap.index : -1; F.geo.a[fi] = ge ? ge.index : -1;
          return { kind: K_FRAG, index: fi };
        }
        case 14: case 15: case 16: case 17: {
          // 14 translation; 15 translation + rotation; 16 + uniform scale; 17 3x3 matrix (f32 rows of 4) + translation.
          // Stored as a row-major 3x3 matrix (rotation x scale) plus translation.
          var xi = X.n++, m;
          if (cls === 17) {
            m = []; for (var rr = 0; rr < 3; rr++) for (var cc = 0; cc < 4; cc++) { var fv = r.f32(); if (cc < 3) m.push(fv); }
            r.f32();
            X.t.push(r.f64()); X.t.push(r.f64()); X.t.push(r.f64());
          } else {
            X.t.push(r.f64()); X.t.push(r.f64()); X.t.push(r.f64());
            if (cls === 14) m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
            else { var qx = r.f64(), qy = r.f64(), qz = r.f64(), qw = r.f64(), sc = cls === 16 ? r.f64() : 1; m = quatMat(qx, qy, qz, qw).map(function (v) { return v * sc; }); }
          }
          for (var mk = 0; mk < 9; mk++) X.m.push(m[mk]);
          reg(id, K_XF, xi); return { kind: K_XF, index: xi };
        }
        case 55: {
          var flags = r.u32(), m = ptr(); if (flags & 0x20) ptr(); if (flags & 0x08) r.u32();  // 0x20: material asset, 0x08: texture/mapping id
          var ai = apps.length; apps.push({ flags: flags, mat: m ? m.index : -1 }); reg(id, K_APP, ai); return { kind: K_APP, index: ai };
        }
        case 54: {
          var c = []; for (var k = 0; k < 14; k++) c.push(r.f32());
          var mi = mats.length; mats.push(c); reg(id, K_MAT, mi); return { kind: K_MAT, index: mi };
        }
        case 93: {
          var gi = G.n++; for (var k2 = 0; k2 < 6; k2++) G.box.push(r.f32());
          G.off.push(r.f64()); G.off.push(r.f64()); G.off.push(r.f64()); r.f32(); r.u32(); G.geom.push(r.u32() - 1);
          reg(id, K_GEO, gi); return { kind: K_GEO, index: gi };
        }
        case 185: {
          r.skipStr(); r.skipStr(); var nf = r.u32();
          for (var k3 = 0; k3 < nf; k3++) { r.skipStr(); var emb = r.u32(); if (emb) { r.skipStr(); r.skipStr(); var len = r.u64(); r.p = (r.p + len + 3) & ~3; } else r.skipStr(); }
          reg(id, K_OTHER, -1); return { kind: K_OTHER, index: -1 };
        }
        default: throw new Error('fragments: unknown class ' + cls + ' at ' + r.p);
      }
    }
    var count = r.u32();
    for (var i = 0; i < count && r.p + 4 <= buf.length; i++) { if (!ptr()) break; }
    var nF = F.node.n;
    // resolve to per-fragment arrays
    var geom = new Int32Array(nF), node = F.node.done().slice(), xfi = F.xf.done().slice(), mat = new Int32Array(nF), gbox = new Int32Array(nF);
    for (i = 0; i < nF; i++) {
      var g = F.geo.a[i]; geom[i] = g >= 0 ? G.geom.a[g] : -1; gbox[i] = g;
      var a = F.app.a[i]; mat[i] = a >= 0 ? apps[a].mat : -1;
    }
    return { count: nF, geom: geom, node: node, xf: xfi, mat: mat, gbox: gbox,
      xfT: X.t.done(), xfM: X.m.done(), boxes: G.box.done(), offsets: G.off.done(), materials: mats };
  }

  /* ------------------------------------------------------------------ logical hierarchy (model tree + properties) */
  // Compact representation. Node objects are unique; the walk (DFS with shared subtrees expanded) gives
  // the "path index" used by fragments (fragment.node).
  function parseHierarchy(buf) {
    var r = new Reader(buf), dv = r.dv;
    var strings = [], strIndex = new Map();
    function sid(s) { if (s === null || s === undefined) return -1; var i = strIndex.get(s); if (i === undefined) { i = strings.length; strings.push(s); strIndex.set(s, i); } return i; }
    var objKind = new Grow(Int32Array, 1 << 16);   // (index << 4) | kind, by id - 100
    var K_NODE = 1, K_PAIR = 2, K_PROPS = 3, K_MAT = 4, K_LINK = 5, K_XF = 6, K_OTHER = 7;
    var N = { name: new Grow(Int32Array, 1 << 16), pair: new Grow(Int32Array, 1 << 16), flags: new Grow(Uint32Array, 1 << 16), cls: new Grow(Uint8Array, 1 << 16),
      attrStart: new Grow(Int32Array, 1 << 16), attrCount: new Grow(Uint16Array, 1 << 16), childStart: new Grow(Int32Array, 1 << 16), childCount: new Grow(Int32Array, 1 << 16) };
    var attrList = new Grow(Int32Array, 1 << 16), childList = new Grow(Int32Array, 1 << 16);
    var pairs = [], props = [], mats = [], links = [], xfs = [];
    var nextId = 100;
    function reg(id, v) { var k = id - 100; while (objKind.n <= k) objKind.push(0); objKind.a[k] = v; }
    function ptr() {
      var at = r.p, v = r.u32();
      if (v === 0) return 0;
      if (v === 1) { var id = r.u32(); return objKind.a[id - 100]; }
      if (v === 2) { r.u32(); return 0; }   // shared node table reference (not used by the files seen so far)
      if (v !== nextId) throw new Error('tree: expected object ' + nextId + ', got ' + v + ' at ' + at);
      nextId++; var cls = r.u32(); return readObject(v, cls);
    }
    function value(type) {
      switch (type) {
        case 0: return null;
        case 1: return r.f64();
        case 2: return r.i32();
        case 3: return !!r.u32();
        case 4: return r.str();
        case 5: return r.f32();
        case 6: return { len: r.f64() };
        case 7: return { ang: r.f64() };
        case 8: { var o = ptr(); return (o & 15) === K_PAIR ? { pair: o >> 4 } : null; }
        case 10: return { area: r.f64() };
        case 11: return { vol: r.f64() };
        default: throw new Error('tree: unknown property type ' + type + ' at ' + r.p);
      }
    }
    function nodeBody(id, cls, pre) {
      var ni = N.name.push(-1); N.pair.push(-1); N.flags.push(0); N.cls.push(cls); N.attrStart.push(0); N.attrCount.push(0); N.childStart.push(0); N.childCount.push(0);
      var kv = (ni << 4) | K_NODE; reg(id, kv);
      if (pre) r.u32();
      if (cls !== 15 && cls !== 2) {
        N.name.a[ni] = sid(r.str());
        var pr = ptr(); N.pair.a[ni] = (pr & 15) === K_PAIR ? pr >> 4 : -1;
        N.flags.a[ni] = r.u32(); r.u32();
        var na = r.u32(), at = []; for (var k = 0; k < na; k++) { var a = ptr(); if (a) at.push(a); }
        N.attrStart.a[ni] = attrList.n; N.attrCount.a[ni] = at.length; for (k = 0; k < at.length; k++) attrList.push(at[k]);
        if (cls !== 22) {
          var nc = r.u32(), ch = []; for (k = 0; k < nc; k++) { var c = ptr(); if ((c & 15) === K_NODE) ch.push(c >> 4); }
          N.childStart.a[ni] = childList.n; N.childCount.a[ni] = ch.length; for (k = 0; k < ch.length; k++) childList.push(ch[k]);
        }
      } else {
        // root: a sequence of partitions; non-pointer words are per-file info blocks we skip
        var ch2 = [];
        while (r.p + 4 <= buf.length) {
          var w = dv.getUint32(r.p, true);
          if (w === nextId) { var c2 = ptr(); if ((c2 & 15) === K_NODE) ch2.push(c2 >> 4); }
          else r.p += 4;
        }
        N.childStart.a[ni] = childList.n; N.childCount.a[ni] = ch2.length; for (var k4 = 0; k4 < ch2.length; k4++) childList.push(ch2[k4]);
      }
      return kv;
    }
    function attrHead() { var name = r.str(); ptr(); r.u32(); return name; }
    function readObject(id, cls) {
      var v;
      switch (cls) {
        case 53: case 22: case 15: case 2: return nodeBody(id, cls, false);
        case 32: return nodeBody(id, cls, true);
        case 52: { var pi = pairs.length; pairs.push([sid(r.str()), sid(r.str())]); v = (pi << 4) | K_PAIR; reg(id, v); return v; }
        case 86: {
          var pidx = props.length, P = { name: null, cat: -1, items: [] }; props.push(P); v = (pidx << 4) | K_PROPS; reg(id, v);
          P.name = r.str(); var cp = ptr(); P.cat = (cp & 15) === K_PAIR ? cp >> 4 : -1; r.u32(); var n = r.u32();
          for (var k = 0; k < n; k++) { var kp = ptr(), type = r.u32(); P.items.push([(kp & 15) === K_PAIR ? kp >> 4 : -1, type, value(type)]); }
          return v;
        }
        case 31: {
          var mi = mats.length; v = (mi << 4) | K_MAT; reg(id, v);
          var M = { name: attrHead(), c: [] }; for (var k5 = 0; k5 < 14; k5++) M.c.push(r.f64()); mats.push(M); return v;
        }
        case 39: { var xi = xfs.length; v = (xi << 4) | K_XF; reg(id, v); attrHead(); var m = []; for (var k6 = 0; k6 < 12; k6++) m.push(r.f64()); r.u32(); xfs.push({ m: m }); return v; }
        case 40: { xi = xfs.length; v = (xi << 4) | K_XF; reg(id, v); attrHead(); xfs.push({ t: [r.f64(), r.f64(), r.f64()] }); return v; }
        case 41: { xi = xfs.length; v = (xi << 4) | K_XF; reg(id, v); attrHead(); xfs.push({ t: [r.f64(), r.f64(), r.f64()], q: [r.f64(), r.f64(), r.f64(), r.f64()] }); return v; }
        case 79: {
          var li = links.length; v = (li << 4) | K_LINK; reg(id, v);
          var L = { name: attrHead(), items: [] }; var nl = r.u32();
          for (var k7 = 0; k7 < nl; k7++) { var nm = r.str(), url = r.str(); ptr(); r.u32(); L.items.push([nm, url]); }
          links.push(L); return v;
        }
        case 200: { v = K_OTHER; reg(id, v); attrHead(); ptr(); return v; }
        case 185: {
          v = K_OTHER; reg(id, v); r.skipStr(); r.skipStr(); var nf = r.u32();
          for (var k8 = 0; k8 < nf; k8++) { r.skipStr(); var emb = r.u32(); if (emb) { r.skipStr(); r.skipStr(); var len = r.u64(); r.p = (r.p + len + 3) & ~3; } else r.skipStr(); }
          return v;
        }
        case 27: case 28: case 29: { v = K_OTHER; reg(id, v); r.u32(); ptr(); for (var k9 = 0; k9 < 7; k9++) r.u32(); for (k9 = 0; k9 < ({ 27: 9, 28: 13, 29: 18 })[cls]; k9++) r.f64(); return v; }  // distant / point / spot light
        default: throw new Error('tree: unknown object class ' + cls + ' at ' + r.p);
      }
    }
    var nParts = r.u32(); for (var i = 0; i < nParts; i++) r.u32();
    // Root object: [id 100][child count] (no class word), then its children.
    var rootId = r.u32(); if (rootId !== nextId) throw new Error('tree: unexpected root ' + rootId);
    nextId++; r.u32();
    var root = nodeBody(rootId, 15, false);
    var nodes = { name: N.name.done(), pair: N.pair.done(), flags: N.flags.done(), cls: N.cls.done(), attrStart: N.attrStart.done(), attrCount: N.attrCount.done(), childStart: N.childStart.done(), childCount: N.childCount.done(), count: N.name.n };
    // DFS walk with shared subtrees expanded: path index -> node, parent path, subtree end
    var wNode = new Grow(Int32Array, nodes.count + 1024), wParent = new Grow(Int32Array, nodes.count + 1024), wEnd = new Grow(Int32Array, nodes.count + 1024);
    var cl = childList.done();
    var stack = [[root >> 4, -1, 0]];
    // iterative DFS: entries [node, parentPath, nextChildCursor]; record end when done
    var rootNode = root >> 4;
    var pathStack = [];
    function visit(nodeIdx, parent) { var w = wNode.push(nodeIdx); wParent.push(parent); wEnd.push(0); return w; }
    var w0 = visit(rootNode, -1); pathStack.push([w0, rootNode, 0]);
    while (pathStack.length) {
      var top = pathStack[pathStack.length - 1], ni2 = top[1];
      if (top[2] < nodes.childCount[ni2]) {
        var child = cl[nodes.childStart[ni2] + top[2]++];
        var w = visit(child, top[0]); pathStack.push([w, child, 0]);
      } else { wEnd.a[top[0]] = wNode.n; pathStack.pop(); }
    }
    return { strings: strings, pairs: pairs, props: props, materials: mats, links: links, xfs: xfs, nodes: nodes, attrList: attrList.done(),
      walk: { node: wNode.done(), parent: wParent.done(), end: wEnd.done(), count: wNode.n },
      K: { NODE: K_NODE, PAIR: K_PAIR, PROPS: K_PROPS, MAT: K_MAT, LINK: K_LINK, XF: K_XF } };
  }

  /* ------------------------------------------------------------------ saved viewpoints (structured, newer files) */
  // Tree of items: [u32 count] then items: [u32 kind][str name][u32 0][16-byte GUID][u32 0]
  //   kind 4 (folder): [u32 childCount] children...
  //   kind 0 (view):   [u32 savedFlags][u32 0] f64 pos[3], quat[4], aspect, fov, focal, far, ... sectioning block with 6 planes
  function parseViewTree(buf) {
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), len = buf.length;
    function strAt(p) { var n = dv.getInt32(p, true); if (n < 0 || n > 400 || p + 4 + n > len) return null; for (var k = 0; k < n; k++) { var c = buf[p + 4 + k]; if (c < 32 && c !== 9) return null; } return { s: TD.decode(buf.subarray(p + 4, p + 4 + n)), end: (p + 4 + n + 3) & ~3 }; }
    function headerAt(p) {   // returns item header or null
      if (p + 32 > len) return null;
      var kind = dv.getUint32(p, true); if (kind !== 0 && kind !== 4) return null;
      var s = strAt(p + 4); if (!s || !s.s) return null;
      var q = s.end; if (dv.getUint32(q, true) !== 0 || dv.getUint32(q + 20, true) !== 0) return null;
      return { kind: kind, name: s.s, after: q + 24 };
    }
    function nextHeader(p) { for (var q = (p + 3) & ~3; q + 32 <= len; q += 4) { var h = headerAt(q); if (h && (h.kind === 4 ? dv.getUint32(h.after, true) < 10000 : true)) { if (h.kind === 0 && dv.getUint32(h.after, true) === 0) continue; return q; } } return len; }
    var p = 0;
    function item(depth) {
      var h = headerAt(p); if (!h) throw new Error('viewpoint item expected at ' + p);
      if (h.kind === 4) {
        var n = dv.getUint32(h.after, true), node = { name: h.name, folder: true, children: [] }; p = h.after + 4;
        for (var i = 0; i < n; i++) node.children.push(item(depth + 1));
        return node;
      }
      var flags = dv.getUint32(h.after, true), q = (h.after + 8 + 7) & ~7;
      var f = function (k) { return dv.getFloat64(q + k * 8, true); };
      var ortho = dv.getUint32(h.after + 4, true) === 1;
      var v = { name: h.name, flags: flags, pos: [f(0), f(1), f(2)], quat: [f(3), f(4), f(5), f(6)], aspect: f(7), fov: f(8), focal: f(9), far: f(10), ortho: ortho };
      if (ortho) { v.orthoHeight = f(8); v.fov = Math.PI / 4; v.focal = 0; }
      if (!(v.fov > 0.05 && v.fov < 3)) v.fov = Math.PI / 4;
      var end = nextHeader(q + 88);
      // sectioning block: [u32 mode][u32 enabled][u32 planeId][u32 0] then per plane [u32 id][pad] f64 point[3] normal[3] axis[3]
      for (var s = q + 88; s + 96 < end; s += 4) {
        var a = dv.getUint32(s, true), en = dv.getUint32(s + 4, true), id = dv.getUint32(s + 8, true), z = dv.getUint32(s + 12, true);
        if (a === 6 && (en === 0 || en === 1) && id >= 1 && id <= 7 && z === 0 && ((s + 16) & 7) === 0) {
          var b = s + 16, P = [], N = [];
          for (var k = 0; k < 3; k++) { P.push(dv.getFloat64(b + k * 8, true)); N.push(dv.getFloat64(b + 24 + k * 8, true)); }
          var nl = Math.hypot(N[0], N[1], N[2]);
          if (nl > 0.5 && nl < 1.5) v.section = { enabled: en === 1, planes: [{ p: P, n: N }] };
          break;
        }
      }
      p = end;
      return v;
    }
    var count = dv.getUint32(0, true); if (count < 1 || count > 100000) throw new Error('not a view tree');
    p = 4; var out = [];
    for (var i = 0; i < count && p < len; i++) out.push(item(0));
    var good = 0; (function walk(a) { a.forEach(function (x) { if (x.folder) walk(x.children); else if (Math.abs(x.quat[0] * x.quat[0] + x.quat[1] * x.quat[1] + x.quat[2] * x.quat[2] + x.quat[3] * x.quat[3] - 1) < 1e-4) good++; }); })(out);
    if (!good) throw new Error('no cameras');
    return out;
  }

  /* ------------------------------------------------------------------ saved viewpoints (camera only, fallback) */
  // Viewpoint entries contain a name, then a camera block: position (3 x f64) followed by a unit quaternion (4 x f64).
  function parseSavedViews(buf) {
    var views = [], dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // find name strings followed (within 256 bytes) by an 8-aligned [pos3][quat4] where quat is unit length
    for (var p = 0; p + 8 < buf.length; p += 4) {
      var n = dv.getInt32(p, true);
      if (n < 1 || n > 200 || p + 4 + n > buf.length) continue;
      var ok = true; for (var k = 0; k < n; k++) { var c = buf[p + 4 + k]; if (c < 32 && c !== 9) { ok = false; break; } }
      if (!ok) continue;
      var name = TD.decode(buf.subarray(p + 4, p + 4 + n)); if (/^\{.*\}$/.test(name) || name.length < 2) continue;
      for (var q = (p + 4 + n + 7) & ~7; q < p + 400 && q + 64 <= buf.length; q += 8) {
        var qx = dv.getFloat64(q + 24, true), qy = dv.getFloat64(q + 32, true), qz = dv.getFloat64(q + 40, true), qw = dv.getFloat64(q + 48, true);
        var L = qx * qx + qy * qy + qz * qz + qw * qw;
        if (Math.abs(L - 1) < 1e-6 && (qx || qy || qz)) {
          var px = dv.getFloat64(q, true), py = dv.getFloat64(q + 8, true), pz = dv.getFloat64(q + 16, true);
          if ([px, py, pz].every(function (v) { return isFinite(v) && Math.abs(v) < 1e9; }) && (px || py || pz)) {
            var fd = dv.getFloat64(q + 64, true);
            views.push({ name: name, pos: [px, py, pz], quat: [qx, qy, qz, qw], focal: isFinite(fd) && fd > 0 && fd < 1e7 ? fd : 0 });
            p = q + 56; break;
          }
        }
      }
    }
    return views;
  }

  return { inflate: inflate, blobSource: blobSource, urlSource: urlSource, openFile: openFile, readSection: readSection, Reader: Reader,
    openGeometry: openGeometry, fetchRecords: fetchRecords, parseRecord: parseRecord, meshTriangles: meshTriangles, lineSegments: lineSegments,
    parseFragments: parseFragments, parseHierarchy: parseHierarchy, parseSavedViews: parseSavedViews, parseViewTree: parseViewTree };
})();
if (typeof module !== 'undefined') module.exports = NWD;
