// 备份 / 校验 / 加密 / 快照 / 旧版数据转换
import * as db from './db.js';
import { uid, parseMoney, MAX_CENTS, validYmd, ymd } from './util.js';

export const APP = 'pocket-ledger';
export const MAX_FILE = 30 * 1024 * 1024;
const ITER = 600000;
const MAX_AUTO_SNAPSHOTS = 20;
const ACC_TYPES = ['cash', 'bank', 'alipay', 'wechat', 'credit', 'other'];
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
const LIM = { bills: 200000, accounts: 200, categories: 500, budgets: 600, templates: 200, recurring: 200 };

const enc = new TextEncoder(), dec = new TextDecoder();
const AAD = enc.encode('pocket-ledger/v2');

// ---------- SHA-256（有 WebCrypto 用 WebCrypto，没有则用纯 JS 兜底） ----------
function sha256js(bytes) {
  const primes = [];
  for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
  const frac = x => x - Math.floor(x);
  const K = primes.map(p => Math.floor(frac(Math.cbrt(p)) * 2 ** 32));
  let H = primes.slice(0, 8).map(p => Math.floor(frac(Math.sqrt(p)) * 2 ** 32));
  const l = bytes.length, total = ((l + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total); buf.set(bytes); buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(l / 2 ** 29)); dv.setUint32(total - 4, (l << 3) >>> 0);
  const w = new Uint32Array(64), rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H = H.map((v, i) => (v + [a, b, c, d, e, f, g, hh][i]) >>> 0);
  }
  return H.map(v => v.toString(16).padStart(8, '0')).join('');
}
export const sha256js_forTest = sha256js;

export async function sha256(text) {
  const bytes = enc.encode(text);
  if (globalThis.crypto?.subtle) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256js(bytes);
}

// ---------- 加密（PBKDF2-SHA256 + AES-256-GCM） ----------
const b64e = u8 => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(pw, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptText(text, pw) {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持加密（需要 HTTPS 访问）');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pw, salt, ITER);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, enc.encode(text)));
  return {
    app: APP, schema: 2, encrypted: true,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITER, salt: b64e(salt) },
    cipher: { name: 'AES-GCM', iv: b64e(iv) },
    data: b64e(ct),
  };
}

function codeErr(msg, code) { const e = new Error(msg); e.code = code; return e; }

export async function decryptEnvelope(env, pw) {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持解密（需要 HTTPS 访问）');
  try {
    const it = env.kdf?.iterations;
    if (env.kdf?.name !== 'PBKDF2' || env.cipher?.name !== 'AES-GCM' || !Number.isInteger(it) || it < 100000 || it > 2000000 || typeof env.data !== 'string')
      throw new Error('bad envelope');
    const salt = b64d(env.kdf.salt), iv = b64d(env.cipher.iv);
    if (salt.length !== 16 || iv.length !== 12) throw new Error('bad envelope');
    const key = await deriveKey(pw, salt, it);
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, b64d(env.data)));
  } catch {
    throw codeErr('密码不正确，或文件已损坏', 'BAD_PASSWORD');
  }
}

// ---------- 数据校验：只保留已知字段，严格检查类型、范围、引用 ----------
export function validateData(raw) {
  const errs = [];
  const bad = m => { if (errs.length < 8) errs.push(m); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('数据结构不正确');
  const list = k => {
    const v = raw[k] ?? [];
    if (!Array.isArray(v)) { bad(`${k} 必须是数组`); return []; }
    if (v.length > LIM[k]) { bad(`${k} 数量超过上限`); return []; }
    return v;
  };
  const obj = v => v && typeof v === 'object' && !Array.isArray(v);
  const str = (v, max, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max;
  const money = (v, lo, hi = MAX_CENTS) => Number.isSafeInteger(v) && v >= lo && v <= hi;
  const seen = new Set();
  const uniq = (k, id) => { const key = k + '|' + id; if (seen.has(key)) { bad(`${k} 存在重复 id`); return false; } seen.add(key); return true; };

  const accounts = list('accounts').flatMap((a, i) => {
    if (!obj(a) || !str(a.id, 64, 1) || !str(a.name, 30, 1) || !ACC_TYPES.includes(a.type) || !money(a.initial, -1e12, 1e12)) { bad(`账户 #${i + 1} 无效`); return []; }
    if (!uniq('account', a.id)) return [];
    return [{ id: a.id, name: a.name, type: a.type, initial: a.initial, archived: a.archived === true, created: Number.isFinite(a.created) ? a.created : 0 }];
  });
  const categories = list('categories').flatMap((c, i) => {
    if (!obj(c) || !str(c.id, 64, 1) || !str(c.name, 30, 1)) { bad(`分类 #${i + 1} 无效`); return []; }
    if (!uniq('category', c.id)) return [];
    return [{ id: c.id, name: c.name, o: Number.isFinite(c.o) ? c.o : 0 }];
  });
  if (!categories.some(c => c.id === 'cat_other')) categories.push({ id: 'cat_other', name: '其他', o: 9999 });
  const accIds = new Set(accounts.map(a => a.id)), catIds = new Set(categories.map(c => c.id));

  const bills = list('bills').flatMap((b, i) => {
    const ok = obj(b) && str(b.id, 80, 1) && ['in', 'out', 'transfer'].includes(b.type) && money(b.amount, 1)
      && Number.isFinite(b.time) && b.time > 0 && b.time < 4.1e12 && str(b.note ?? '', 200)
      && accIds.has(b.accountId)
      && (b.type === 'transfer' ? accIds.has(b.toAccountId) && b.toAccountId !== b.accountId : catIds.has(b.categoryId));
    if (!ok) { bad(`账单 #${i + 1} 无效`); return []; }
    if (!uniq('bill', b.id)) return [];
    const r = { id: b.id, type: b.type, amount: b.amount, categoryId: b.type === 'transfer' ? '' : b.categoryId, accountId: b.accountId, toAccountId: b.type === 'transfer' ? b.toAccountId : '', note: b.note ?? '', time: b.time };
    if (typeof b.recurringId === 'string' && b.recurringId.length <= 80) r.recurringId = b.recurringId;
    return [r];
  });
  const budgets = list('budgets').flatMap((b, i) => {
    if (!obj(b) || !(b.key === '_total' || catIds.has(b.key)) || !money(b.cents, 0, 1e12)) { bad(`预算 #${i + 1} 无效`); return []; }
    return uniq('budget', b.key) ? [{ key: b.key, cents: b.cents }] : [];
  });
  const templates = list('templates').flatMap((t, i) => {
    if (!obj(t) || !str(t.id, 64, 1) || !str(t.name, 30, 1) || !['in', 'out'].includes(t.type) || !money(t.amount, 1) || !catIds.has(t.categoryId) || !accIds.has(t.accountId) || !str(t.note ?? '', 200)) { bad(`模板 #${i + 1} 无效`); return []; }
    return uniq('template', t.id) ? [{ id: t.id, name: t.name, type: t.type, amount: t.amount, categoryId: t.categoryId, accountId: t.accountId, note: t.note ?? '' }] : [];
  });
  const recurring = list('recurring').flatMap((r, i) => {
    if (!obj(r) || !str(r.id, 64, 1) || !['in', 'out'].includes(r.type) || !money(r.amount, 1) || !catIds.has(r.categoryId) || !accIds.has(r.accountId)
      || !FREQS.includes(r.freq) || !validYmd(r.start) || !(r.end === '' || validYmd(r.end)) || !Number.isSafeInteger(r.n) || r.n < 0 || r.n > 1e6 || !str(r.note ?? '', 200)) { bad(`周期规则 #${i + 1} 无效`); return []; }
    return uniq('recurring', r.id) ? [{ id: r.id, type: r.type, amount: r.amount, categoryId: r.categoryId, accountId: r.accountId, note: r.note ?? '', freq: r.freq, start: r.start, end: r.end, n: r.n, active: r.active !== false }] : [];
  });
  if (errs.length) throw new Error('校验失败：' + errs.join('；') + (errs.length >= 8 ? '…' : ''));
  if (!accounts.length) throw new Error('校验失败：至少需要一个账户');
  return { bills, accounts, categories, budgets, templates, recurring };
}

export const countsOf = d => ({ bills: d.bills.length, accounts: d.accounts.length, categories: d.categories.length, templates: d.templates.length, recurring: d.recurring.length });

export function defaultData() {
  const cats = [['cat_food', '餐饮'], ['cat_traffic', '交通'], ['cat_shop', '购物'], ['cat_med', '医疗'], ['cat_study', '学习'], ['cat_salary', '工资'], ['cat_other', '其他']];
  return {
    bills: [], budgets: [], templates: [], recurring: [],
    accounts: [{ id: 'acc_cash', name: '现金', type: 'cash', initial: 0, archived: false, created: Date.now() }],
    categories: cats.map(([id, name], i) => ({ id, name, o: i + 1 })),
  };
}

// ---------- 旧版（localStorage / 旧备份）转换 ----------
export function fromLegacy(old) {
  const DEF = { 餐饮: 'cat_food', 交通: 'cat_traffic', 购物: 'cat_shop', 医疗: 'cat_med', 学习: 'cat_study', 工资: 'cat_salary', 其他: 'cat_other' };
  const idOf = new Map(), categories = [];
  const cat = name => {
    name = String(name || '其他').slice(0, 30);
    if (!idOf.has(name)) { const id = DEF[name] || uid(); idOf.set(name, id); categories.push({ id, name, o: categories.length + 1 }); }
    return idOf.get(name);
  };
  (Array.isArray(old.categories) ? old.categories : []).forEach(cat); cat('其他');
  const cents = v => { const c = parseMoney(v); if (c != null) return c; const n = Math.round(Number(v) * 100); return Number.isFinite(n) ? n : 0; };
  const acc = { id: 'acc_cash', name: '现金', type: 'cash', initial: 0, archived: false, created: Date.now() };
  const src = Array.isArray(old.bills) ? old.bills : [];
  const bills = src.map(b => ({
    id: uid(), type: b?.type === 'in' ? 'in' : 'out', amount: cents(b?.amount), categoryId: cat(b?.category),
    accountId: acc.id, toAccountId: '', note: String(b?.note || '').slice(0, 200), time: Date.parse(b?.time),
  })).filter(b => b.amount > 0 && b.amount <= MAX_CENTS && Number.isFinite(b.time));
  const budgets = Object.entries(old.budgets && typeof old.budgets === 'object' ? old.budgets : {})
    .map(([k, v]) => ({ key: k === '_total' ? k : cat(k), cents: cents(v) })).filter(b => b.cents > 0);
  const templates = (Array.isArray(old.templates) ? old.templates : []).map(t => ({
    id: uid(), name: String(t?.name || '模板').slice(0, 30), type: t?.type === 'in' ? 'in' : 'out', amount: cents(t?.amount),
    categoryId: cat(t?.category), accountId: acc.id, note: String(t?.note || '').slice(0, 200),
  })).filter(t => t.amount > 0 && t.amount <= MAX_CENTS);
  return { data: { bills, accounts: [acc], categories, budgets, templates, recurring: [] }, dropped: src.length - bills.length };
}

// ---------- 备份文件 ----------
export async function makeBackup(data) {
  return { app: APP, schema: 2, exportedAt: new Date().toISOString(), counts: countsOf(data), checksum: await sha256(JSON.stringify(data)), data };
}
export async function makeEncrypted(data, pw) {
  return encryptText(JSON.stringify(await makeBackup(data)), pw);
}

/** 解析并校验备份文本。加密备份需要密码（抛出 NEED_PASSWORD / BAD_PASSWORD）。返回校验后的 data */
export async function parseBackup(text, password) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('文件不是有效的 JSON'); }
  if (!obj || typeof obj !== 'object') throw new Error('无法识别的备份文件');
  const info = { encrypted: false, legacy: false, exportedAt: '', dropped: 0 };
  if (obj.app === APP && obj.encrypted === true) {
    if (!password) throw codeErr('这是加密备份，需要密码', 'NEED_PASSWORD');
    const plain = await decryptEnvelope(obj, password);
    try { obj = JSON.parse(plain); } catch { throw codeErr('密码不正确，或文件已损坏', 'BAD_PASSWORD'); }
    info.encrypted = true;
  }
  if (obj?.app === APP && obj.schema === 2) {
    if (typeof obj.checksum !== 'string' || await sha256(JSON.stringify(obj.data)) !== obj.checksum)
      throw new Error('校验失败：文件已被修改或损坏，未导入');
    info.exportedAt = typeof obj.exportedAt === 'string' ? obj.exportedAt.slice(0, 40) : '';
    return { data: validateData(obj.data), info };
  }
  if (Array.isArray(obj?.bills) && Array.isArray(obj?.categories)) {
    const { data, dropped } = fromLegacy(obj);
    info.legacy = true; info.dropped = dropped;
    info.exportedAt = typeof obj.exportTime === 'string' ? obj.exportTime.slice(0, 40) : '';
    return { data: validateData(data), info };
  }
  throw new Error('无法识别的备份文件');
}

// ---------- 快照 ----------
export async function takeSnapshot(reason, auto = true) {
  const data = await db.readAll();
  const snap = { id: uid(), time: Date.now(), reason, auto, counts: countsOf(data), checksum: await sha256(JSON.stringify(data)), data };
  await db.put('snapshots', snap);
  if (auto) {
    const all = (await db.getAll('snapshots')).filter(s => s.auto).sort((a, b) => b.time - a.time);
    for (const s of all.slice(MAX_AUTO_SNAPSHOTS)) await db.del('snapshots', s.id);
  }
  return snap;
}

export async function dailySnapshot() {
  const today = ymd(new Date());
  if ((await db.getMeta('lastAutoSnap')) === today) return false;
  if (await db.count('bills')) await takeSnapshot('每日自动快照');
  await db.setMeta('lastAutoSnap', today);
  return true;
}

export async function restoreSnapshot(id) {
  const s = await db.get('snapshots', id);
  if (!s) throw new Error('快照不存在');
  if (await sha256(JSON.stringify(s.data)) !== s.checksum) throw new Error('快照校验失败，数据已损坏，未恢复');
  const data = validateData(s.data);
  await takeSnapshot('恢复前自动备份');
  await db.replaceAll(data);
}
