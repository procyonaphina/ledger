// 零依赖 Canvas 图表（替代 Chart.js 在线 CDN），支持高清屏与深色模式
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export const PALETTE = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#64748b'];

function setup(cv) {
  const w = cv.clientWidth, hh = cv.clientHeight;
  if (!w || !hh) return null;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px -apple-system, system-ui, sans-serif';
  return { ctx, w, h: hh };
}
const yuan = c => { const y = c / 100; return Math.abs(y) >= 1e4 ? `${+(y / 1e4).toFixed(1)}万` : String(Math.round(y)); };
function niceMax(c) {
  const y = Math.max(c / 100, 1), p = 10 ** Math.floor(Math.log10(y));
  return [1, 2, 2.5, 5, 10].find(k => k * p >= y) * p * 100;
}
function empty(ctx, w, h) {
  ctx.fillStyle = cssv('--sub'); ctx.textAlign = 'center'; ctx.font = '14px system-ui';
  ctx.fillText('暂无数据', w / 2, h / 2);
}

/** 环形图。items: [{label, value(分), color}] */
export function donut(cv, items, { title = '', total = '' } = {}) {
  const s = setup(cv); if (!s) return;
  const { ctx, w, h } = s, sum = items.reduce((a, b) => a + b.value, 0);
  if (!sum) return empty(ctx, w, h);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6, r = R * 0.62;
  let a = -Math.PI / 2;
  for (const it of items) {
    const d = it.value / sum * Math.PI * 2;
    ctx.beginPath(); ctx.arc(cx, cy, R, a, a + d); ctx.arc(cx, cy, r, a + d, a, true); ctx.closePath();
    ctx.fillStyle = it.color; ctx.fill(); a += d;
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = cssv('--sub'); ctx.font = '12px system-ui'; ctx.fillText(title, cx, cy - 6);
  ctx.fillStyle = cssv('--text'); ctx.font = 'bold 16px system-ui'; ctx.fillText(total, cx, cy + 14);
}

/** 折线图 / 分组柱状图。series: [{color, values(分)}] */
export function cartesian(cv, labels, series, mode = 'line') {
  const s = setup(cv); if (!s) return;
  const { ctx, w, h } = s;
  const L = 40, R = 8, T = 10, B = 22, iw = w - L - R, ih = h - T - B, n = labels.length;
  const mx = Math.max(0, ...series.flatMap(x => x.values));
  if (!mx) return empty(ctx, w, h);
  const max = niceMax(mx);
  ctx.strokeStyle = cssv('--line'); ctx.fillStyle = cssv('--sub'); ctx.lineWidth = 1; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = T + ih - ih * i / 4;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
    ctx.fillText(yuan(max * i / 4), L - 6, y + 4);
  }
  ctx.textAlign = 'center';
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 36))));
  const xAt = i => mode === 'bars' ? L + iw / n * (i + .5) : (n > 1 ? L + iw * i / (n - 1) : L + iw / 2);
  const yAt = v => T + ih - ih * v / max;
  labels.forEach((t, i) => { if (i % every === 0) ctx.fillText(t, xAt(i), h - 6); });
  series.forEach((se, j) => {
    if (mode === 'bars') {
      const slot = iw / n, bw = slot * .7 / series.length;
      ctx.fillStyle = se.color;
      se.values.forEach((v, i) => { if (v) ctx.fillRect(L + slot * i + slot * .15 + bw * j, yAt(v), Math.max(1, bw - 1), T + ih - yAt(v)); });
    } else {
      ctx.beginPath();
      se.values.forEach((v, i) => { const x = xAt(i), y = yAt(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = se.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.lineTo(xAt(n - 1), T + ih); ctx.lineTo(xAt(0), T + ih); ctx.closePath();
      ctx.globalAlpha = .1; ctx.fillStyle = se.color; ctx.fill(); ctx.globalAlpha = 1;
      if (n <= 12) { ctx.fillStyle = se.color; se.values.forEach((v, i) => { ctx.beginPath(); ctx.arc(xAt(i), yAt(v), 3, 0, 7); ctx.fill(); }); }
    }
  });
}
