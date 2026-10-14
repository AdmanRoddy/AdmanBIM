import * as THREE from 'three';

/* =================================================================== helpers */
const $ = id => document.getElementById(id);
const isTouch = matchMedia('(pointer: coarse)').matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem('amv.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('amv.' + k, JSON.stringify(v)); } catch (e) {} }
};
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), ms); }
function fmtLen(ft) {
  if (!isFinite(ft)) return '';
  const neg = ft < 0; ft = Math.abs(ft);
  const totalIn = Math.round(ft * 12 * 16) / 16; let f = Math.floor(totalIn / 12), inch = totalIn - f * 12;
  let whole = Math.floor(inch), frac = Math.round((inch - whole) * 16), fr = '';
  if (frac === 16) { whole++; frac = 0; } if (whole === 12) { f++; whole = 0; }
  if (frac) { let d = 16; while (frac % 2 === 0) { frac /= 2; d /= 2; } fr = ' ' + frac + '/' + d; }
  return (neg ? '-' : '') + f + "' " + whole + fr + '"';
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* =================================================================== worker */
const worker = new Worker(URL.createObjectURL(new Blob([$('worker-src').textContent], { type: 'text/javascript' })));
let rid = 0; const pending = new Map();
function call(type, data = {}, transfer = []) {
  return new Promise((res, rej) => { const id = ++rid; pending.set(id, { res, rej }); worker.postMessage(Object.assign({}, data, { type, rid: id }), transfer); });
}
worker.onmessage = e => {
  const m = e.data;
  switch (m.type) {
    case 'reply': { const p = pending.get(m.rid); pending.delete(m.rid); if (!p) return; m.error ? p.rej(new Error(m.error)) : p.res(m.result); break; }
    case 'progress': $('loadStage').textContent = m.stage; $('loadBar').style.width = Math.round(m.frac * 100) + '%'; break;
    case 'cell': addCell(m); break;
    case 'drop': dropCell(m.cell); break;
    case 'loading': loadingCells = m.pending; updateStatus(); if (m.limited !== undefined) detailLimited(m.limited); $('busy').classList.toggle('hidden', !m.pending); break;
    case 'propsReady': if (propPath !== null) showProps(propPath); break;
    case 'error': console.error(m.message); toast('Problem: ' + String(m.message).split('\n')[0], 5000); break;
  }
};

/* =================================================================== renderer */
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.localClippingEnabled = false;
renderer.clippingPlanes = [];
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e5);
camera.up.set(0, 0, 1);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.1));
const head = new THREE.DirectionalLight(0xffffff, 1.6); head.position.set(0.3, 0.6, 1); camera.add(head); camera.add(head.target);
const model = new THREE.Group(); scene.add(model);
const overlay = new THREE.Group(); scene.add(overlay);

let needsRender = true;
function requestRender() { needsRender = true; }
function resize() {
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix();
  requestRender(); sendView();
}
new ResizeObserver(resize).observe(canvas);

function setBackground(kind) {
  const bg = { grad: 'linear-gradient(#3d5268,#9fb0c0)', dark: '#1b2633', light: '#d9e0e7', white: '#ffffff' }[kind] || 'linear-gradient(#3d5268,#9fb0c0)';
  $('stage').style.background = bg; renderer.setClearColor(0x000000, 0); requestRender();
}

/* --------------------------------------------------- per-fragment state texture (hidden / selected / colour override) */
const SW = 2048;
const U = { uState: { value: null }, uStateW: { value: SW }, uSelColor: { value: new THREE.Color(0x2f80ff) } };
let stateData = null, stateTex = null, fragCount = 0;
function initState(n) {
  fragCount = n; const h = Math.max(1, Math.ceil(n / SW));
  stateData = new Uint8Array(SW * h * 4);
  stateTex = new THREE.DataTexture(stateData, SW, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  stateTex.magFilter = stateTex.minFilter = THREE.NearestFilter; stateTex.needsUpdate = true;
  U.uState.value = stateTex;
}
function setFlag(frags, bit, on) { for (let i = 0; i < frags.length; i++) { const k = frags[i] * 4; stateData[k] = on ? stateData[k] | bit : stateData[k] & ~bit; } stateTex.needsUpdate = true; requestRender(); }
function clearFlag(bit) { for (let k = 0; k < stateData.length; k += 4) stateData[k] &= ~bit; stateTex.needsUpdate = true; requestRender(); }

const VERT_DECL = `
attribute float fid;
uniform highp sampler2D uState; uniform float uStateW;
varying float vFlags; varying vec3 vOv;`;
const VERT_STATE = `
{ ivec2 sc = ivec2(int(mod(fid, uStateW)), int(floor(fid / uStateW)));
  vec4 st = texelFetch(uState, sc, 0); vFlags = floor(st.r * 255.0 + 0.5); vOv = st.gba; }`;
const VERT_HIDE = `
if (mod(vFlags, 2.0) >= 1.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);`;
const FRAG_DECL = `
varying float vFlags; varying vec3 vOv; uniform vec3 uSelColor;`;
const FRAG_COLOR = `
if (mod(floor(vFlags / 4.0), 2.0) >= 1.0) diffuseColor.rgb = vOv;
if (mod(floor(vFlags / 2.0), 2.0) >= 1.0) diffuseColor.rgb = mix(diffuseColor.rgb, uSelColor, 0.7);`;
function patch(mat) {
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + VERT_STATE)
      .replace('#include <project_vertex>', '#include <project_vertex>' + VERT_HIDE);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + FRAG_DECL)
      .replace('#include <color_fragment>', '#include <color_fragment>' + FRAG_COLOR);
  };
  return mat;
}
const MAT = {
  opaque: patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })),
  transparent: patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, depthWrite: false })),
  lines: patch(new THREE.LineBasicMaterial({ vertexColors: true })),
};
const pickMat = new THREE.ShaderMaterial({
  uniforms: Object.assign({ uMode: { value: 0 }, uFar: { value: 1e5 } }, U), side: THREE.DoubleSide, clipping: true,
  vertexShader: `#include <common>
#include <clipping_planes_pars_vertex>
attribute float fid; uniform highp sampler2D uState; uniform float uStateW; varying float vId; varying float vHide; varying float vViewZ;
void main() {
  ivec2 sc = ivec2(int(mod(fid, uStateW)), int(floor(fid / uStateW)));
  vHide = mod(floor(texelFetch(uState, sc, 0).r * 255.0 + 0.5), 2.0); vId = fid;
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
  vViewZ = -mvPosition.z;
}`,
  fragmentShader: `#include <common>
#include <packing>
#include <clipping_planes_pars_fragment>
varying float vId; varying float vHide; varying float vViewZ; uniform int uMode; uniform float uFar;
void main() {
  #include <clipping_planes_fragment>
  if (vHide > 0.5) discard;
  if (uMode == 0) { float id = vId + 1.0; gl_FragColor = vec4(mod(id, 256.0) / 255.0, mod(floor(id / 256.0), 256.0) / 255.0, floor(id / 65536.0) / 255.0, 1.0); }
  else gl_FragColor = packDepthToRGBA(clamp(vViewZ / uFar, 0.0, 0.999999));
}` });

/* --------------------------------------------------- cells (merged meshes streamed from the worker) */
const cells = new Map();
let loadingCells = 0, shownTris = 0, showLines = store.get('lines', true), wire = false;
function geomFrom(b, lines) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b.pos, 3));
  if (b.nrm) g.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(b.nrm, 4), 3, 0, true));
  g.setAttribute('color', new THREE.BufferAttribute(b.col, 4, true));
  g.setAttribute('fid', new THREE.BufferAttribute(b.fid, 1));
  g.setIndex(new THREE.BufferAttribute(b.index, 1));
  g.computeBoundingSphere();
  return g;
}
function addCell(m) {
  dropCell(m.cell, true);
  const objs = [];
  if (m.opaque) objs.push(new THREE.Mesh(geomFrom(m.opaque), MAT.opaque));
  if (m.transparent) { const t = new THREE.Mesh(geomFrom(m.transparent), MAT.transparent); t.renderOrder = 2; objs.push(t); }
  if (m.lines) { const l = new THREE.LineSegments(geomFrom(m.lines, true), MAT.lines); l.visible = showLines; l.userData.lines = true; objs.push(l); }
  for (const o of objs) { o.matrixAutoUpdate = false; o.frustumCulled = true; model.add(o); }
  cells.set(m.cell, { objs, tris: m.tris });
  shownTris += m.tris; updateStatus(); requestRender();
}
function dropCell(c, silent) {
  const e = cells.get(c); if (!e) return;
  for (const o of e.objs) { model.remove(o); o.geometry.dispose(); }
  shownTris -= e.tris; cells.delete(c);
  if (!silent) { updateStatus(); requestRender(); }
}
function clearModel() { for (const c of Array.from(cells.keys())) dropCell(c, true); shownTris = 0; clearOverlay(); }

/* --------------------------------------------------- picking (GPU id + depth at one pixel) */
const pickRT = new THREE.WebGLRenderTarget(1, 1);
const pickBuf = new Uint8Array(4);
function pickAt(x, y) {
  // x, y in CSS pixels relative to canvas
  if (!cells.size) return null;
  const r = canvas.getBoundingClientRect(), dpr = renderer.getPixelRatio();
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr), px = Math.round(x * dpr), py = Math.round(y * dpr);
  camera.setViewOffset(W, H, px, py, 1, 1);
  const prevOverride = scene.overrideMaterial, prevBg = scene.background;
  scene.overrideMaterial = pickMat; overlay.visible = false;
  for (const e of cells.values()) for (const o of e.objs) if (o.userData.lines && !showLines) o.visible = false;
  renderer.setRenderTarget(pickRT);
  const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  pickMat.uniforms.uMode.value = 0; renderer.clear(); renderer.render(scene, camera);
  renderer.readRenderTargetPixels(pickRT, 0, 0, 1, 1, pickBuf);
  const id = pickBuf[0] + pickBuf[1] * 256 + pickBuf[2] * 65536 - 1;
  let point = null;
  if (id >= 0) {
    pickMat.uniforms.uMode.value = 1; pickMat.uniforms.uFar.value = camera.far; renderer.setClearColor(0xffffff, 1); renderer.clear(); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(pickRT, 0, 0, 1, 1, pickBuf);
    // unpackRGBAToDepth (three.js packing) -> linear view depth
    const viewZ = (255 / 256) * (pickBuf[0] / 255 / 16777216 + pickBuf[1] / 255 / 65536 + pickBuf[2] / 255 / 256 + pickBuf[3] / 255) * camera.far;
    camera.clearViewOffset();
    const ray = new THREE.Vector3(x / r.width * 2 - 1, -(y / r.height) * 2 + 1, 0.5).unproject(camera).sub(camera.position).normalize();
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    point = camera.position.clone().addScaledVector(ray, viewZ / Math.max(1e-6, ray.dot(fwd)));
  } else camera.clearViewOffset();
  renderer.setRenderTarget(null); renderer.setClearColor(cc, ca);
  scene.overrideMaterial = prevOverride; scene.background = prevBg; overlay.visible = true;
  requestRender();
  return id >= 0 ? { fid: id, point } : null;
}

/* =================================================================== model state */
let M = null;                 // opened model summary from worker
let selected = { paths: [], frags: new Int32Array(0) };
let hiddenFrags = new Set();
let resolution = store.get('res', 'first');

async function openFile(file) {
  if (!file) return;
  const isUrl = typeof file === 'string';
  $('welcome').classList.add('hidden'); $('loader').classList.remove('hidden');
  $('loadDetail').textContent = isUrl ? file : file.name + ', ' + (file.size / 1048576).toFixed(0) + ' MB';
  clearModel(); M = null;
  try {
    const budget = +store.get('detail', isTouch ? 5000000 : 8000000);
    const info = await call('open', { file: isUrl ? null : file, url: isUrl ? new URL(file, location.href).href : null, budget, cacheLimit: isTouch ? 350 * 1048576 : 900 * 1048576 });
    M = info;
    initState(info.fragments);
    hiddenFrags = new Set(info.hidden); if (info.hidden.length) setFlag(info.hidden, 1, true);
    $('fileLabel').textContent = info.name + ' · ' + info.fragments.toLocaleString() + ' objects';
    document.title = info.name + ' | AdmanWorks';
    $('loader').classList.add('hidden');
    if (info.treeError) { console.warn('tree:', info.treeError); toast('This model opened with geometry only. Its model tree uses a layout AdmanWorks can not read yet, so the Selection Tree and Properties are limited.', 9000); }
    ['tools', 'status', 'cube'].forEach(id => $(id).classList.toggle('hidden', id === 'status' ? !store.get('stats', false) : false));
    setupTree(); renderViews(); selectPaths([]);
    const v0 = firstView(info.views, /^(3d main|home|3d view|3d)/i) || firstView(info.views, /3d/i);
    fitAll(false);
    if (v0) goView(v0, false);
    if (!isTouch) { $('left').classList.remove('hidden'); }
  } catch (err) {
    console.error(err);
    $('loader').classList.add('hidden'); $('welcome').classList.remove('hidden');
    toast('Could not open file: ' + err.message, 7000);
  }
}

/* =================================================================== camera / navigation */
const nav = {
  tool: 'orbit', pivot: new THREE.Vector3(), anim: null,
  speed: +store.get('walkSpeed', 35),
};
function sceneRadius() { if (!M) return 100; const b = M.bbox; return Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2 || 100; }
function updateClip() {
  const R = sceneRadius(), d = camera.position.distanceTo(nav.pivot);
  camera.near = Math.max(0.02, Math.min(d * 0.02, R * 0.001));
  camera.far = Math.max(R * 8, d + R * 4);
  camera.updateProjectionMatrix();
}
let viewTimer = 0;
function sendView() {
  if (!M) return;
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    camera.updateMatrixWorld();
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const h = canvas.clientHeight || 600;
    worker.postMessage({ type: 'view', vp: Array.from(vp.elements), cam: camera.position.toArray(), projScale: h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)), minPx: isTouch ? 2 : 1.5,
      clip: renderer.clippingPlanes.map(p => [p.normal.x, p.normal.y, p.normal.z, p.constant]) });
  }, 120);
}
function cameraChanged() { updateClip(); requestRender(); sendView(); positionLabels(); }

function lookAtDir(dir, target, dist, animate = true) {
  const pos = target.clone().addScaledVector(dir.clone().normalize(), -dist);
  const up = Math.abs(dir.clone().normalize().z) > 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const m = new THREE.Matrix4().lookAt(pos, target, up);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  flyTo(pos, q, target, animate);
}
function flyTo(pos, quat, pivot, animate = true) {
  nav.pivot.copy(pivot);
  if (!animate) { camera.position.copy(pos); camera.quaternion.copy(quat); cameraChanged(); return; }
  const p0 = camera.position.clone(), q0 = camera.quaternion.clone(), t0 = performance.now(), T = 550;
  nav.anim = () => {
    const k = Math.min(1, (performance.now() - t0) / T), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(p0, pos, e); camera.quaternion.slerpQuaternions(q0, quat, e);
    cameraChanged();
    if (k >= 1) nav.anim = null;
  };
}
function frameBox(b, animate = true, dir) {
  if (!b) return;
  const c = new THREE.Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
  const r = Math.max(0.5, Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2);
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2) * 1.05;
  const d = dir || camera.getWorldDirection(new THREE.Vector3());
  lookAtDir(d, c, dist, animate);
}
function fitAll(animate = true) { if (M) frameBox(M.bbox, animate, animate ? undefined : new THREE.Vector3(1, 1, -0.8)); }
async function fitSelection() {
  if (!selected.frags.length) { toast('Select something first'); return; }
  frameBox(await call('bbox', { frags: selected.frags }));
}
function goView(v, animate = true) {
  const q = new THREE.Quaternion(v.quat[0], v.quat[1], v.quat[2], v.quat[3]);
  let pos = new THREE.Vector3(...v.pos);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  let fov = v.fov > 0.05 && v.fov < 3 ? THREE.MathUtils.radToDeg(v.fov) : 45;
  fov = THREE.MathUtils.clamp(fov, 20, 90);
  let focal = v.focal > 1 ? v.focal : 0;
  if (v.ortho && v.orthoHeight > 0) {   // orthographic view: show the same height with a perspective camera pulled back
    fov = 30; const dist = v.orthoHeight / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2));
    pos = pos.clone().addScaledVector(fwd, -dist); focal = dist;
  }
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov = fov; camera.updateProjectionMatrix(); }
  const pivot = pos.clone().addScaledVector(fwd, focal || sceneRadius() * 0.25);
  flyTo(pos, q, pivot, animate);
  // sectioning saved with the viewpoint
  if (v.section) {
    if (v.section.enabled && v.section.planes.length) {
      const pl = v.section.planes[0], n = new THREE.Vector3(...pl.n).normalize();
      sec.mode = 'view'; sec.viewPlane = new THREE.Plane(n, -n.dot(new THREE.Vector3(...pl.p)));
    } else if (sec.mode === 'view' || sec.mode === 'plane' || sec.mode === 'box') sec.mode = 'off';
    syncSectionUI(); applySection();
  }
  if (!focal) setTimeout(() => { const r = canvas.getBoundingClientRect(), h = pickAt(r.width / 2, r.height / 2); if (h) nav.pivot.copy(h.point); }, animate ? 700 : 50);
}
const DIRS = { top: [0, 0, -1], bottom: [0, 0, 1], front: [0, 1, 0], back: [0, -1, 0], left: [1, 0, 0], right: [-1, 0, 0], iso: [-1, 1, -0.8] };
function viewDir(name) {
  if (!M) return;
  const dist = camera.position.distanceTo(nav.pivot) || sceneRadius() * 2;
  lookAtDir(new THREE.Vector3(...DIRS[name]), nav.pivot.clone(), dist);
}

// ---- primitive camera moves
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
function orbit(dx, dy) {
  const Z = new THREE.Vector3(0, 0, 1), angX = -dx * 0.006, angY = -dy * 0.006;
  const off = camera.position.clone().sub(nav.pivot);
  tmpQ.setFromAxisAngle(Z, angX); off.applyQuaternion(tmpQ); camera.quaternion.premultiply(tmpQ);
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  // Turning about the horizontal right axis by +a raises the view by a, so the limit is applied to the
  // pitch the camera actually ends up at. (Clamping one way and turning the other let the view stick at
  // the top in one direction and roll over the top, upside down, in the other.)
  const right = new THREE.Vector3().crossVectors(fwd, Z);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  right.normalize();
  const pitch = Math.asin(THREE.MathUtils.clamp(fwd.z, -1, 1));
  const np = THREE.MathUtils.clamp(pitch - angY, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  tmpQ.setFromAxisAngle(right, np - pitch); off.applyQuaternion(tmpQ); camera.quaternion.premultiply(tmpQ);
  camera.position.copy(nav.pivot).add(off);
  levelCamera();
  cameraChanged();
}
// Keep the camera's up on the model's up (Z), like Navisworks orbit, so a rolled or upside down view
// (from a saved viewpoint or an earlier flip) rights itself on the next drag.
function levelCamera() {
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  if (Math.abs(fwd.z) > 0.995) return;   // looking straight up or down: heading comes from the current up
  const m = new THREE.Matrix4().lookAt(camera.position, camera.position.clone().add(fwd), new THREE.Vector3(0, 0, 1));
  camera.quaternion.setFromRotationMatrix(m);
}
function look(dx, dy) {
  tmpQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -dx * 0.004); camera.quaternion.premultiply(tmpQ);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), fwd = camera.getWorldDirection(new THREE.Vector3());
  const pitch = Math.asin(THREE.MathUtils.clamp(fwd.z, -1, 1)), np = THREE.MathUtils.clamp(pitch - dy * 0.004, -1.5, 1.5);
  tmpQ.setFromAxisAngle(right, np - pitch); camera.quaternion.premultiply(tmpQ);
  nav.pivot.copy(camera.position).addScaledVector(camera.getWorldDirection(new THREE.Vector3()), Math.max(1, camera.position.distanceTo(nav.pivot)));
  cameraChanged();
}
function panPixels(dx, dy, depthPoint) {
  // keep the grabbed point under the finger
  const ref = depthPoint || nav.pivot;
  const dist = Math.max(0.05, camera.getWorldDirection(new THREE.Vector3()).dot(tmpV.copy(ref).sub(camera.position)));
  const h = canvas.clientHeight, k = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / h;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const mv = right.multiplyScalar(-dx * k).add(up.multiplyScalar(dy * k));
  camera.position.add(mv); nav.pivot.add(mv);
  cameraChanged();
}
function dollyTo(point, factor) {
  // move camera toward point by factor of the distance (factor > 0 zooms in)
  const target = point || nav.pivot;
  const d = camera.position.distanceTo(target);
  const step = THREE.MathUtils.clamp(factor, -2, 0.9) * d;
  const dir = target.clone().sub(camera.position).normalize();
  if (d - step < camera.near * 2 && factor > 0) {  // push through when very close
    camera.position.addScaledVector(dir, Math.max(step, sceneRadius() * 0.01));
  } else camera.position.addScaledVector(dir, step);
  if (point) nav.pivot.copy(point);
  cameraChanged();
}
function walkStep(fwd, turn, strafe, rise, dt) {
  const base = sceneRadius() * 0.004 * Math.pow(1.06, nav.speed - 35) * 60;
  const dir = camera.getWorldDirection(new THREE.Vector3()); dir.z = 0; if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0); dir.normalize();
  const right = new THREE.Vector3(dir.y, -dir.x, 0);
  const mv = dir.multiplyScalar(fwd * base * dt).add(right.multiplyScalar(strafe * base * dt)); mv.z += rise * base * dt;
  camera.position.add(mv);
  if (turn) { tmpQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -turn * dt * 1.6); camera.quaternion.premultiply(tmpQ); }
  nav.pivot.copy(camera.position).addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 10);
  cameraChanged();
}

/* --------------------------------------------------- pointer handling (mouse + touch, Navisworks-style) */
function ex(e) { return e.clientX - canvas.getBoundingClientRect().left; }
function ey(e) { return e.clientY - canvas.getBoundingClientRect().top; }
const ptrs = new Map(); let gesture = null, lastTap = { t: 0, x: 0, y: 0 }, longTimer = 0;
canvas.addEventListener('pointerdown', e => {
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  ptrs.set(e.pointerId, { x: ex(e), y: ey(e), sx: ex(e), sy: ey(e), b: e.button });
  hideCtx();
  nav.anim = null;
  if (ptrs.size === 1) {
    const p = ptrs.get(e.pointerId);
    gesture = { kind: 'one', moved: false, t0: performance.now(), grab: null, button: e.button };
    // middle / right mouse = pan; shift+left = pan
    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || e.shiftKey)) gesture.forcePan = true;
    const tool = gesture.forcePan ? 'pan' : nav.tool;
    if (tool === 'orbit' || tool === 'pan' || tool === 'zoom') {
      const hit = pickAt(p.x, p.y);
      if (hit) { gesture.grab = hit.point; if (tool === 'orbit') { nav.pivot.copy(hit.point); showPivot(true); } }
    }
    clearTimeout(longTimer);
    if (e.pointerType !== 'mouse') longTimer = setTimeout(() => { if (gesture && !gesture.moved && ptrs.size === 1) { gesture.long = true; contextAt(p.x, p.y); } }, 550);
  } else if (ptrs.size === 2) {
    clearTimeout(longTimer);
    const [a, b] = Array.from(ptrs.values());
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const hit = pickAt(mx, my);
    gesture = { kind: 'two', moved: true, d0: Math.hypot(a.x - b.x, a.y - b.y), mx, my, grab: hit ? hit.point : null };
  }
});
canvas.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId); if (!p) return;
  const dx = ex(e) - p.x, dy = ey(e) - p.y; p.x = ex(e); p.y = ey(e);
  if (!gesture) return;
  if (gesture.kind === 'one') {
    if (!gesture.moved && Math.hypot(p.x - p.sx, p.y - p.sy) < (e.pointerType === 'mouse' ? 3 : 8)) return;
    gesture.moved = true; clearTimeout(longTimer);
    const tool = gesture.forcePan ? 'pan' : nav.tool;
    if (tool === 'orbit' || tool === 'measure') orbit(dx, dy);
    else if (tool === 'pan') panPixels(dx, dy, gesture.grab);
    else if (tool === 'zoom') dollyTo(gesture.grab, -dy * 0.01);
    else if (tool === 'look') look(dx, dy);
    else if (tool === 'walk') { walkDrag.fwd = -(p.y - p.sy) / 80; walkDrag.turn = (p.x - p.sx) / 120; startWalkLoop(); }
  } else if (gesture.kind === 'two' && ptrs.size === 2) {
    const [a, b] = Array.from(ptrs.values());
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (nav.tool === 'walk') { walkDrag.strafe = (mx - gesture.mx) / 120; walkDrag.rise = -(my - gesture.my) / 120; startWalkLoop(); }
    else {
      panPixels(mx - gesture.mx, my - gesture.my, gesture.grab);
      if (gesture.d0 > 0) dollyTo(gesture.grab, (d / gesture.d0 - 1) * 1.2);
      gesture.mx = mx; gesture.my = my;
    }
    gesture.d0 = d;
  }
});
function endPointer(e) {
  const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
  clearTimeout(longTimer);
  if (!gesture) return;
  if (gesture.kind === 'one' && p && !gesture.moved && !gesture.long && ptrs.size === 0) {
    const now = performance.now();
    if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) { focusAt(p.x, p.y); lastTap.t = 0; }
    else { lastTap = { t: now, x: p.x, y: p.y }; tapAt(p.x, p.y, e); }
  }
  if (ptrs.size === 0) { gesture = null; showPivot(false); walkDrag.fwd = walkDrag.turn = walkDrag.strafe = walkDrag.rise = 0; }
  else if (ptrs.size === 1) { const q = Array.from(ptrs.values())[0]; q.sx = q.x; q.sy = q.y; gesture = { kind: 'one', moved: true, grab: null }; }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
// iOS Safari: stop pinch from zooming the page and double-tap from scrolling
['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
canvas.addEventListener('contextmenu', e => { e.preventDefault(); contextAt(ex(e), ey(e)); });
canvas.addEventListener('wheel', e => {
  e.preventDefault(); if (!M) return;
  const hit = pickAt(ex(e), ey(e));
  const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
  dollyTo(hit ? hit.point : null, -Math.sign(dy) * Math.min(0.4, Math.abs(dy) / 300));
}, { passive: false });

// walk loop (touch drag / keys)
const walkDrag = { fwd: 0, turn: 0, strafe: 0, rise: 0 }, keys = new Set();
let walkLoop = 0, walkLast = 0;
function startWalkLoop() {
  if (walkLoop) return;
  walkLast = performance.now();
  const step = () => {
    const now = performance.now(), dt = Math.min(0.1, (now - walkLast) / 1000); walkLast = now;
    let f = walkDrag.fwd, t = walkDrag.turn, s = walkDrag.strafe, r = walkDrag.rise;
    if (keys.has('w') || keys.has('arrowup')) f += 1; if (keys.has('s') || keys.has('arrowdown')) f -= 1;
    if (keys.has('a')) s -= 1; if (keys.has('d')) s += 1; if (keys.has('arrowleft')) t -= 1; if (keys.has('arrowright')) t += 1;
    if (keys.has('e')) r += 1; if (keys.has('q')) r -= 1;
    if (f || t || s || r) { walkStep(f, t, s, r, dt); walkLoop = requestAnimationFrame(step); } else walkLoop = 0;
  };
  walkLoop = requestAnimationFrame(step);
}
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if ('wasdqe'.includes(k) && k.length === 1 || k.startsWith('arrow')) { keys.add(k); startWalkLoop(); e.preventDefault(); return; }
  if (k === 'escape') { selectPaths([]); hideCtx(); }
  else if (k === 'h') act('hide'); else if (k === 'i') act('isolate'); else if (k === 'u') act('unhide');
  else if (k === 'f') act('fitsel'); else if (k === 'home') act('fit');
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));

/* --------------------------------------------------- pivot marker + measurement overlay */
const pivotMark = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0x22c55e, depthTest: false, transparent: true, opacity: 0.85 }));
pivotMark.renderOrder = 10; pivotMark.visible = false; overlay.add(pivotMark);
function showPivot(on) {
  pivotMark.visible = on && nav.tool === 'orbit';
  if (on) { pivotMark.position.copy(nav.pivot); const d = camera.position.distanceTo(nav.pivot); pivotMark.scale.setScalar(d * 0.008); }
  requestRender();
}
const measure = { pts: [], marks: [], line: null, labelEl: null };
function clearOverlay() {
  for (const m of measure.marks) overlay.remove(m); if (measure.line) overlay.remove(measure.line);
  measure.pts = []; measure.marks = []; measure.line = null;
  document.querySelectorAll('.mlabel').forEach(n => n.remove()); measure.labelEl = null;
  $('measureOut').textContent = 'Tap two points on the model.'; requestRender();
}
function addMeasurePoint(pt) {
  if (measure.pts.length >= 2) clearOverlay();
  measure.pts.push(pt.clone());
  const s = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xbd1d23, depthTest: false }));
  s.position.copy(pt); s.renderOrder = 11; s.scale.setScalar(camera.position.distanceTo(pt) * 0.006); overlay.add(s); measure.marks.push(s);
  if (measure.pts.length === 2) {
    const [a, b] = measure.pts;
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    measure.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xbd1d23, depthTest: false })); measure.line.renderOrder = 11; overlay.add(measure.line);
    const d = a.distanceTo(b), dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y), dz = Math.abs(b.z - a.z);
    $('measureOut').innerHTML = `<b>${fmtLen(d)}</b><br>ΔX ${fmtLen(dx)} · ΔY ${fmtLen(dy)} · ΔZ ${fmtLen(dz)}<br><span class="muted">Horizontal ${fmtLen(Math.hypot(dx, dy))}</span>`;
    const el = document.createElement('div'); el.className = 'mlabel'; el.textContent = fmtLen(d); $('stage').appendChild(el); measure.labelEl = el;
    positionLabels();
  } else $('measureOut').textContent = 'Tap the second point.';
  requestRender();
}
function positionLabels() {
  if (!measure.labelEl || measure.pts.length < 2) return;
  const mid = measure.pts[0].clone().add(measure.pts[1]).multiplyScalar(0.5).project(camera);
  const r = canvas.getBoundingClientRect();
  measure.labelEl.style.left = ((mid.x + 1) / 2 * r.width) + 'px'; measure.labelEl.style.top = ((1 - mid.y) / 2 * r.height) + 'px';
  measure.labelEl.style.display = mid.z < 1 ? '' : 'none';
  for (const m of measure.marks) m.scale.setScalar(camera.position.distanceTo(m.position) * 0.006);
}

/* --------------------------------------------------- tap actions */
async function tapAt(x, y, e) {
  const hit = pickAt(x, y);
  if (nav.tool === 'measure') { if (hit) addMeasurePoint(hit.point); return; }
  if (!hit) { if (!(e && (e.ctrlKey || e.metaKey))) selectPaths([]); return; }
  const r = await call('select', { fid: hit.fid, resolution });
  const add = e && (e.ctrlKey || e.metaKey);
  if (add) {
    const has = selected.paths.includes(r.path);
    selectPaths(has ? selected.paths.filter(p => p !== r.path) : selected.paths.concat([r.path]), r.chain);
  } else selectPaths([r.path], r.chain);
}
async function focusAt(x, y) {
  const hit = pickAt(x, y); if (!hit) return;
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const dist = camera.position.distanceTo(hit.point);
  lookAtDir(dir.lengthSq() ? hit.point.clone().sub(camera.position).normalize() : dir, hit.point, Math.max(dist * 0.6, 1));
}
function hideCtx() { $('ctx').classList.add('hidden'); }
async function contextAt(x, y) {
  const hit = pickAt(x, y);
  if (hit) { const r = await call('select', { fid: hit.fid, resolution }); if (!selected.paths.includes(r.path)) selectPaths([r.path], r.chain); }
  const items = selected.paths.length ? [['Zoom to selection', 'fitsel'], ['Hide', 'hide'], ['Hide unselected', 'isolate'], ['Properties', 'props'], ['Select in tree', 'reveal']] : [];
  items.push(['Unhide all', 'unhide'], ['Zoom all', 'fit']);
  const c = $('ctx'); c.innerHTML = items.map(([t, a]) => `<button data-a="${a}">${t}</button>`).join('');
  c.style.left = Math.min(x, canvas.clientWidth - 200) + 'px'; c.style.top = Math.min(y, canvas.clientHeight - items.length * 46) + 'px';
  c.classList.remove('hidden');
}
$('ctx').addEventListener('click', e => { const a = e.target.dataset.a; hideCtx(); if (a === 'props') showPanel('right', true); else if (a === 'reveal') { showPanel('left', true); revealInTree(); } else if (a) act(a); });

/* --------------------------------------------------- selection */
let lastChain = null;
async function selectPaths(paths, chain) {
  if (selected.frags.length) setFlag(selected.frags, 2, false);
  selected = { paths, frags: new Int32Array(0) };
  if (chain) lastChain = chain;
  if (paths.length) {
    const r = await call('frags', { paths });
    if (selected.paths !== paths) return;
    selected.frags = r.frags; setFlag(r.frags, 2, true);
    showProps(paths[paths.length - 1]);
  } else showProps(null);
  markTreeSelection();
  requestRender();
}

/* =================================================================== tools & actions */
function setTool(t) {
  nav.tool = t;
  document.querySelectorAll('#tools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  $('measureBox').classList.toggle('hidden', t !== 'measure');
  $('walkBox').classList.toggle('hidden', t !== 'walk');
  if (t !== 'measure') clearOverlay();
}
async function act(a) {
  if (!M) return;
  if (a === 'fit') fitAll();
  else if (a === 'fitsel') fitSelection();
  else if (a === 'cube') $('cube').classList.toggle('hidden');
  else if (a === 'hide') { if (!selected.frags.length) return toast('Select something to hide'); for (const f of selected.frags) hiddenFrags.add(f); setFlag(selected.frags, 1, true); const s = selected.frags; selectPaths([]); toast('Hidden ' + s.length.toLocaleString() + ' pieces'); refreshTreeEyes(); }
  else if (a === 'isolate') {
    if (!selected.frags.length) return toast('Select what to keep visible');
    for (let k = 0; k < stateData.length; k += 4) stateData[k] |= 1;
    hiddenFrags = new Set(); for (let i = 0; i < fragCount; i++) hiddenFrags.add(i);
    for (const f of selected.frags) { stateData[f * 4] &= ~1; hiddenFrags.delete(f); }
    stateTex.needsUpdate = true; requestRender(); refreshTreeEyes();
  }
  else if (a === 'unhide') { clearFlag(1); hiddenFrags.clear(); refreshTreeEyes(); }
  else if (a === 'section') $('sectionBox').classList.toggle('hidden');
  else if (a === 'render') { wire = !wire; MAT.opaque.wireframe = MAT.transparent.wireframe = wire; requestRender(); toast(wire ? 'Wireframe' : 'Shaded'); }
  else if (a === 'settings') $('settings').classList.remove('hidden');
}
document.querySelectorAll('#tools [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('#tools [data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));
document.querySelectorAll('#cube [data-v]').forEach(b => b.addEventListener('click', () => viewDir(b.dataset.v)));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { $(b.dataset.close).classList.add('hidden'); if (b.dataset.close === 'measureBox' || b.dataset.close === 'walkBox') setTool('orbit'); }));
$('measureClear').onclick = clearOverlay;
$('walkSpeed').value = nav.speed; $('walkSpeed').oninput = e => { nav.speed = +e.target.value; store.set('walkSpeed', nav.speed); };

/* --------------------------------------------------- sectioning */
const sec = { mode: 'off', axis: 'top', pos: 0.7, box: [0, 0, 0, 1, 1, 1], viewPlane: null };
function syncSectionUI() {
  document.querySelectorAll('#secMode button').forEach(b => b.classList.toggle('on', b.dataset.m === sec.mode || (sec.mode === 'view' && b.dataset.m === 'plane')));
  $('secPlane').classList.toggle('hidden', sec.mode !== 'plane'); $('secBox').classList.toggle('hidden', sec.mode !== 'box');
}
function applySection() {
  const planes = [];
  if (M && sec.mode === 'view' && sec.viewPlane) planes.push(sec.viewPlane.clone());
  else if (M && sec.mode !== 'off') {
    const b = M.bbox, lerp = (i, t) => b[i] + (b[i + 3] - b[i]) * t;
    if (sec.mode === 'plane') {
      const A = { top: [0, 0, -1, 2], bottom: [0, 0, 1, 2], front: [0, 1, 0, 1], back: [0, -1, 0, 1], left: [1, 0, 0, 0], right: [-1, 0, 0, 0] }[sec.axis];
      const n = new THREE.Vector3(A[0], A[1], A[2]), v = lerp(A[3], (A[0] + A[1] + A[2]) < 0 ? sec.pos : 1 - sec.pos);
      planes.push(new THREE.Plane(n, -n.getComponent(A[3]) * v));
    } else {
      for (let i = 0; i < 3; i++) {
        const lo = lerp(i, sec.box[i]), hi = lerp(i, sec.box[i + 3]);
        const n1 = new THREE.Vector3().setComponent(i, 1), n2 = new THREE.Vector3().setComponent(i, -1);
        planes.push(new THREE.Plane(n1, -lo), new THREE.Plane(n2, hi));
      }
    }
  }
  renderer.clippingPlanes = planes; requestRender(); sendView();
}
$('secMode').addEventListener('click', e => { const m = e.target.dataset.m; if (!m) return; sec.mode = m; document.querySelectorAll('#secMode button').forEach(b => b.classList.toggle('on', b.dataset.m === m)); $('secPlane').classList.toggle('hidden', m !== 'plane'); $('secBox').classList.toggle('hidden', m !== 'box'); applySection(); });
$('secAxis').addEventListener('click', e => { const a = e.target.dataset.a; if (!a) return; sec.axis = a; document.querySelectorAll('#secAxis button').forEach(b => b.classList.toggle('on', b.dataset.a === a)); applySection(); });
$('secPos').oninput = e => { sec.pos = e.target.value / 1000; applySection(); };
document.querySelectorAll('#secBox .bx').forEach(r => r.oninput = () => { sec.box[+r.dataset.i] = r.value / 1000; applySection(); });
$('secFit').onclick = async () => {
  if (!selected.frags.length) return toast('Select something first');
  const b = await call('bbox', { frags: selected.frags }), B = M.bbox, pad = 0.02;
  for (let i = 0; i < 3; i++) { const s = B[i + 3] - B[i]; sec.box[i] = Math.max(0, (b[i] - B[i]) / s - pad); sec.box[i + 3] = Math.min(1, (b[i + 3] - B[i]) / s + pad); }
  document.querySelectorAll('#secBox .bx').forEach(r => r.value = Math.round(sec.box[+r.dataset.i] * 1000));
  applySection();
};

/* =================================================================== panels */
function showPanel(side, on) {
  const el = $(side), open = on === undefined ? el.classList.contains('hidden') : on;
  el.classList.toggle('hidden', !open);
  if (isTouch && open) $(side === 'left' ? 'right' : 'left').classList.add('hidden');
}
$('btnPanelLeft').onclick = () => showPanel('left');
$('btnPanelRight').onclick = () => showPanel('right');
document.querySelectorAll('#left .tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#left .tabs button').forEach(x => x.classList.toggle('on', x === b));
  ['tree', 'views', 'find'].forEach(t => $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
  if (b.dataset.tab === 'find') setTimeout(() => $('findText').focus(), 50);
});

/* --------------------------------------------------- selection tree (lazy) */
const TYPE_LABEL = ['', 'F', 'L', 'G', 'I', 'C', '▲'];
const treeEls = new Map();   // path -> row element
function treeRow(it, depth) {
  const row = document.createElement('div'); row.className = 'tn' + (it.hidden ? ' hid' : ''); row.dataset.path = it.path; row.style.paddingLeft = (depth * 14) + 'px';
  row.innerHTML = `<button class="tw">${it.kids ? '<svg viewBox="0 0 10 10"><path d="M3 1l5 4-5 4z"/></svg>' : ''}</button><span class="ic t${it.type}">${TYPE_LABEL[it.type] || ''}</span><span class="lb">${esc(it.name)}</span><button class="eye" title="Hide / unhide"><svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button>`;
  row.dataset.depth = depth; row.dataset.kids = it.kids ? 1 : 0;
  treeEls.set(it.path, row);
  return row;
}
async function expand(row, open) {
  const p = +row.dataset.path, depth = +row.dataset.depth;
  let box = row.nextElementSibling && row.nextElementSibling.classList.contains('tkids') ? row.nextElementSibling : null;
  if (open === undefined) open = !row.classList.contains('open');
  if (!open) { row.classList.remove('open'); if (box) box.remove(); return; }
  if (row.dataset.kids !== '1') return;
  row.classList.add('open');
  if (box) return;
  box = document.createElement('div'); box.className = 'tkids'; row.after(box);
  const r = await call('children', { path: p });
  let shown = 0;
  const addMore = () => {
    const frag = document.createDocumentFragment();
    for (let i = shown; i < Math.min(r.items.length, shown + 400); i++) frag.appendChild(treeRow(r.items[i], depth + 1));
    shown = Math.min(r.items.length, shown + 400);
    box.appendChild(frag);
    if (shown < r.items.length) { const m = document.createElement('div'); m.className = 'more'; m.textContent = `Show more (${(r.items.length - shown).toLocaleString()} left)…`; m.onclick = () => { m.remove(); addMore(); }; box.appendChild(m); }
  };
  addMore(); markTreeSelection(); refreshTreeEyes();
}
async function setupTree() {
  const t = $('tree'); t.innerHTML = ''; treeEls.clear();
  const r = await call('children', { path: 0 });
  let items = r.items;
  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(treeRow(it, 0));
  t.appendChild(frag);
  if (items.length === 1) expand(treeEls.get(items[0].path), true);
}
$('tree').addEventListener('click', async e => {
  const row = e.target.closest('.tn'); if (!row) return;
  const p = +row.dataset.path;
  if (e.target.closest('.tw')) { expand(row); return; }
  if (e.target.closest('.eye')) {
    const r = await call('frags', { paths: [p] });
    const allHidden = r.frags.length && Array.from(r.frags).every(f => hiddenFrags.has(f));
    for (const f of r.frags) allHidden ? hiddenFrags.delete(f) : hiddenFrags.add(f);
    setFlag(r.frags, 1, !allHidden); refreshTreeEyes(); return;
  }
  const add = e.ctrlKey || e.metaKey;
  selectPaths(add ? selected.paths.concat([p]) : [p]);
});
$('tree').addEventListener('dblclick', async e => { const row = e.target.closest('.tn'); if (!row) return; await selectPaths([+row.dataset.path]); fitSelection(); });
function markTreeSelection() {
  treeEls.forEach((el, p) => el.classList.toggle('sel', selected.paths.includes(p)));
}
let eyeTimer = 0;
function refreshTreeEyes() {
  clearTimeout(eyeTimer);
  eyeTimer = setTimeout(async () => {
    const paths = Array.from(treeEls.keys()).filter(p => treeEls.get(p).isConnected);
    for (const p of paths.slice(0, 600)) {
      const r = await call('frags', { paths: [p] });
      const hid = r.frags.length > 0 && Array.from(r.frags).every(f => hiddenFrags.has(f));
      treeEls.get(p).classList.toggle('hid', hid);
    }
  }, 150);
}
async function revealInTree() {
  if (!lastChain) return;
  document.querySelector('#left .tabs button[data-tab=tree]').click();
  for (let i = 1; i < lastChain.length; i++) {
    const row = treeEls.get(lastChain[i]);
    if (!row) continue;
    if (i < lastChain.length - 1 && selected.paths.includes(lastChain[i])) { row.scrollIntoView({ block: 'center' }); break; }
    if (!selected.paths.includes(lastChain[i])) await expand(row, true);
    else { row.scrollIntoView({ block: 'center' }); break; }
  }
  markTreeSelection();
}

/* --------------------------------------------------- properties */
let propTab = 0;
let propPath = null, propTabName = null;   // item and tab shown in the Properties panel
async function showProps(path) {
  propPath = path === undefined ? null : path;
  if (path === null || path === undefined) { $('propTitle').textContent = 'Properties'; $('propType').textContent = ''; $('propTabs').innerHTML = ''; $('propBody').innerHTML = '<div class="muted small pad">Tap an item in the model or the tree to see its properties.</div>'; return; }
  const r = await call('props', { path });
  if (!r || propPath !== path) return;   // a newer selection is already on its way
  $('propTitle').textContent = r.title; $('propType').textContent = r.tabs[0] && r.tabs[0].rows[1] ? r.tabs[0].rows[1][1] : '';
  if (propTab >= r.tabs.length) propTab = 0;
  const keep = r.tabs.findIndex(t => t.name === propTabName); if (keep >= 0) propTab = keep;
  const draw = () => {
    $('propTabs').innerHTML = r.tabs.map((t, i) => `<button data-i="${i}" class="${i === propTab ? 'on' : ''}">${esc(t.name)}</button>`).join('');
    const rows = (r.tabs[propTab] || { rows: [] }).rows;
    $('propBody').innerHTML = '<table class="ptable">' + rows.map(([k, v]) => {
      let val;
      if (v && typeof v === 'object' && v.url) val = `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.url)}</a>`;
      else if (v && typeof v === 'object' && v.color) val = `<span class="swatch" style="background:rgb(${v.color.map(c => Math.round(c * 255)).join(',')})"></span>${esc(v.text)}`;
      else val = esc(v);
      return `<tr><td>${esc(k)}</td><td>${val}</td></tr>`;
    }).join('') + '</table>';
  };
  draw();
  $('propTabs').onclick = e => { const i = e.target.dataset.i; if (i !== undefined) { propTab = +i; propTabName = r.tabs[propTab].name; draw(); } };
}

/* --------------------------------------------------- viewpoints */
function savedViews() { return M ? store.get('views:' + M.name, []) : []; }
// Viewpoints panel: the file's folder tree (Navisworks "Saved Viewpoints") followed by views saved on this device.
function renderViews() {
  const own = savedViews(), flat = [];
  let html = '';
  const walk = (list, depth) => {
    for (const v of list) {
      const i = flat.length; flat.push(v);
      if (v.folder) {
        html += `<div class="it vf" data-i="${i}" style="padding-left:${12 + depth * 16}px"><span class="ic t3">▸</span><span class="nm"><b>${esc(v.name)}</b></span><span class="muted small">${countViews(v.children) || ''}</span></div><div class="vkids hidden" data-k="${i}">`;
        walk(v.children, depth + 1); html += '</div>';
      } else {
        html += `<div class="it" data-i="${i}" style="padding-left:${12 + depth * 16}px"><span class="ic t${v.own ? 5 : 1}">${v.own ? '★' : 'V'}</span><span class="nm">${esc(v.name)}</span>${v.section && v.section.enabled ? '<span class="muted small">§</span>' : ''}${v.own ? '<button class="del" title="Delete">×</button>' : ''}</div>`;
      }
    }
  };
  walk(M ? M.views : [], 0);
  if (own.length) { html += '<div class="sec-h pad" style="margin:0"><span class="n">★</span> SAVED ON THIS DEVICE</div>'; walk(own.map(v => Object.assign({ own: true }, v)), 0); }
  $('viewList').innerHTML = html || '<div class="muted small pad">No saved viewpoints in this file.</div>';
  $('viewList').onclick = e => {
    const it = e.target.closest('.it'); if (!it) return; const v = flat[+it.dataset.i];
    if (v.folder) { const box = $('viewList').querySelector(`.vkids[data-k="${it.dataset.i}"]`); box.classList.toggle('hidden'); it.querySelector('.ic').textContent = box.classList.contains('hidden') ? '▸' : '▾'; return; }
    if (e.target.classList.contains('del')) { store.set('views:' + M.name, savedViews().filter(x => x.name !== v.name || x.pos.join() !== v.pos.join())); renderViews(); return; }
    $('viewList').querySelectorAll('.it.on').forEach(x => x.classList.remove('on')); it.classList.add('on');
    goView(v); if (isTouch) showPanel('left', false);
  };
}
function countViews(list) { let n = 0; for (const v of list) n += v.folder ? countViews(v.children) : 1; return n; }
function firstView(list, re) { for (const v of list) { if (v.folder) { const r = firstView(v.children, re); if (r) return r; } else if (!re || re.test(v.name)) return v; } return null; }
$('btnSaveView').onclick = () => {
  if (!M) return;
  const name = prompt('Name this viewpoint', 'View ' + (savedViews().length + 1)); if (!name) return;
  const v = { name, pos: camera.position.toArray(), quat: camera.quaternion.toArray(), focal: camera.position.distanceTo(nav.pivot) };
  store.set('views:' + M.name, savedViews().concat([v])); renderViews(); toast('Viewpoint saved on this device');
};

/* --------------------------------------------------- find */
let findTimer = 0;
$('findText').addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    const q = $('findText').value; if (!M || q.trim().length < 2) { $('findList').innerHTML = ''; $('findInfo').textContent = ''; return; }
    const res = await call('find', { text: q, max: 300 });
    $('findInfo').textContent = res.length >= 300 ? 'First 300 matches' : res.length + ' match' + (res.length === 1 ? '' : 'es');
    $('findList').innerHTML = res.map(it => `<div class="it" data-p="${it.path}"><span class="ic t${it.type}">${TYPE_LABEL[it.type] || ''}</span><span class="nm">${esc(it.name)}<span class="sub">${esc(it.where || '')}</span></span></div>`).join('');
  }, 250);
});
$('findList').onclick = async e => { const it = e.target.closest('.it'); if (!it) return; await selectPaths([+it.dataset.p]); fitSelection(); };

/* --------------------------------------------------- settings */
$('setBudget').value = String(store.get('detail', isTouch ? 5000000 : 8000000));
$('setRes').value = resolution;
$('setBg').value = store.get('bg', 'grad');
$('setLines').checked = showLines;
$('setStats').checked = store.get('stats', false);
$('setBudget').onchange = e => { store.set('detail', +e.target.value); limitNoticeShown = false; worker.postMessage({ type: 'settings', budget: +e.target.value }); sendView(); };
$('setRes').onchange = e => { resolution = e.target.value; store.set('res', resolution); };
$('setBg').onchange = e => { store.set('bg', e.target.value); setBackground(e.target.value); };
$('setLines').onchange = e => { showLines = e.target.checked; store.set('lines', showLines); for (const c of cells.values()) for (const o of c.objs) if (o.userData.lines) o.visible = showLines; requestRender(); };
$('detailNote').onclick = () => $('settings').classList.remove('hidden');
$('setStats').onchange = e => { store.set('stats', e.target.checked); $('status').classList.toggle('hidden', !e.target.checked || !M); };
$('settings').addEventListener('click', e => { if (e.target.id === 'settings') $('settings').classList.add('hidden'); });
setBackground(store.get('bg', 'grad'));

/* --------------------------------------------------- status */
let fps = 0, frames = 0, fpsT = performance.now();
let limitNoticeShown = false;
// The loader keeps a set number of triangles on screen. When that hides visible items, say so once.
function detailLimited(on) {
  $('detailNote').classList.toggle('hidden', !on);
  if (on && !limitNoticeShown) { limitNoticeShown = true; toast('Some small items are not drawn at this detail level. Raise Detail in Settings to show everything.', 7000); }
}
function updateStatus() {
  if ($('status').classList.contains('hidden')) return;
  $('status').textContent = `${(shownTris / 1e6).toFixed(2)}M tris · ${cells.size} cells${loadingCells ? ' · loading ' + loadingCells : ''} · ${fps} fps`;
}

/* --------------------------------------------------- open file UI */
$('btnOpen').onclick = $('btnOpen2').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => { const f = e.target.files[0]; e.target.value = ''; openFile(f); };
addEventListener('dragover', e => { e.preventDefault(); });
addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) openFile(f); });
if (isTouch) $('dropHint').classList.add('hidden');

/* =================================================================== render loop */
function loop() {
  requestAnimationFrame(loop);
  if (nav.anim) nav.anim();
  if (!needsRender) return;
  needsRender = false;
  renderer.render(scene, camera);
  frames++;
  const now = performance.now(); if (now - fpsT > 1000) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; updateStatus(); }
}
resize(); loop();
{ const q = new URLSearchParams(location.search).get('url'); if (q) openFile(q); }
window.__viewer = { THREE, scene, camera, renderer, call, openFile, act, setTool, goView, pickAt, get M() { return M; }, cells };
