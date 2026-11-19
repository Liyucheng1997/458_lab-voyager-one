// 星历：旅行者一号真实轨迹（JPL Horizons）+ 行星位置（JPL 近似开普勒根数）+ 二体外推
export const AU_KM = 149597870.7;
export const C_KMS = 299792.458;
export const LIGHT_DAY_AU = (C_KMS * 86400) / AU_KM; // ≈173.14 AU
export const GM_SUN = 2.959122082855911e-4;           // AU³/day²
const TDB_MINUS_UTC = 69.184 / 86400;                 // 天
const DEG = Math.PI / 180;

export const jdFromDate = (d) => d.getTime() / 86400000 + 2440587.5;
export const dateFromJd = (jd) => new Date((jd - 2440587.5) * 86400000);
export const jdFromISO = (s) => jdFromDate(new Date(s.length <= 10 ? s + 'T00:00:00Z' : s));
export const nowJd = () => jdFromDate(new Date());

// ---------- 带速度的三次 Hermite 插值表 ----------
export class Track {
  constructor(rows) {
    this.rows = rows; // [jd, x, y, z, vx, vy, vz]
    this.jd0 = rows[0][0];
    this.jd1 = rows[rows.length - 1][0];
  }
  index(jd) {
    const r = this.rows;
    let lo = 0, hi = r.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (r[m][0] <= jd) lo = m; else hi = m;
    }
    return lo;
  }
  at(jd, out = { p: [0, 0, 0], v: [0, 0, 0] }) {
    const r = this.rows;
    if (jd <= this.jd0 || jd >= this.jd1) {
      const e = jd <= this.jd0 ? r[0] : r[r.length - 1];
      const dt = jd - e[0];
      for (let k = 0; k < 3; k++) { out.p[k] = e[k + 1] + e[k + 4] * dt; out.v[k] = e[k + 4]; }
      return out;
    }
    const i = this.index(jd), a = r[i], b = r[i + 1];
    const h = b[0] - a[0], s = (jd - a[0]) / h, s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const d00 = (6 * s2 - 6 * s) / h, d10 = 3 * s2 - 4 * s + 1, d01 = (-6 * s2 + 6 * s) / h, d11 = 3 * s2 - 2 * s;
    for (let k = 0; k < 3; k++) {
      const pa = a[k + 1], pb = b[k + 1], va = a[k + 4], vb = b[k + 4];
      out.p[k] = h00 * pa + h10 * h * va + h01 * pb + h11 * h * vb;
      out.v[k] = d00 * pa + d10 * va + d01 * pb + d11 * vb;
    }
    return out;
  }
}

// ---------- 二体外推（Horizons 数据止于 2100 年） ----------
function accel(p) {
  const r = Math.hypot(p[0], p[1], p[2]), k = -GM_SUN / (r * r * r);
  return [p[0] * k, p[1] * k, p[2] * k];
}
export function extrapolate(last, jdEnd, step = 5, keepEvery = 6) {
  let p = last.slice(1, 4), v = last.slice(4, 7), jd = last[0];
  const out = [];
  let n = 0;
  const add = (a, b, s) => a.map((x, i) => x + b[i] * s);
  while (jd < jdEnd) {
    const k1v = accel(p), k1p = v;
    const k2v = accel(add(p, k1p, step / 2)), k2p = add(v, k1v, step / 2);
    const k3v = accel(add(p, k2p, step / 2)), k3p = add(v, k2v, step / 2);
    const k4v = accel(add(p, k3p, step)), k4p = add(v, k3v, step);
    p = p.map((x, i) => x + (step / 6) * (k1p[i] + 2 * k2p[i] + 2 * k3p[i] + k4p[i]));
    v = v.map((x, i) => x + (step / 6) * (k1v[i] + 2 * k2v[i] + 2 * k3v[i] + k4v[i]));
    jd += step;
    if (++n % keepEvery === 0) out.push([jd, ...p, ...v]);
  }
  return out;
}

// ---------- 行星：JPL "Approximate Positions of the Planets" 表 1 ----------
// [a, e, I, L, 近日点经度 ϖ, 升交点经度 Ω] 及每世纪变化率
const ELEMENTS = {
  mercury: [[0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  venus:   [[0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255], [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418]],
  earth:   [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0]],
  mars:    [[1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  jupiter: [[5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  saturn:  [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  uranus:  [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503], [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
};
export const PLANETS = [
  { key: 'mercury', name: '水星', period: 87.969, color: 0x9a9a9a, px: 3 },
  { key: 'venus', name: '金星', period: 224.701, color: 0xe6d3a3, px: 3.5 },
  { key: 'earth', name: '地球', period: 365.256, color: 0x4d8fe0, px: 4 },
  { key: 'mars', name: '火星', period: 686.98, color: 0xc1663f, px: 3.5 },
  { key: 'jupiter', name: '木星', period: 4332.59, color: 0xd8b48a, px: 6 },
  { key: 'saturn', name: '土星', period: 10759.22, color: 0xe3cf9b, px: 5.5 },
  { key: 'uranus', name: '天王星', period: 30688.5, color: 0x9fd6dc, px: 4.5 },
  { key: 'neptune', name: '海王星', period: 60182, color: 0x5577d8, px: 4.5 },
];

export function keplerPos(key, jd, out = [0, 0, 0]) {
  const [e0, rate] = ELEMENTS[key];
  const T = (jd - 2451545.0) / 36525;
  const a = e0[0] + rate[0] * T, e = e0[1] + rate[1] * T, I = (e0[2] + rate[2] * T) * DEG;
  const L = e0[3] + rate[3] * T, wbar = e0[4] + rate[4] * T, O = (e0[5] + rate[5] * T) * DEG;
  const w = wbar * DEG - O;
  let M = ((L - wbar) % 360 + 540) % 360 - 180;
  M *= DEG;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
  out[0] = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  out[1] = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  out[2] = sw * sI * xp + cw * sI * yp;
  return out;
}

// ---------- 数据加载 ----------
export async function loadEphemeris(url) {
  const raw = await (await fetch(url)).json();
  const toUtc = (rows) => rows.map((r) => [r[0] - TDB_MINUS_UTC, ...r.slice(1)]);
  const rows = toUtc(raw.rows);
  const horizonsEnd = rows[rows.length - 1][0];
  const extra = extrapolate(rows[rows.length - 1], jdFromISO('2201-01-01'));
  const voyager = new Track(rows.concat(extra));
  const precise = {};
  for (const [k, r] of Object.entries(raw.planets || {})) precise[k] = new Track(toUtc(r));

  // 木星/土星：飞掠期间用 Horizons 精确位置，之后两年内把偏差平滑过渡到开普勒根数
  const tmp = { p: [0, 0, 0], v: [0, 0, 0] }, kp = [0, 0, 0];
  const planetPos = (key, jd, out = [0, 0, 0]) => {
    keplerPos(key, jd, out);
    const tr = precise[key];
    if (!tr) return out;
    if (jd >= tr.jd0 && jd <= tr.jd1) { tr.at(jd, tmp); out[0] = tmp.p[0]; out[1] = tmp.p[1]; out[2] = tmp.p[2]; return out; }
    if (jd > tr.jd1 && jd < tr.jd1 + 730) {
      tr.at(tr.jd1, tmp); keplerPos(key, tr.jd1, kp);
      const w = 1 - (jd - tr.jd1) / 730;
      for (let k = 0; k < 3; k++) out[k] += (tmp.p[k] - kp[k]) * w;
    }
    return out;
  };
  return { voyager, planetPos, horizonsEnd, jdMin: rows[0][0], source: raw.source };
}

// ---------- 天文辅助 ----------
const EPS = 23.4392911 * DEG;
export function eclToRaDec(v) {
  const x = v[0], y = v[1] * Math.cos(EPS) - v[2] * Math.sin(EPS), z = v[1] * Math.sin(EPS) + v[2] * Math.cos(EPS);
  const r = Math.hypot(x, y, z);
  let ra = Math.atan2(y, x) / DEG / 15; if (ra < 0) ra += 24;
  return { ra, dec: Math.asin(z / r) / DEG };
}
export function eclLonLat(v) {
  let lon = Math.atan2(v[1], v[0]) / DEG; if (lon < 0) lon += 360;
  return { lon, lat: Math.asin(v[2] / Math.hypot(v[0], v[1], v[2])) / DEG };
}

// 二分法求 f(jd) 的过零点（f 在 [a,b] 两端异号）
export function bisect(f, a, b, tol = 1e-5) {
  let fa = f(a);
  for (let i = 0; i < 80 && b - a > tol; i++) {
    const m = (a + b) / 2, fm = f(m);
    if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m;
  }
  return (a + b) / 2;
}
