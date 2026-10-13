/* Viewer worker: owns the open file, the model tree, the spatial index and the geometry cache.
   Concatenated after core.js at build time. Talks to the page through postMessage. */
'use strict';
var S = null;              // current model state
var gen = 0;               // view generation (newer camera requests cancel older work)

function post(type, data, transfer) { data = data || {}; data.type = type; self.postMessage(data, transfer || []); }
function progress(stage, frac) { post('progress', { stage: stage, frac: frac }); }

self.onmessage = function (e) {
  var m = e.data;
  var fn = HANDLERS[m.type];
  if (!fn) return;
  Promise.resolve().then(function () { return fn(m); }).then(function (res) {
    if (m.rid !== undefined) post('reply', { rid: m.rid, result: res }, res && res.__transfer ? res.__transfer : []);
  }).catch(function (err) {
    if (m.rid !== undefined) post('reply', { rid: m.rid, error: String(err && err.message || err) });
    else post('error', { message: String(err && err.stack || err) });
  });
};

/* ------------------------------------------------------------------ node classification */
var T_ROOT = 0, T_FILE = 1, T_LAYER = 2, T_GROUP = 3, T_INSTANCE = 4, T_COMPOSITE = 5, T_GEOMETRY = 6;
function nodeType(n) {
  var N = S.H.nodes, cls = N.cls[n], f = N.flags[n];
  if (cls === 15 || cls === 2) return T_ROOT;
  if (cls === 32) return T_FILE;
  if (cls === 22) return T_GEOMETRY;
  if ((f & 0xc0000) === 0xc0000) return T_GROUP;
  if (f & 0x80000) return T_LAYER;
  if (f & 0x40000) return T_INSTANCE;
  if (f & 0x200000) return T_COMPOSITE;
  return T_GROUP;
}
function str(i) { return i >= 0 ? S.H.strings[i] : ''; }
function pairUser(pi) { return pi >= 0 ? str(S.H.pairs[pi][0]) : ''; }
function pairInternal(pi) { return pi >= 0 ? str(S.H.pairs[pi][1]) : ''; }
function nodeName(n) {
  var nm = str(S.H.nodes.name[n]);
  if (nm) return nm;
  var t = nodeType(n);
  return pairUser(S.H.nodes.pair[n]) || (t === T_GEOMETRY ? 'Geometry' : 'Unnamed');
}

/* ------------------------------------------------------------------ open */
var HANDLERS = {};
HANDLERS.open = async function (m) {
  gen++;
  S = null;
  var src = m.url ? await NWD.urlSource(m.url) : NWD.blobSource(m.file);
  progress('Reading file directory', 0);
  var f = await NWD.openFile(src);
  var st = { f: f, name: m.url ? src.name : m.file.name, size: src.size, chunkCache: new Map(), meshCache: new Map(), meshBytes: 0, recTris: new Map(),
    budget: m.budget || 3000000, cacheLimit: m.cacheLimit || 400 * 1048576, cells: [], built: new Map() };

  progress('Reading geometry index', 0.05);
  st.G = await NWD.openGeometry(f);
  if (!st.G) throw new Error('This file has no geometry section.');

  progress('Reading objects', 0.1);
  var fbuf = await NWD.readSection(f, f.section('LcOpNwdFragments'), function (x) { progress('Reading objects', 0.1 + 0.15 * x); });
  st.F = NWD.parseFragments(fbuf); fbuf = null;

  progress('Reading model tree', 0.3);
  var hbuf = await NWD.readSection(f, f.section('LcOpNwdLogicalHierarchy'), function (x) { progress('Reading model tree', 0.3 + 0.25 * x); });
  progress('Building model tree', 0.55);
  st.H = NWD.parseHierarchy(hbuf); hbuf = null;
  S = st;

  progress('Indexing objects', 0.75);
  buildFragmentBounds();
  buildCells();
  buildPathIndex();

  var views = [], viewTree = null;
  try {
    var sv = f.section('LcOpSavedViewsElement');
    if (sv) {
      var vb = await NWD.readSection(f, sv);
      try { viewTree = NWD.parseViewTree(vb); } catch (e2) { viewTree = null; }
      if (!viewTree) views = filterViews(NWD.parseSavedViews(vb));
    }
  } catch (err) { views = []; }

  // default materials: per fragment colour (rgb + alpha), from fragment appearance or tree material
  var colors = fragmentColors();
  progress('Ready', 1);
  var o = S.origin;
  return {
    name: st.name, size: st.size, fragments: S.F.count, records: S.G.nRec, nodes: S.H.nodes.count,
    origin: [o[0], o[1], o[2]], bbox: Array.from(S.bbox),
    views: viewTree ? relViews(viewTree, o) : relViews(views, o),
    hidden: hiddenFragments(),
    colors: colors, __transfer: [colors.buffer]
  };
};

function relViews(list, o) {
  return list.map(function (v) {
    if (v.folder) return { name: v.name, folder: true, children: relViews(v.children, o) };
    var r = { name: v.name, pos: [v.pos[0] - o[0], v.pos[1] - o[1], v.pos[2] - o[2]], quat: v.quat, focal: v.focal || 0, fov: v.fov || 0, ortho: !!v.ortho, orthoHeight: v.orthoHeight || 0 };
    if (v.section) r.section = { enabled: v.section.enabled, planes: v.section.planes.map(function (pl) { return { p: [pl.p[0] - o[0], pl.p[1] - o[1], pl.p[2] - o[2]], n: pl.n }; }) };
    return r;
  });
}
var AVATAR = /^(construction_worker|dummy|hardhat|human|office_(fe)?male(_hardhat)?|high_visibility|protective_clothing)\b/i;
function filterViews(v) {
  var out = [], seen = new Set();
  for (var i = 0; i < v.length; i++) {
    if (AVATAR.test(v[i].name)) continue;
    var key = v[i].name + '|' + v[i].pos.join(',');
    if (seen.has(key)) continue; seen.add(key); out.push(v[i]);
  }
  return out;
}

/* ------------------------------------------------------------------ fragment bounds (world, relative to origin) */
function quatMat(x, y, z, w) {
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}
function fragXform(i) {
  var F = S.F, xi = F.xf[i];
  if (xi < 0) return { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], s: 1, t: [0, 0, 0] };
  var q = F.xfQ, k = xi * 4;
  return { m: quatMat(q[k], q[k + 1], q[k + 2], q[k + 3]), s: F.xfS[xi], t: [F.xfT[xi * 3], F.xfT[xi * 3 + 1], F.xfT[xi * 3 + 2]] };
}
function buildFragmentBounds() {
  var F = S.F, n = F.count;
  var wb = new Float64Array(n * 6), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < n; i++) {
    var g = F.gbox[i], X = fragXform(i), m = X.m, s = X.s, t = X.t;
    if (g < 0) { for (var a = 0; a < 3; a++) { wb[i * 6 + a] = t[a]; wb[i * 6 + 3 + a] = t[a]; } continue; }
    var B = F.boxes, b0 = g * 6;
    var cx = (B[b0] + B[b0 + 3]) / 2 * s, cy = (B[b0 + 1] + B[b0 + 4]) / 2 * s, cz = (B[b0 + 2] + B[b0 + 5]) / 2 * s;
    var ex = (B[b0 + 3] - B[b0]) / 2 * s, ey = (B[b0 + 4] - B[b0 + 1]) / 2 * s, ez = (B[b0 + 5] - B[b0 + 2]) / 2 * s;
    for (a = 0; a < 3; a++) {
      var c = m[a * 3] * cx + m[a * 3 + 1] * cy + m[a * 3 + 2] * cz + t[a];
      var e = Math.abs(m[a * 3]) * ex + Math.abs(m[a * 3 + 1]) * ey + Math.abs(m[a * 3 + 2]) * ez;
      wb[i * 6 + a] = c - e; wb[i * 6 + 3 + a] = c + e;
      if (c - e < lo[a]) lo[a] = c - e; if (c + e > hi[a]) hi[a] = c + e;
    }
  }
  // robust model extents: ignore far-away outliers (e.g. survey points at 0,0,0) using percentiles of centers
  var cen = [[], [], []];
  for (i = 0; i < n; i += Math.max(1, (n / 20000) | 0)) for (a = 0; a < 3; a++) cen[a].push((wb[i * 6 + a] + wb[i * 6 + 3 + a]) / 2);
  var origin = [0, 0, 0];
  for (a = 0; a < 3; a++) { cen[a].sort(function (x, y) { return x - y; }); origin[a] = cen[a].length ? cen[a][cen[a].length >> 1] : 0; }
  S.origin = origin;
  var box = new Float32Array(n * 6), ctr = new Float32Array(n * 3), rad = new Float32Array(n);
  var bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (i = 0; i < n; i++) {
    for (a = 0; a < 3; a++) {
      var l = wb[i * 6 + a] - origin[a], h = wb[i * 6 + 3 + a] - origin[a];
      box[i * 6 + a] = l; box[i * 6 + 3 + a] = h; ctr[i * 3 + a] = (l + h) / 2;
    }
    var dx = box[i * 6 + 3] - box[i * 6], dy = box[i * 6 + 4] - box[i * 6 + 1], dz = box[i * 6 + 5] - box[i * 6 + 2];
    rad[i] = Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
  }
  // overall bbox from 0.5%..99.5% of centers so a few stray objects don't make "zoom all" useless
  var q = [[], [], []];
  for (i = 0; i < n; i += Math.max(1, (n / 50000) | 0)) for (a = 0; a < 3; a++) q[a].push(ctr[i * 3 + a]);
  for (a = 0; a < 3; a++) {
    q[a].sort(function (x, y) { return x - y; });
    var L = q[a].length, p0 = q[a][Math.floor(L * 0.005)], p1 = q[a][Math.min(L - 1, Math.floor(L * 0.995))];
    bb[a] = p0; bb[a + 3] = p1;
  }
  for (i = 0; i < n; i++) {   // grow to fully include objects whose centers are inside the robust box
    var inside = true; for (a = 0; a < 3; a++) if (ctr[i * 3 + a] < bb[a] || ctr[i * 3 + a] > bb[a + 3]) inside = false;
    if (inside && rad[i] < 5000) for (a = 0; a < 3; a++) { if (box[i * 6 + a] < bb[a]) bb[a] = box[i * 6 + a]; if (box[i * 6 + 3 + a] > bb[a + 3]) bb[a + 3] = box[i * 6 + 3 + a]; }
  }
  S.box = box; S.ctr = ctr; S.rad = rad; S.bbox = bb;
}

/* ------------------------------------------------------------------ spatial cells (k-d split on centers) */
var CELL_MAX = 2500;
function buildCells() {
  var n = S.F.count, ids = new Int32Array(n);
  for (var i = 0; i < n; i++) ids[i] = i;
  var cells = [], ctr = S.ctr, box = S.box;
  function split(lo, hi, depth) {
    if (hi - lo <= CELL_MAX || depth > 24) {
      var c = { id: cells.length, frags: ids.slice(lo, hi), box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] };
      for (var k = lo; k < hi; k++) { var f = ids[k]; for (var a = 0; a < 3; a++) { if (box[f * 6 + a] < c.box[a]) c.box[a] = box[f * 6 + a]; if (box[f * 6 + 3 + a] > c.box[a + 3]) c.box[a + 3] = box[f * 6 + 3 + a]; } }
      cells.push(c); return;
    }
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (k = lo; k < hi; k++) for (a = 0; a < 3; a++) { var v = ctr[ids[k] * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
    var ax = 0; for (a = 1; a < 3; a++) if (mx[a] - mn[a] > mx[ax] - mn[ax]) ax = a;
    var sub = Array.from(ids.subarray(lo, hi)).sort(function (p, q) { return ctr[p * 3 + ax] - ctr[q * 3 + ax]; });
    ids.set(sub, lo);
    var mid = (lo + hi) >> 1;
    split(lo, mid, depth + 1); split(mid, hi, depth + 1);
  }
  split(0, n, 0);
  S.cells = cells;
  S.fragCell = new Int32Array(n);
  for (i = 0; i < cells.length; i++) { var fr = cells[i].frags; for (var j = 0; j < fr.length; j++) S.fragCell[fr[j]] = i; }
}

/* ------------------------------------------------------------------ path -> fragments index */
function buildPathIndex() {
  var n = S.F.count, node = S.F.node, order = new Int32Array(n);
  for (var i = 0; i < n; i++) order[i] = i;
  order.sort(function (a, b) { return node[a] - node[b]; });
  var keys = new Int32Array(n); for (i = 0; i < n; i++) keys[i] = node[order[i]];
  S.fragOrder = order; S.fragKeys = keys;
}
function lowerBound(arr, v) { var lo = 0, hi = arr.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; } return lo; }
function fragsOfPath(p) {
  var W = S.H.walk, a = lowerBound(S.fragKeys, p), b = lowerBound(S.fragKeys, W.end[p]);
  return S.fragOrder.slice(a, b);
}
function hiddenFragments() {
  // nodes flagged hidden in the file (bit 0x1000000)
  var N = S.H.nodes, W = S.H.walk, out = [];
  for (var p = 0; p < W.count; p++) {
    if (N.flags[W.node[p]] & 0x1000000) { var fr = fragsOfPath(p); for (var k = 0; k < fr.length; k++) out.push(fr[k]); p = W.end[p] - 1; }
  }
  return out;
}

/* ------------------------------------------------------------------ colours */
function fragmentColors() {
  var F = S.F, n = F.count, out = new Uint8Array(n * 4), H = S.H;
  // fragment appearance material (what Navisworks draws), else the tree material on the geometry node
  var treeMat = new Int32Array(H.nodes.count).fill(-1);
  for (var nd = 0; nd < H.nodes.count; nd++) {
    var s = H.nodes.attrStart[nd], c = H.nodes.attrCount[nd];
    for (var k = 0; k < c; k++) { var a = H.attrList[s + k]; if ((a & 15) === H.K.MAT) { treeMat[nd] = a >> 4; break; } }
  }
  for (var i = 0; i < n; i++) {
    var r = 0.72, g = 0.72, b = 0.72, t = 0;
    var tm = treeMat[H.walk.node[F.node[i]]];
    if (F.mat[i] >= 0) { var C = F.materials[F.mat[i]]; r = C[3]; g = C[4]; b = C[5]; t = C[13]; }
    else if (tm >= 0) { var M = H.materials[tm].c; r = M[3]; g = M[4]; b = M[5]; t = M[13]; }
    out[i * 4] = Math.round(Math.min(1, Math.max(0, r)) * 255); out[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
    out[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255); out[i * 4 + 3] = Math.round((1 - Math.min(0.95, Math.max(0, t))) * 255);
  }
  S.colors = out.slice();
  return out;
}

/* ------------------------------------------------------------------ view-dependent loading */
var pendingView = null, running = false;
HANDLERS.view = function (m) {
  if (!S) return;
  pendingView = m; gen++;
  if (!running) runLoader();
};
HANDLERS.settings = function (m) {
  if (!S) return;
  if (m.budget) S.budget = m.budget;
  if (m.cacheLimit) S.cacheLimit = m.cacheLimit;
};

function frustumPlanes(vp) {
  // vp: column-major 4x4 view-projection matrix (three.js elements)
  var p = [], e = vp;
  function plane(a, b, c, d) { var l = Math.sqrt(a * a + b * b + c * c); p.push([a / l, b / l, c / l, d / l]); }
  plane(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
  plane(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]);
  plane(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]);
  plane(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
  plane(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);
  return p;
}
function boxVisible(planes, b) {
  for (var i = 0; i < planes.length; i++) {
    var P = planes[i];
    var x = P[0] > 0 ? b[3] : b[0], y = P[1] > 0 ? b[4] : b[1], z = P[2] > 0 ? b[5] : b[2];
    if (P[0] * x + P[1] * y + P[2] * z + P[3] < 0) return false;
  }
  return true;
}
function estTris(rec) {
  var t = S.recTris.get(rec);
  return t !== undefined ? t : Math.max(1, S.G.recSize[rec] / 16);
}

// Decide which fragments to show: in view, big enough on screen, best first, within the triangle budget.
function chooseFragments(v) {
  var planes = frustumPlanes(v.vp), cam = v.cam, k = v.projScale, minPx = v.minPx || 1.5;
  var cand = [], score = [], ctr = S.ctr, rad = S.rad, geom = S.F.geom, box = S.box, clip = v.clip || [];
  for (var c = 0; c < S.cells.length; c++) {
    var cell = S.cells[c];
    if (!boxVisible(planes, cell.box)) continue;
    var fr = cell.frags;
    for (var j = 0; j < fr.length; j++) {
      var f = fr[j]; if (geom[f] < 0) continue;
      var dx = ctr[f * 3] - cam[0], dy = ctr[f * 3 + 1] - cam[1], dz = ctr[f * 3 + 2] - cam[2];
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz) - rad[f];
      var px = rad[f] * k / Math.max(d, 0.1);
      if (px < minPx) continue;
      // sphere-vs-frustum
      var vis = true;
      for (var pi = 0; pi < 5; pi++) { var P = planes[pi]; if (P[0] * ctr[f * 3] + P[1] * ctr[f * 3 + 1] + P[2] * ctr[f * 3 + 2] + P[3] < -rad[f]) { vis = false; break; } }
      if (!vis) continue;
      // section planes: keep fragments whose box reaches the kept side (n.p + c >= 0) of every plane
      for (var ci = 0; ci < clip.length && vis; ci++) { var C = clip[ci];
        var bx = C[0] > 0 ? box[f * 6 + 3] : box[f * 6], by = C[1] > 0 ? box[f * 6 + 4] : box[f * 6 + 1], bz = C[2] > 0 ? box[f * 6 + 5] : box[f * 6 + 2];
        if (C[0] * bx + C[1] * by + C[2] * bz + C[3] < 0) vis = false; }
      if (!vis) continue;
      cand.push(f); score.push(px);
    }
  }
  var order = new Int32Array(cand.length); for (var i = 0; i < order.length; i++) order[i] = i;
  order.sort(function (a, b) { return score[b] - score[a]; });
  var chosen = [], tris = 0, budget = S.budget;
  for (i = 0; i < order.length; i++) {
    var fi = cand[order[i]], t = estTris(geom[fi]);
    if (tris + t > budget && chosen.length > 0) continue;
    chosen.push(fi); tris += t;
    if (tris > budget) break;
  }
  return { chosen: chosen, score: score, cand: cand, order: order };
}

async function runLoader() {
  running = true;
  try {
    while (pendingView) {
      var v = pendingView, myGen = gen; pendingView = null;
      var pick = chooseFragments(v);
      // group by cell
      var byCell = new Map();
      for (var i = 0; i < pick.chosen.length; i++) {
        var f = pick.chosen[i], c = S.fragCell[f], arr = byCell.get(c);
        if (!arr) { arr = []; byCell.set(c, arr); }
        arr.push(f);
      }
      // cells to (re)build, most important first (order of first appearance in chosen list)
      var queue = [];
      byCell.forEach(function (frs, c) {
        frs.sort(function (a, b) { return a - b; });
        var built = S.built.get(c);
        if (!built || needsRebuild(built.frags, frs)) queue.push({ c: c, frs: frs, rank: queue.length });
      });
      // order: cells whose top fragment is earliest in priority
      var rankOf = new Map(); for (i = 0; i < pick.chosen.length; i++) { var cc = S.fragCell[pick.chosen[i]]; if (!rankOf.has(cc)) rankOf.set(cc, i); }
      queue.sort(function (a, b) { return rankOf.get(a.c) - rankOf.get(b.c); });
      // drop built cells that are not wanted any more if we are above budget
      trimBuilt(byCell);
      post('loading', { pending: queue.length });
      for (var q = 0; q < queue.length; q++) {
        if (gen !== myGen && pendingView) break;     // camera moved: re-plan
        await buildCell(queue[q].c, queue[q].frs);
        post('loading', { pending: queue.length - q - 1 });
      }
      if (!pendingView) post('loading', { pending: 0, done: true });
    }
  } catch (err) {
    post('error', { message: String(err && err.stack || err) });
  } finally { running = false; }
}
function needsRebuild(have, want) {
  // rebuild when something wanted is missing, or when much more is drawn than wanted
  var i = 0, j = 0, missing = 0, extra = 0;
  while (i < have.length || j < want.length) {
    if (j >= want.length || (i < have.length && have[i] < want[j])) { extra++; i++; }
    else if (i >= have.length || want[j] < have[i]) { missing++; j++; }
    else { i++; j++; }
  }
  return missing > 0 || extra > Math.max(64, want.length);
}
function trimBuilt(wanted) {
  var total = 0; S.built.forEach(function (b) { total += b.tris; });
  if (total <= S.budget * 1.4) return;
  var drop = [];
  S.built.forEach(function (b, c) { if (!wanted.has(c)) drop.push(c); });
  for (var i = 0; i < drop.length && total > S.budget * 1.1; i++) {
    total -= S.built.get(drop[i]).tris; S.built.delete(drop[i]); post('drop', { cell: drop[i] });
  }
}

/* ------------------------------------------------------------------ geometry cache + cell meshes */
function cacheMesh(rec, mesh) {
  var bytes = mesh.pos.byteLength + mesh.index.byteLength + (mesh.nrm ? mesh.nrm.byteLength : 0) + 64;
  mesh.bytes = bytes; S.meshCache.set(rec, mesh); S.meshBytes += bytes;
  if (S.meshBytes > S.cacheLimit) {
    var it = S.meshCache.keys();
    while (S.meshBytes > S.cacheLimit * 0.8) { var k = it.next(); if (k.done) break; var old = S.meshCache.get(k.value); S.meshBytes -= old.bytes; S.meshCache.delete(k.value); }
  }
  if (S.chunkCache.size > 600) { var ci = S.chunkCache.keys(); while (S.chunkCache.size > 400) S.chunkCache.delete(ci.next().value); }
}
async function ensureMeshes(recs) {
  var need = [];
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i]; if (r < 0) continue;
    var m = S.meshCache.get(r);
    if (m) { S.meshCache.delete(r); S.meshCache.set(r, m); } else need.push(r);  // LRU touch
  }
  if (!need.length) return;
  need = Array.from(new Set(need));
  var raw = await NWD.fetchRecords(S.f, S.G, need, S.chunkCache);
  raw.forEach(function (b, r) {
    var mesh;
    try {
      var rec = NWD.parseRecord(b);
      if (rec.kind === 94) { mesh = NWD.meshTriangles(rec); mesh.kind = 94; }
      else if (rec.kind === 95) { mesh = NWD.lineSegments(rec); mesh.kind = 95; mesh.tris = mesh.index.length / 6; }
      else mesh = { kind: rec.kind, pos: new Float32Array(0), index: new Uint32Array(0), tris: 0 };
    } catch (err) { mesh = { kind: -1, pos: new Float32Array(0), index: new Uint32Array(0), tris: 0, err: String(err.message) }; }
    S.recTris.set(r, mesh.tris || 0);
    cacheMesh(r, mesh);
  });
}

async function buildCell(c, frs) {
  var geom = S.F.geom;
  var recs = []; for (var i = 0; i < frs.length; i++) recs.push(geom[frs[i]]);
  await ensureMeshes(recs);
  var o = S.origin;
  // count
  var nv = [0, 0, 0], ni = [0, 0, 0];      // 0 opaque, 1 transparent, 2 lines
  var list = [];
  for (i = 0; i < frs.length; i++) {
    var f = frs[i], mesh = S.meshCache.get(geom[f]); if (!mesh || !mesh.pos.length) continue;
    var bucket = mesh.kind === 95 ? 2 : (S.colors[f * 4 + 3] < 250 ? 1 : 0);
    nv[bucket] += mesh.pos.length / 3; ni[bucket] += mesh.index.length; list.push([f, mesh, bucket]);
  }
  var out = [], transfer = [];
  for (var b = 0; b < 3; b++) {
    if (!ni[b]) { out.push(null); continue; }
    var P = new Float32Array(nv[b] * 3), N = b < 2 ? new Int8Array(nv[b] * 4) : null, C = new Uint8Array(nv[b] * 4), ID = new Float32Array(nv[b]), I = new Uint32Array(ni[b]);
    out.push({ pos: P, nrm: N, col: C, fid: ID, index: I, v: 0, i: 0 });
    transfer.push(P.buffer, C.buffer, ID.buffer, I.buffer); if (N) transfer.push(N.buffer);
  }
  var tris = 0;
  for (i = 0; i < list.length; i++) {
    f = list[i][0]; mesh = list[i][1]; var B = out[list[i][2]];
    var X = fragXform(f), m = X.m, s = X.s, tx = X.t[0] - o[0], ty = X.t[1] - o[1], tz = X.t[2] - o[2];
    var base = B.v, vp = mesh.pos, vn = mesh.nrm, cnt = vp.length / 3;
    var cr = S.colors[f * 4], cg = S.colors[f * 4 + 1], cb = S.colors[f * 4 + 2], ca = S.colors[f * 4 + 3];
    for (var k = 0; k < cnt; k++) {
      var x = vp[k * 3] * s, y = vp[k * 3 + 1] * s, z = vp[k * 3 + 2] * s, d = (base + k) * 3;
      B.pos[d] = m[0] * x + m[1] * y + m[2] * z + tx;
      B.pos[d + 1] = m[3] * x + m[4] * y + m[5] * z + ty;
      B.pos[d + 2] = m[6] * x + m[7] * y + m[8] * z + tz;
      if (B.nrm && vn) {
        var nx = vn[k * 3], ny = vn[k * 3 + 1], nz = vn[k * 3 + 2], e = (base + k) * 4;
        B.nrm[e] = m[0] * nx + m[1] * ny + m[2] * nz; B.nrm[e + 1] = m[3] * nx + m[4] * ny + m[5] * nz; B.nrm[e + 2] = m[6] * nx + m[7] * ny + m[8] * nz;
      }
      var q = (base + k) * 4; B.col[q] = cr; B.col[q + 1] = cg; B.col[q + 2] = cb; B.col[q + 3] = ca;
      B.fid[base + k] = f;
    }
    var idx = mesh.index, ii = B.i;
    for (k = 0; k < idx.length; k++) B.index[ii + k] = idx[k] + base;
    B.i += idx.length; B.v += cnt;
    tris += mesh.tris || 0;
  }
  S.built.set(c, { frags: frs, tris: tris });
  post('cell', { cell: c, tris: tris, opaque: strip(out[0]), transparent: strip(out[1]), lines: strip(out[2]) }, transfer);
}
function strip(B) { return B ? { pos: B.pos, nrm: B.nrm, col: B.col, fid: B.fid, index: B.index } : null; }

/* ------------------------------------------------------------------ queries from the UI */
HANDLERS.select = function (m) {
  // fragment -> path at the requested selection resolution, plus the ancestor chain for the tree
  var f = m.fid, W = S.H.walk, leaf = S.F.node[f];
  var chain = []; for (var p = leaf; p >= 0; p = W.parent[p]) chain.unshift(p);
  var res = m.resolution || 'first', pick = leaf;
  if (res === 'first' || res === 'last') {
    var objs = chain.filter(function (q) { var t = nodeType(W.node[q]); return t === T_COMPOSITE || t === T_INSTANCE || t === T_GEOMETRY; });
    if (objs.length) pick = res === 'first' ? objs[0] : (objs.length > 1 ? objs[objs.length - 2] : objs[0]);
  } else if (res === 'layer') { for (var i = 0; i < chain.length; i++) if (nodeType(W.node[chain[i]]) === T_LAYER) { pick = chain[i]; break; } }
  else if (res === 'file') { for (i = 0; i < chain.length; i++) if (nodeType(W.node[chain[i]]) === T_FILE) { pick = chain[i]; break; } }
  return { path: pick, chain: chain };
};
HANDLERS.frags = function (m) {
  var paths = m.paths, parts = [], total = 0;
  for (var i = 0; i < paths.length; i++) { var fr = fragsOfPath(paths[i]); parts.push(fr); total += fr.length; }
  var out = new Int32Array(total), o = 0; for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
  return { frags: out, __transfer: [out.buffer] };
};
HANDLERS.bbox = function (m) {
  var fr = m.frags || (m.paths ? HANDLERS.frags(m).frags : []), b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (var i = 0; i < fr.length; i++) { var f = fr[i]; for (var a = 0; a < 3; a++) { if (S.box[f * 6 + a] < b[a]) b[a] = S.box[f * 6 + a]; if (S.box[f * 6 + 3 + a] > b[a + 3]) b[a + 3] = S.box[f * 6 + 3 + a]; } }
  return b[0] === Infinity ? null : b;
};
function nodeInfo(p) {
  var n = S.H.walk.node[p], t = nodeType(n), W = S.H.walk;
  return { path: p, name: nodeName(n), type: t, kids: W.end[p] - p > 1, hidden: !!(S.H.nodes.flags[n] & 0x1000000) };
}
HANDLERS.children = function (m) {
  var W = S.H.walk, p = m.path === undefined ? 0 : m.path, out = [];
  for (var c = p + 1; c < W.end[p]; c = W.end[c]) out.push(nodeInfo(c));
  // single-file models: skip a lone root level
  return { path: p, items: out };
};
HANDLERS.chainInfo = function (m) { return m.chain.map(nodeInfo); };

// Properties panel: Item tab + every property category attached to the node (Navisworks-style tabs)
HANDLERS.props = function (m) {
  var p = m.path, H = S.H, n = H.walk.node[p], N = H.nodes, tabs = [];
  var item = [['Name', nodeName(n)], ['Type', pairUser(N.pair[n]) || typeName(nodeType(n))], ['Internal Type', pairInternal(N.pair[n])],
    ['Hidden', N.flags[n] & 0x1000000 ? 'Yes' : 'No']];
  // source file = nearest file ancestor
  for (var q = p; q >= 0; q = H.walk.parent[q]) if (nodeType(H.walk.node[q]) === T_FILE) { item.push(['Source File', nodeName(H.walk.node[q])]); break; }
  var fr = fragsOfPath(p); if (fr.length) item.push(['Geometry Pieces', String(fr.length)]);
  tabs.push({ name: 'Item', rows: item });
  // collect attributes along this node and (for geometry) its parent object, like Navisworks shows them on the item
  var seen = new Set();
  function addAttrs(node) {
    var s = N.attrStart[node], c = N.attrCount[node];
    for (var k = 0; k < c; k++) {
      var a = H.attrList[s + k], kind = a & 15, idx = a >> 4, key = a;
      if (seen.has(key)) continue; seen.add(key);
      if (kind === H.K.PROPS) {
        var P = H.props[idx], rows = [];
        for (var j = 0; j < P.items.length; j++) { var it = P.items[j]; rows.push([pairUser(it[0]) || '(property)', fmtValue(it[1], it[2])]); }
        tabs.push({ name: P.name || pairUser(P.cat) || 'Properties', rows: rows });
      } else if (kind === H.K.MAT) {
        var M = H.materials[idx], c3 = M.c;
        tabs.push({ name: 'Material', rows: [['Name', M.name || ''], ['Diffuse', rgb(c3[3], c3[4], c3[5])], ['Ambient', rgb(c3[0], c3[1], c3[2])], ['Transparency', Math.round(c3[13] * 100) + '%'], ['Shininess', (c3[12] * 100).toFixed(0) + '%']] });
      } else if (kind === H.K.LINK) {
        var L = H.links[idx]; tabs.push({ name: 'Hyperlinks', rows: L.items.map(function (x) { return [x[0] || 'Link', { url: x[1] }]; }) });
      } else if (kind === H.K.XF) {
        var X = H.xfs[idx];
        var rowsX = []; if (X.t) rowsX.push(['Translation', X.t.map(fmtLen).join(', ')]);
        if (X.q) rowsX.push(['Rotation', quatText(X.q)]);
        if (X.m) rowsX.push(['Matrix', X.m.slice(0, 9).map(function (v) { return v.toFixed(3); }).join(' ')], ['Translation', X.m.slice(9).map(fmtLen).join(', ')]);
        tabs.push({ name: 'Transform', rows: rowsX });
      }
    }
  }
  addAttrs(n);
  if (nodeType(n) === T_GEOMETRY && H.walk.parent[p] >= 0) addAttrs(H.walk.node[H.walk.parent[p]]);
  return { title: nodeName(n), type: nodeType(n), tabs: tabs };
};
function typeName(t) { return ['Root', 'File', 'Layer', 'Group', 'Instance', 'Composite Object', 'Geometry'][t] || 'Item'; }
function rgb(r, g, b) { return { color: [r, g, b], text: Math.round(r * 255) + ', ' + Math.round(g * 255) + ', ' + Math.round(b * 255) }; }
function quatText(q) {
  var w = Math.max(-1, Math.min(1, q[3])), ang = 2 * Math.acos(w) * 180 / Math.PI, s = Math.sqrt(1 - w * w) || 1;
  return ang.toFixed(2) + '° about (' + (q[0] / s).toFixed(3) + ', ' + (q[1] / s).toFixed(3) + ', ' + (q[2] / s).toFixed(3) + ')';
}
function fmtLen(ft) {
  if (typeof ft !== 'number' || !isFinite(ft)) return String(ft);
  var neg = ft < 0; ft = Math.abs(ft);
  var totalIn = Math.round(ft * 12 * 16) / 16, f = Math.floor(totalIn / 12), inch = totalIn - f * 12;
  var whole = Math.floor(inch), frac = Math.round((inch - whole) * 16), fr = '';
  if (frac) { var d = 16; while (frac % 2 === 0) { frac /= 2; d /= 2; } fr = ' ' + frac + '/' + d; }
  return (neg ? '-' : '') + f + "'-" + whole + fr + '"';
}
function fmtValue(type, v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
  if (typeof v === 'string') return v;
  if (v.len !== undefined) return fmtLen(v.len);
  if (v.ang !== undefined) return (v.ang * 180 / Math.PI).toFixed(2) + '°';
  if (v.area !== undefined) return v.area.toFixed(2) + ' ft²';
  if (v.vol !== undefined) return v.vol.toFixed(2) + ' ft³';
  if (v.pair !== undefined) return pairUser(v.pair);
  return String(v);
}

// Find items by name (and type) — returns first matches in tree order
HANDLERS.find = function (m) {
  var q = String(m.text || '').toLowerCase().trim(); if (!q) return [];
  var H = S.H, W = H.walk, N = H.nodes, max = m.max || 300, out = [];
  var hit = new Uint8Array(H.nodes.count);
  for (var n = 0; n < N.count; n++) {
    var nm = str(N.name[n]).toLowerCase(), ty = pairUser(N.pair[n]).toLowerCase();
    if (nm.indexOf(q) >= 0 || ty.indexOf(q) >= 0) hit[n] = 1;
  }
  for (var p = 0; p < W.count && out.length < max; p++) {
    if (hit[W.node[p]]) {
      var t = nodeType(W.node[p]); if (t === T_ROOT) continue;
      var info = nodeInfo(p), trail = [];
      for (var q = W.parent[p]; q > 0; q = W.parent[q]) { var tq = nodeType(W.node[q]); if (tq === T_FILE || tq === T_LAYER) trail.unshift(nodeName(W.node[q])); }
      info.where = trail.join(' › '); out.push(info); p = W.end[p] - 1;
    }
  }
  return out;
};

// Precise surface point along a ray for a fragment (used by measure/zoom when depth readback is unavailable)
HANDLERS.raycast = async function (m) {
  var f = m.fid, r = S.F.geom[f]; if (r < 0) return null;
  await ensureMeshes([r]);
  var mesh = S.meshCache.get(r); if (!mesh || mesh.kind !== 94) return null;
  var X = fragXform(f), mm = X.m, s = X.s, o = S.origin, t = [X.t[0] - o[0], X.t[1] - o[1], X.t[2] - o[2]];
  var O = m.origin, D = m.dir, best = Infinity, vp = mesh.pos, I = mesh.index;
  function w(k, out) { var x = vp[k * 3] * s, y = vp[k * 3 + 1] * s, z = vp[k * 3 + 2] * s; out[0] = mm[0] * x + mm[1] * y + mm[2] * z + t[0]; out[1] = mm[3] * x + mm[4] * y + mm[5] * z + t[1]; out[2] = mm[6] * x + mm[7] * y + mm[8] * z + t[2]; }
  var A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
  for (var i = 0; i < I.length; i += 3) {
    w(I[i], A); w(I[i + 1], B); w(I[i + 2], C);
    var e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    var pv = [D[1] * e2[2] - D[2] * e2[1], D[2] * e2[0] - D[0] * e2[2], D[0] * e2[1] - D[1] * e2[0]];
    var det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2]; if (Math.abs(det) < 1e-12) continue;
    var inv = 1 / det, tv = [O[0] - A[0], O[1] - A[1], O[2] - A[2]];
    var u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * inv; if (u < 0 || u > 1) continue;
    var qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
    var vv = (D[0] * qv[0] + D[1] * qv[1] + D[2] * qv[2]) * inv; if (vv < 0 || u + vv > 1) continue;
    var tt = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv; if (tt > 0 && tt < best) best = tt;
  }
  return best === Infinity ? null : [O[0] + D[0] * best, O[1] + D[1] * best, O[2] + D[2] * best];
};

HANDLERS.stats = function () {
  if (!S) return null;
  var t = 0; S.built.forEach(function (b) { t += b.tris; });
  return { cells: S.cells.length, built: S.built.size, tris: t, cacheMB: Math.round(S.meshBytes / 1048576), records: S.meshCache.size };
};
