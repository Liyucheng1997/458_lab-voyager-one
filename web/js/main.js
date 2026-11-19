// 旅行者一号 · 主场景：太阳系 + 真实轨迹 + 拖拽时间 + 实时位置 + 预测
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import * as E from './ephemeris.js';
import { buildEvents } from './events.js';
import { createModelView } from './model-view.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const LAUNCH_JD = E.jdFromISO('1977-09-05T12:56:00Z');
const TS_JD = E.jdFromISO('2004-12-16'), HP_JD = E.jdFromISO('2012-08-25');
const JD_MAX = E.jdFromISO('2200-12-31');
// 黄道坐标 (x, y, z) → three.js（Y 轴朝上，黄道面水平）
const S = (p, v = new THREE.Vector3()) => v.set(p[0], p[2], -p[1]);

// ---------------------------------------------------------------- 数据
const [eph, gltf] = await Promise.all([
  E.loadEphemeris('data/voyager1.json'),
  new GLTFLoader().loadAsync('models/voyager1.glb'),
]);
const { voyager, planetPos, horizonsEnd } = eph;
const JD_MIN = eph.jdMin;
const NOW0 = E.nowJd();
const { events, far } = buildEvents(eph);

const state = { jd: NOW0, playing: true, rate: 1, live: true, dragging: null, view: 'system', follow: null, tween: null, evTab: 'all' };

// ---------------------------------------------------------------- 渲染器 / 场景
const canvas = $('space');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const pm = new THREE.PMREMGenerator(renderer);
scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.3;
const camera = new THREE.PerspectiveCamera(45, 1, 1e-7, 2e6);
scene.add(new THREE.AmbientLight(0xffffff, 0.12));
const sunLight = new THREE.PointLight(0xfff4e0, 2.4, 0, 0);
scene.add(sunLight);

// 星空
{
  const n = 7000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    pos.set([s * Math.cos(t) * 5e5, u * 5e5, s * Math.sin(t) * 5e5], i * 3);
    const b = 0.18 + 0.82 * Math.pow(Math.random(), 4), tint = Math.random();
    col.set([b * (tint > 0.85 ? 1 : 0.9), b * 0.93, b * (tint < 0.2 ? 1 : 0.88)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false })));
}

// 光晕贴图
function glowTexture(inner = 'rgba(255,255,255,1)', mid = 'rgba(255,255,255,0.25)') {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(0.18, mid); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// 太阳
const sun = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ color: 0xffe2a8 }));
scene.add(sun);
const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,236,200,1)', 'rgba(255,190,110,0.35)'), blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false }));
sunGlow.scale.setScalar(0.09);
scene.add(sunGlow);

// 行星 + 轨道
const REAL_R = { mercury: 1.63e-5, venus: 4.05e-5, earth: 4.26e-5, mars: 2.27e-5, jupiter: 4.78e-4, saturn: 4.03e-4, uranus: 1.71e-4, neptune: 1.65e-4 };
const planets = E.PLANETS.map((P) => {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshStandardMaterial({ color: P.color, roughness: 0.85, emissive: P.color, emissiveIntensity: 0.18 }));
  scene.add(mesh);
  const pts = [];
  for (let i = 0; i <= 256; i++) pts.push(S(E.keplerPos(P.key, NOW0 + (P.period * i) / 256)));
  const orbit = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8e8e93, transparent: true, opacity: 0.22, depthWrite: false }));
  scene.add(orbit);
  return { ...P, mesh, orbit, pos: new THREE.Vector3(), raw: [0, 0, 0] };
});
// 土星环（自转轴：赤经 40.59°，赤纬 83.54°）
{
  const sat = planets.find((p) => p.key === 'saturn');
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.24, 2.27, 96), new THREE.MeshStandardMaterial({ color: 0xd9c9a3, side: THREE.DoubleSide, transparent: true, opacity: 0.75, roughness: 1 }));
  const ra = 40.59 * DEG, dec = 83.54 * DEG, eps = 23.4392911 * DEG;
  const q = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const pole = S([q[0], q[1] * Math.cos(eps) + q[2] * Math.sin(eps), -q[1] * Math.sin(eps) + q[2] * Math.cos(eps)]).normalize();
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), pole);
  sat.mesh.add(ring);
}

// 日球层：终端激波 ~94 AU、日球层顶 ~121.6 AU（示意为球壳）
function shell(radius, color, strength) {
  const m = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, strength: { value: strength } },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <logdepthbuf_pars_fragment>
      uniform vec3 color; uniform float strength; varying vec3 vN; varying vec3 vV;
      void main(){
        #include <logdepthbuf_fragment>
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 4.0);
        gl_FragColor = vec4(color * f * strength, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const s = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 48), m);
  scene.add(s);
  return s;
}
shell(94, 0x0a84ff, 0.22);
shell(121.6, 0x0a84ff, 0.35);

// ---------------------------------------------------------------- 轨迹
const rows = voyager.rows;
const trajPts = new Float32Array(rows.length * 3), trajJd = new Float64Array(rows.length);
rows.forEach((r, i) => { trajPts.set([r[1], r[3], -r[2]], i * 3); trajJd[i] = r[0]; });
const lineMats = [];
function makeLine(fromJd, toJd, color, opacity, width) {
  const arr = [];
  const tmp = { p: [0, 0, 0], v: [0, 0, 0] };
  const pushJd = (jd) => { voyager.at(jd, tmp); arr.push(tmp.p[0], tmp.p[2], -tmp.p[1]); };
  pushJd(fromJd);
  for (let i = 0; i < rows.length; i++) if (rows[i][0] > fromJd && rows[i][0] < toJd) arr.push(trajPts[i * 3], trajPts[i * 3 + 1], trajPts[i * 3 + 2]);
  pushJd(toJd);
  const g = new LineGeometry(); g.setPositions(arr);
  const m = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
  lineMats.push(m);
  const l = new Line2(g, m); l.computeLineDistances(); scene.add(l);
  return l;
}
makeLine(JD_MIN, NOW0, 0x0a84ff, 1, 2.4);             // 历史（实测/重建轨道）
makeLine(NOW0, horizonsEnd, 0x64aaff, 0.5, 1.8);      // JPL 预测
makeLine(horizonsEnd, JD_MAX, 0x8e8e93, 0.45, 1.4);   // 二体外推

// 地球 → 探测器的通信视线
const losGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const los = new THREE.Line(losGeo, new THREE.LineBasicMaterial({ color: 0x30d158, transparent: true, opacity: 0.28, depthWrite: false }));
scene.add(los);

// ---------------------------------------------------------------- 探测器
const probe = new THREE.Group();
const probeModel = gltf.scene.clone(true);
probe.add(probeModel);
const probeGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(120,190,255,1)', 'rgba(10,132,255,0.35)'), blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false }));
probeGlow.scale.setScalar(0.035);
scene.add(probe, probeGlow);
const modelView = createModelView($('modelView'), gltf.scene, $('partInfo'));

// ---------------------------------------------------------------- 相机与控制
// 先注册轨迹拖拽，保证它在 OrbitControls 之前处理 pointerdown
canvas.addEventListener('pointerdown', onPointerDown);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.zoomSpeed = 1.4;
controls.minDistance = 1e-5;
controls.maxDistance = 4000;

const st = { p: [0, 0, 0], v: [0, 0, 0] };
const probePos = new THREE.Vector3(), earthRaw = [0, 0, 0], earthPos = new THREE.Vector3();
function computeState(jd) {
  voyager.at(jd, st);
  S(st.p, probePos);
  E.keplerPos('earth', jd, earthRaw);
  S(earthRaw, earthPos);
}
computeState(state.jd);

function viewTargets(view) {
  const up = new THREE.Vector3(0, 1, 0);
  if (view === 'system') {
    const dir = probePos.clone().normalize();
    const side = new THREE.Vector3().crossVectors(up, dir).normalize();
    const tgt = probePos.clone().multiplyScalar(0.42);
    return { target: () => tgt, pos: () => tgt.clone().add(side.clone().multiplyScalar(-330)).add(up.clone().multiplyScalar(140)).add(dir.clone().multiplyScalar(-90)) };
  }
  if (view === 'inner') return { target: () => new THREE.Vector3(), pos: () => new THREE.Vector3(5, 7, 13) };
  if (view === 'follow') {
    return {
      target: () => probePos.clone(),
      pos: () => { const d = probePos.clone().normalize(); const side = new THREE.Vector3().crossVectors(up, d).normalize(); return probePos.clone().add(d.multiplyScalar(-4)).add(side.multiplyScalar(-6)).add(up.clone().multiplyScalar(3)); },
      follow: () => probePos,
    };
  }
  if (view.startsWith('planet:')) {
    const p = planets.find((x) => x.key === view.slice(7));
    const dist = REAL_R[p.key] * 26;
    return {
      target: () => p.pos.clone(),
      pos: () => { const d = probePos.clone().sub(p.pos).normalize(); const side = new THREE.Vector3().crossVectors(up, d).normalize(); return p.pos.clone().add(side.multiplyScalar(dist)).add(up.clone().multiplyScalar(dist * 0.55)).add(d.multiplyScalar(-dist * 0.4)); },
      follow: () => p.pos,
    };
  }
}
function setView(view, instant = false) {
  state.view = view;
  const vt = viewTargets(view);
  state.follow = vt.follow || null;
  state.followPrev = vt.follow ? vt.follow().clone() : null;
  document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (instant) { controls.target.copy(vt.target()); camera.position.copy(vt.pos()); return; }
  state.tween = { t0: performance.now(), dur: 1400, fromT: controls.target.clone(), fromP: camera.position.clone(), vt };
}
$('viewSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); });

// ---------------------------------------------------------------- 屏幕投影工具
const _v = new THREE.Vector3(), _m = new THREE.Matrix4();
let W = 1, H = 1;
function toScreen(v3) {
  _v.copy(v3).project(camera);
  return { x: (_v.x + 1) * 0.5 * W, y: (1 - _v.y) * 0.5 * H, ok: _v.z < 1 && _v.z > -1 };
}
function pxSize(pos, px) {
  return (camera.position.distanceTo(pos) * 2 * Math.tan((camera.fov * DEG) / 2) / H) * px;
}
// 轨迹上离鼠标最近的点（返回屏幕距离与对应时刻）
function nearestOnTrajectory(mx, my) {
  _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = _m.elements, n = trajJd.length;
  let best = { d: Infinity, jd: state.jd }, px = 0, py = 0, pok = false;
  for (let i = 0; i < n; i++) {
    const x = trajPts[i * 3], y = trajPts[i * 3 + 1], z = trajPts[i * 3 + 2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const ok = w > 0;
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) * 0.5 * W;
    const sy = (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 * H;
    if (i > 0 && ok && pok && trajJd[i] <= JD_MAX) {
      const dx = sx - px, dy = sy - py, L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? ((mx - px) * dx + (my - py) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px + dx * t - mx, py + dy * t - my);
      if (d < best.d) best = { d, jd: trajJd[i - 1] + (trajJd[i] - trajJd[i - 1]) * t };
    }
    px = sx; py = sy; pok = ok;
  }
  best.jd = Math.max(JD_MIN, Math.min(JD_MAX, best.jd));
  return best;
}

// ---------------------------------------------------------------- 拖拽轨迹改时间
function mouseXY(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
function hitTest(mx, my) {
  const ps = toScreen(probePos);
  if (ps.ok && Math.hypot(ps.x - mx, ps.y - my) < 26) return true;
  return nearestOnTrajectory(mx, my).d < 9;
}
function onPointerDown(e) {
  if (e.button !== 0) return;
  const [mx, my] = mouseXY(e);
  if (!hitTest(mx, my)) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  state.dragging = '3d';
  state.live = false;
  canvas.classList.add('grabbing');
  canvas.setPointerCapture(e.pointerId);
  $('hint').classList.add('hide');
}
canvas.addEventListener('pointermove', (e) => {
  const [mx, my] = mouseXY(e);
  if (state.dragging === '3d') { setJd(nearestOnTrajectory(mx, my).jd); return; }
  if (e.buttons) return;
  canvas.classList.toggle('grab', hitTest(mx, my));
});
const endDrag = () => { if (state.dragging === '3d') { state.dragging = null; canvas.classList.remove('grabbing'); } };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function setJd(jd) {
  state.jd = Math.max(JD_MIN, Math.min(JD_MAX, jd));
}

// ---------------------------------------------------------------- 时间轴
const track = $('track'), thumb = $('thumb');
const frac = (jd) => (jd - JD_MIN) / (JD_MAX - JD_MIN);
const pct = (jd) => (frac(jd) * 100).toFixed(3) + '%';
function layoutTrack() {
  $('segPast').style.width = pct(NOW0);
  $('segPred').style.left = pct(NOW0); $('segPred').style.width = ((frac(horizonsEnd) - frac(NOW0)) * 100) + '%';
  $('segExtra').style.left = pct(horizonsEnd); $('segExtra').style.width = ((1 - frac(horizonsEnd)) * 100) + '%';
  $('nowMark').style.left = pct(NOW0);
  const yrs = $('years'); yrs.innerHTML = '';
  const step = track.clientWidth < 600 ? 40 : 20;
  for (let y = 1980; y <= 2200; y += step) {
    const s = document.createElement('span'); s.textContent = y; s.style.left = pct(E.jdFromISO(`${y}-01-01`)); yrs.appendChild(s);
  }
  const ticks = $('ticks'); ticks.innerHTML = '';
  for (const ev of events) {
    const t = document.createElement('div');
    t.className = 'tick' + (ev.jd <= NOW0 ? ' past' : '');
    t.style.left = pct(ev.jd); t.title = ev.title;
    t.addEventListener('pointerdown', (e) => { e.stopPropagation(); jumpTo(ev); });
    ticks.appendChild(t);
  }
}
const trackJd = (e) => { const r = track.getBoundingClientRect(); return JD_MIN + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (JD_MAX - JD_MIN); };
track.addEventListener('pointerdown', (e) => {
  state.dragging = 'track'; state.live = false; track.setPointerCapture(e.pointerId); thumb.classList.add('drag'); setJd(trackJd(e));
});
track.addEventListener('pointermove', (e) => { if (state.dragging === 'track') setJd(trackJd(e)); });
const endTrack = () => { if (state.dragging === 'track') { state.dragging = null; thumb.classList.remove('drag'); } };
track.addEventListener('pointerup', endTrack);
track.addEventListener('pointercancel', endTrack);

// 播放控制
const PLAY_ICO = '<path fill="currentColor" d="M8 5.5v13l10.5-6.5z"/>', PAUSE_ICO = '<path fill="currentColor" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>';
function setPlaying(p) { state.playing = p; $('playIco').innerHTML = p ? PAUSE_ICO : PLAY_ICO; }
$('playBtn').addEventListener('click', () => { if (!state.playing && state.jd >= JD_MAX - 1) setJd(JD_MIN); setPlaying(!state.playing); });
$('rateSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.rate = +b.dataset.rate;
  document.querySelectorAll('#rateSeg button').forEach((x) => x.classList.toggle('on', x === b));
  state.live = state.rate === 1 && Math.abs(state.jd - E.nowJd()) < 1 / 24;
  setPlaying(true);
});
function goNow() {
  state.live = true; state.rate = 1; setJd(E.nowJd()); setPlaying(true);
  document.querySelectorAll('#rateSeg button').forEach((x) => x.classList.toggle('on', x.dataset.rate === '1'));
}
$('nowBtn').addEventListener('click', goNow);
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
  const step = e.altKey ? 1 / 24 : e.shiftKey ? 30 : 1;
  if (e.code === 'ArrowRight') { state.live = false; setJd(state.jd + step); }
  if (e.code === 'ArrowLeft') { state.live = false; setJd(state.jd - step); }
});

// ---------------------------------------------------------------- 里程碑 / 预测
function fmtDate(jd, withTime = false) {
  const d = E.dateFromJd(jd), p = (n) => String(n).padStart(2, '0');
  const s = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return withTime ? `${s} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` : s;
}
function fmtSpan(days) {
  const a = Math.abs(days);
  if (a >= 365.25) { const y = Math.floor(a / 365.25); return `${y} 年 ${Math.floor(a - y * 365.25)} 天`; }
  if (a >= 1) return `${Math.floor(a)} 天 ${Math.floor((a % 1) * 24)} 小时`;
  return `${Math.floor(a * 24)} 小时 ${Math.floor((a * 1440) % 60)} 分`;
}
function jumpTo(ev) {
  state.live = false;
  setJd(ev.jd);
  if (ev.focus) setView('planet:' + ev.focus);
}
let lastNext = -2, lastTab = '';
function renderEvents() {
  const list = $('evList');
  const nextIdx = events.findIndex((ev) => ev.jd > state.jd);
  if (nextIdx === lastNext && lastTab === state.evTab) return;
  lastNext = nextIdx; lastTab = state.evTab;
  list.innerHTML = '';
  events.forEach((ev, i) => {
    if (state.evTab === 'future' && ev.jd <= NOW0) return;
    const li = document.createElement('li');
    li.className = 'ev' + (i < nextIdx || nextIdx < 0 ? ' done' : '') + (i === nextIdx ? ' next' : '');
    const pred = ev.jd > NOW0;
    li.innerHTML = `<span class="d">${ev.approx || fmtDate(ev.jd)}</span>
      <span class="t">${ev.title}${pred ? '<span class="tag">预测</span>' : ''}</span>
      ${ev.sub ? `<span class="s">${ev.sub}</span>` : ''}
      ${i === nextIdx ? '<span class="cd" id="countdown"></span>' : ''}`;
    li.addEventListener('click', () => jumpTo(ev));
    list.appendChild(li);
  });
}
$('farList').innerHTML = far.map((f) => `<li class="ev"><span class="d">约 ${Math.round(f.year).toLocaleString('en-US')} 年</span><span class="t">${f.title}<span class="tag">外推</span></span><span class="s">${f.sub}</span></li>`).join('');
$('srcNote').textContent = `轨迹数据：NASA/JPL Horizons（${fmtDate(JD_MIN)} — ${fmtDate(horizonsEnd)}，其中 ${fmtDate(NOW0)} 之后为 JPL 弹道预测）；2100 年后为二体外推。行星位置：JPL 近似开普勒根数，木星、土星飞掠期间用 Horizons 精确星历。`;
$('evSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.evTab = b.dataset.tab;
  document.querySelectorAll('#evSeg button').forEach((x) => x.classList.toggle('on', x === b));
  renderEvents();
});
const pd = $('predictDate');
pd.addEventListener('change', () => { if (pd.value) { state.live = false; setJd(E.jdFromISO(pd.value) + 0.5); } });

// ---------------------------------------------------------------- 标签
const labelLayer = $('labels');
function mkLabel(cls, html) { const d = document.createElement('div'); d.className = 'lbl ' + cls; d.innerHTML = html; labelLayer.appendChild(d); return d; }
const sunLabel = mkLabel('planet', '太阳');
planets.forEach((p) => (p.label = mkLabel('planet', p.name)));
const probeLabel = mkLabel('probe', '旅行者一号<small></small>');
const evDots = events.map((ev) => {
  const d = document.createElement('div');
  d.className = 'ev-dot' + (ev.jd > NOW0 ? ' pred' : '');
  d.innerHTML = `<span>${ev.approx || fmtDate(ev.jd)} · ${ev.title}</span>`;
  d.addEventListener('click', () => jumpTo(ev));
  labelLayer.appendChild(d);
  const tmp = { p: [0, 0, 0], v: [0, 0, 0] };
  voyager.at(ev.jd, tmp);
  return { el: d, pos: S(tmp.p) };
});
function placeLabels() {
  const placed = [];
  const put = (el, v3, minGap = 16, dot = false, off = 9) => {
    const s = toScreen(v3);
    const clash = placed.some((q) => Math.abs(q.x - s.x) < minGap * 3 && Math.abs(q.y - s.y) < minGap);
    if (!s.ok || clash || s.x < -50 || s.y < -50 || s.x > W + 50 || s.y > H + 50) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.style.transform = dot ? `translate(${s.x}px,${s.y}px)` : `translate(${s.x + off}px,${s.y}px) translateY(-50%)`;
    placed.push(s);
  };
  put(probeLabel, probePos, 6, false, +(probeLabel.dataset.off || 30));
  put(sunLabel, sun.position, 12);
  for (let i = planets.length - 1; i >= 0; i--) put(planets[i].label, planets[i].pos, 12);
  const dotsPlaced = [];
  for (const d of evDots) {
    const s = toScreen(d.pos);
    const clash = dotsPlaced.some((q) => Math.hypot(q.x - s.x, q.y - s.y) < 14);
    if (!s.ok || clash) { d.el.style.display = 'none'; continue; }
    d.el.style.display = ''; d.el.style.transform = `translate(${s.x}px,${s.y}px)`; dotsPlaced.push(s);
  }
}

// ---------------------------------------------------------------- 信息面板
const AU = E.AU_KM;
const fmtKm = (km) => Math.round(km).toLocaleString('en-US');
const pad = (n) => String(n).padStart(2, '0');
function updateInfo() {
  const jd = state.jd, r = Math.hypot(...st.p);
  const dx = st.p[0] - earthRaw[0], dy = st.p[1] - earthRaw[1], dz = st.p[2] - earthRaw[2];
  const re = Math.hypot(dx, dy, dz);
  const e1 = E.keplerPos('earth', jd + 0.01), e0 = E.keplerPos('earth', jd - 0.01);
  const ve = [(e1[0] - e0[0]) / 0.02, (e1[1] - e0[1]) / 0.02, (e1[2] - e0[2]) / 0.02];
  const rdot = (dx * (st.v[0] - ve[0]) + dy * (st.v[1] - ve[1]) + dz * (st.v[2] - ve[2])) / re * AU / 86400;
  const lt = (re * AU) / E.C_KMS;
  const hasFlown = jd >= LAUNCH_JD;
  $('sunKm').innerHTML = `${fmtKm(r * AU)}<small>km</small>`;
  $('sunAu').textContent = `${r.toFixed(4)} AU · ${(r * AU / 1e8).toFixed(3)} 亿公里 · ${(r / E.LIGHT_DAY_AU * 24).toFixed(2)} 光时`;
  $('earthDist').textContent = `${re.toFixed(4)} AU · ${(re * AU / 1e8).toFixed(2)} 亿 km`;
  $('lightTime').textContent = `${Math.floor(lt / 3600)} 时 ${pad(Math.floor((lt % 3600) / 60))} 分 ${pad(Math.floor(lt % 60))} 秒`;
  $('speed').textContent = `${(Math.hypot(...st.v) * AU / 86400).toFixed(3)} km/s`;
  $('radial').innerHTML = `${rdot >= 0 ? '远离' : '靠近'} ${Math.abs(rdot).toFixed(2)} km/s`;
  const rd = E.eclToRaDec([dx, dy, dz]), ll = E.eclLonLat(st.p);
  const raH = Math.floor(rd.ra), raM = Math.floor((rd.ra - raH) * 60);
  $('radec').textContent = `${raH}h ${pad(raM)}m · ${rd.dec >= 0 ? '+' : '−'}${Math.abs(rd.dec).toFixed(2)}°`;
  $('lonlat').textContent = `${ll.lon.toFixed(2)}° · ${ll.lat >= 0 ? '+' : '−'}${Math.abs(ll.lat).toFixed(2)}°`;
  $('elapsed').textContent = hasFlown ? fmtSpan(jd - LAUNCH_JD) : '—';
  $('regionBadge').textContent = jd < TS_JD ? '日球层内 · 太阳风' : jd < HP_JD ? '日鞘' : '星际空间';
  probeLabel.querySelector('small').textContent = `${r.toFixed(2)} AU`;

  const now = E.nowJd();
  const live = state.live, pred = jd > now + 1 / 1440;
  const stEl = $('statusText').parentElement;
  stEl.className = 'status' + (live ? ' live' : pred ? ' pred' : '');
  $('statusText').textContent = live ? '实时 · 当前真实位置' : pred ? (jd > horizonsEnd ? '预测 · 二体外推' : '预测 · JPL 弹道') : '历史回放';
  $('tlDate').innerHTML = `${fmtDate(jd, true)} <small>UTC</small>`;
  thumb.style.left = pct(jd);
  renderEvents();
  const cd = $('countdown'), nx = events.find((ev) => ev.jd > jd);
  if (cd && nx) cd.textContent = `还有 ${fmtSpan(nx.jd - jd)}`;
}

// ---------------------------------------------------------------- 主循环
const up = new THREE.Vector3(0, 1, 0), tmpV = new THREE.Vector3(), qInv = new THREE.Quaternion();
let last = performance.now();
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  W = r.width; H = r.height;
  renderer.setSize(W, H, false);
  camera.aspect = W / H; camera.updateProjectionMatrix();
  lineMats.forEach((m) => m.resolution.set(W, H));
  layoutTrack();
}
new ResizeObserver(resize).observe(canvas.parentElement);
resize();

function frame(t) {
  const dt = Math.min(0.1, (t - last) / 1000); last = t;
  if (state.live) state.jd = E.nowJd();
  else if (state.playing && !state.dragging) {
    setJd(state.jd + (dt * state.rate) / 86400);
    if (state.jd >= JD_MAX) setPlaying(false);
  }
  computeState(state.jd);

  // 行星
  for (const p of planets) {
    planetPos(p.key, state.jd, p.raw); S(p.raw, p.pos);
    p.mesh.position.copy(p.pos);
    p.mesh.scale.setScalar(Math.max(REAL_R[p.key], pxSize(p.pos, p.px)));
  }
  sun.scale.setScalar(Math.max(0.00465, pxSize(sun.position, 6)));

  // 探测器：模型保持约 64 px 大小，高增益天线始终对准地球
  probe.position.copy(probePos);
  probeGlow.position.copy(probePos);
  const probePx = state.view.startsWith('planet:') ? 30 : 64;
  probe.scale.setScalar(pxSize(probePos, probePx) / 3.66);
  probeLabel.dataset.off = probePx * 0.55;
  tmpV.copy(earthPos).sub(probePos).normalize();
  probe.quaternion.setFromUnitVectors(up, tmpV);
  los.geometry.attributes.position.setXYZ(0, earthPos.x, earthPos.y, earthPos.z);
  los.geometry.attributes.position.setXYZ(1, probePos.x, probePos.y, probePos.z);
  los.geometry.attributes.position.needsUpdate = true;

  // 相机：跟随 + 补间
  if (state.follow) {
    const cur = state.follow();
    if (state.followPrev && !state.tween) { tmpV.copy(cur).sub(state.followPrev); camera.position.add(tmpV); controls.target.add(tmpV); }
    state.followPrev = cur.clone();
  }
  if (state.tween) {
    const tw = state.tween, k = Math.min(1, (t - tw.t0) / tw.dur), e = 1 - Math.pow(1 - k, 4);
    controls.target.lerpVectors(tw.fromT, tw.vt.target(), e);
    camera.position.lerpVectors(tw.fromP, tw.vt.pos(), e);
    if (k >= 1) state.tween = null;
  }
  controls.update();
  // 近裁剪面随视距变化：太小会让穿过相机背后的轨迹线段在着色器里精度崩坏
  const near = Math.max(1e-7, camera.position.distanceTo(controls.target) * 2e-4);
  if (Math.abs(near - camera.near) / camera.near > 0.05) { camera.near = near; camera.updateProjectionMatrix(); }
  renderer.render(scene, camera);

  // 小窗模型的光照：太阳在探测器本体坐标系中的方向
  qInv.copy(probe.quaternion).invert();
  modelView.update(tmpV.copy(probePos).negate().normalize().applyQuaternion(qInv));

  placeLabels();
  updateInfo();
  requestAnimationFrame(frame);
}
setView('system', true);
// 开场：从远处推近
camera.position.multiplyScalar(2.2);
setView('system');
setPlaying(true);
$('loading').classList.add('hide');
requestAnimationFrame(frame);
setTimeout(() => $('hint').classList.add('hide'), 12000);
