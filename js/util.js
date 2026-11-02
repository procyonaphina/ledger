// 通用工具：DOM 构建（不使用 innerHTML）、金额（整数分）、日期、CSV、文件保存
export const $ = (sel, root = document) => root.querySelector(sel);

/** 安全的 DOM 构建：所有文本都走 textContent / createTextNode，用户输入不会被当作 HTML 执行 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  const late = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked') late.push([k, v]);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  for (const [k, v] of late) el[k] = v;
  return el;
}

export const debounce = (fn, ms) => {
  let t;
  const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  f.cancel = () => clearTimeout(t);
  return f;
};

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const a = crypto.getRandomValues(new Uint8Array(16));
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 金额：全部用整数“分”，不使用浮点数累加 ----------
export const MAX_CENTS = 1e10; // 单笔上限 1 亿元

/** 把用户输入解析为整数分；格式不合法返回 null（最多两位小数） */
export function parseMoney(input, { signed = false } = {}) {
  let s = String(input ?? '').trim().replace(/[,\s¥￥]/g, '');
  let neg = false;
  if (signed && s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  const c = Number(i) * 100 + Number((f + '00').slice(0, 2));
  return neg && c ? -c : c;
}

export function fmt(cents, sign = false) {
  const neg = cents < 0, a = Math.abs(cents);
  const body = Math.floor(a / 100).toLocaleString('en-US') + '.' + String(a % 100).padStart(2, '0');
  return (neg ? '-' : sign ? '+' : '') + body;
}

export const centsToStr = c => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

// ---------- 日期 ----------
export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthOf = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
export const addMonth = (key, n) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
export const monthLabel = k => { const [y, m] = k.split('-'); return `${y}年${+m}月`; };
export const daysIn = k => { const [y, m] = k.split('-').map(Number); return new Date(y, m, 0).getDate(); };
export const toLocalInput = ms => { const d = new Date(ms); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fromLocalInput = s => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(s)) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
};
export const validYmd = s => {
  if (!/^\d{4}-\d\d-\d\d$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 1970 || y > 2200) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};

/** 周期账单第 n 次发生的时间（本地 09:00）。月/年周期遇到月底自动取当月最后一天，不会漂移 */
export function occurrence(start, freq, n) {
  const [y, m, d] = start.split('-').map(Number);
  if (freq === 'daily') return new Date(y, m - 1, d + n, 9, 0);
  if (freq === 'weekly') return new Date(y, m - 1, d + 7 * n, 9, 0);
  const t = m - 1 + (freq === 'yearly' ? 12 : 1) * n;
  const yy = y + Math.floor(t / 12), mm = ((t % 12) + 12) % 12;
  return new Date(yy, mm, Math.min(d, new Date(yy, mm + 1, 0).getDate()), 9, 0);
}

// ---------- CSV / 文件 ----------
/** 防 CSV 公式注入：以 = + - @ 开头的文本前面加单引号 */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 保存文件：iPhone 优先走系统分享面板（可“存储到文件”），否则普通下载。返回是否已保存 */
export async function saveFile(content, filename, type) {
  const file = new File([content], filename, { type });
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  if (ios && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}
