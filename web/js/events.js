// 里程碑：历史事件 + 根据星历实时计算出的预测事件
import { jdFromISO, LIGHT_DAY_AU, AU_KM, bisect, keplerPos } from './ephemeris.js';

const fmtKm = (km) => Math.round(km).toLocaleString('en-US') + ' km';

export function buildEvents(eph) {
  const { voyager, planetPos } = eph;
  const st = { p: [0, 0, 0], v: [0, 0, 0] }, q = [0, 0, 0], e = [0, 0, 0];
  const distTo = (key, jd) => { voyager.at(jd, st); planetPos(key, jd, q); return Math.hypot(st.p[0] - q[0], st.p[1] - q[1], st.p[2] - q[2]); };
  const sunDist = (jd) => { voyager.at(jd, st); return Math.hypot(...st.p); };
  const earthDist = (jd) => { voyager.at(jd, st); keplerPos('earth', jd, e); return Math.hypot(st.p[0] - e[0], st.p[1] - e[1], st.p[2] - e[2]); };

  // 最近点：先粗扫再细化
  const closest = (key, from, to) => {
    let best = from, bd = Infinity;
    for (let jd = from; jd <= to; jd += 1 / 24) { const d = distTo(key, jd); if (d < bd) { bd = d; best = jd; } }
    for (let jd = best - 1 / 24; jd <= best + 1 / 24; jd += 1 / 1440) { const d = distTo(key, jd); if (d < bd) { bd = d; best = jd; } }
    return { jd: best, km: bd * AU_KM };
  };
  const jup = closest('jupiter', jdFromISO('1979-03-01'), jdFromISO('1979-03-10'));
  const sat = closest('saturn', jdFromISO('1980-11-08'), jdFromISO('1980-11-16'));

  // 距离首次越过阈值的时刻
  const firstCross = (f, thr, from, to, step = 1) => {
    let prev = f(from) - thr;
    for (let jd = from + step; jd <= to; jd += step) {
      const cur = f(jd) - thr;
      if (prev < 0 && cur >= 0) return bisect((x) => f(x) - thr, jd - step, jd, 1e-4);
      prev = cur;
    }
    return null;
  };
  // 最后一次越过（此后再也不会回落到阈值以下）
  const lastCross = (f, thr, from, to, step = 1) => {
    let found = null, prev = f(from) - thr;
    for (let jd = from + step; jd <= to; jd += step) {
      const cur = f(jd) - thr;
      if (prev < 0 && cur >= 0) found = bisect((x) => f(x) - thr, jd - step, jd, 1e-4);
      prev = cur;
    }
    return found;
  };

  const ld1 = firstCross(earthDist, LIGHT_DAY_AU, jdFromISO('2024-01-01'), jdFromISO('2030-01-01'));
  const ld1p = lastCross(earthDist, LIGHT_DAY_AU, jdFromISO('2024-01-01'), jdFromISO('2030-01-01'));
  const ld2 = firstCross(earthDist, 2 * LIGHT_DAY_AU, jdFromISO('2060-01-01'), jdFromISO('2099-01-01'));
  const au200 = firstCross(sunDist, 200, jdFromISO('2026-01-01'), jdFromISO('2060-01-01'), 5);
  const au300 = firstCross(sunDist, 300, jdFromISO('2040-01-01'), jdFromISO('2099-01-01'), 5);

  // 远期（超出星历范围）：按渐近速度线性外推
  const end = voyager.rows[voyager.rows.length - 1];
  const rEnd = Math.hypot(end[1], end[2], end[3]);
  const vr = (end[1] * end[4] + end[2] * end[5] + end[3] * end[6]) / rEnd; // AU/天
  const yearAt = (au) => 2201 + (au - rEnd) / vr / 365.25;
  const LY_AU = 63241.077;

  const E = [
    { iso: '1977-09-05T12:56:00Z', title: '发射', sub: '泰坦 IIIE 火箭，卡纳维拉尔角。比旅行者二号晚 16 天出发' },
    { iso: '1977-09-18', title: '第一张地月同框照片', sub: '在 1,166 万公里外，首次把地球和月球拍进同一张照片' },
    { iso: '1977-12-15', title: '超越旅行者二号', sub: '走了更快的轨道，从此成为“一号”' },
    { jd: jup.jd, title: '飞掠木星', sub: `最近距木星中心 ${fmtKm(jup.km)}；发现木卫一的活火山`, focus: 'jupiter' },
    { jd: sat.jd, title: '飞掠土星', sub: `最近距土星中心 ${fmtKm(sat.km)}；为近距离观测土卫六，轨道被甩出黄道面`, focus: 'saturn' },
    { iso: '1990-02-14', title: '暗淡蓝点', sub: '在约 40 AU 外回望，拍下“全家福”，地球只占 0.12 个像素' },
    { iso: '1998-02-17', title: '最遥远的人造物体', sub: '超越先驱者 10 号，此后一直保持这一纪录' },
    { iso: '2004-12-16', title: '穿越终端激波', sub: '太阳风在此骤然减速，进入日鞘（约 94 AU）' },
    { iso: '2012-08-25', title: '进入星际空间', sub: '穿越日球层顶（约 121.6 AU），第一个离开日球层的人造物体' },
    { iso: '2017-11-28', title: '唤醒沉睡 37 年的推力器', sub: '轨道修正推力器自 1980 年后首次点火，接替老化的姿控推力器' },
    { iso: '2024-04-20', title: '远程修复计算机故障', sub: '飞行数据系统一块芯片失效，工程师把代码搬到别处，恢复回传' },
  ];
  const dips = ld1p && Math.abs(ld1p - ld1) > 5;
  if (ld1) E.push({ jd: ld1, title: '距地球 1 光日', sub: '约 259 亿公里，地面发出的指令要整整 24 小时才能到达' + (dips ? '。地球公转会让距离在之后短暂回落' : '，此后再也不会回到 1 光日以内'), computed: true });
  if (dips) E.push({ jd: ld1p, title: '永久超过 1 光日', sub: '此后与地球距离再也不会少于 1 光日', computed: true });
  E.push({ iso: '2030-06-01', approx: '约 2030 年代', title: '电力耗尽，仪器陆续关闭', sub: '核电源每年衰减约 4 W，工程师在逐台关闭仪器延寿（NASA 估计）', predicted: true });
  if (au200) E.push({ jd: au200, title: '距太阳 200 AU', sub: '约 300 亿公里', predicted: true, computed: true });
  if (ld2) E.push({ jd: ld2, title: '距地球 2 光日', sub: '早已失联，但仍按惯性飞行', predicted: true, computed: true });
  if (au300) E.push({ jd: au300, title: '距太阳 300 AU', sub: '', predicted: true, computed: true });
  const far = [
    { year: 2300, title: '抵达奥尔特云内边缘', sub: `NASA 估计约 300 年后进入；彼时距太阳约 ${Math.round(rEnd + vr * (jdFromISO('2300-01-01') - end[0])).toLocaleString()} AU，穿越它还需约 3 万年` },
    { year: yearAt(LY_AU), title: '距太阳 1 光年', sub: `约 63,241 AU，按渐近速度 ${(vr * AU_KM / 86400).toFixed(2)} km/s 外推` },
    { year: 40272, title: '掠过 Gliese 445', sub: '在约 1.6 光年处经过鹿豹座的这颗红矮星——它是旅行者一号遇到的“下一颗星”' },
  ];
  for (const ev of E) if (ev.iso) ev.jd = jdFromISO(ev.iso);
  E.sort((a, b) => a.jd - b.jd);
  return { events: E, far, asymptoticKms: vr * AU_KM / 86400 };
}
