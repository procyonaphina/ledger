// IndexedDB 数据层：所有记录使用唯一 id 作为主键，不再依赖数组下标
const NAME = 'pocket-ledger', VERSION = 2;
const KEYS = {
  bills: 'id', trash: 'id', accounts: 'id', categories: 'id', budgets: 'key',
  templates: 'id', recurring: 'id', notes: 'id', snapshots: 'id', meta: 'key',
};
/** 属于“用户数据”的仓库（备份/快照/恢复的范围） */
export const DATA_STORES = ['bills', 'accounts', 'categories', 'budgets', 'templates', 'recurring', 'notes'];
export const bus = new EventTarget(); // 每次写入成功后触发 'saved'

let dbp;
export function open() {
  return (dbp ??= new Promise((ok, no) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const [n, kp] of Object.entries(KEYS)) {
        if (db.objectStoreNames.contains(n)) continue;
        const s = db.createObjectStore(n, { keyPath: kp });
        if (n === 'bills') s.createIndex('time', 'time');
      }
    };
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); ok(r.result); };
    r.onerror = () => { dbp = null; no(r.error); };
    r.onblocked = () => no(new Error('数据库被其他窗口占用，请关闭其他记账窗口后重试'));
  }));
}

const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

export async function getAll(s) { const db = await open(); return req(db.transaction(s).objectStore(s).getAll()); }
export async function get(s, k) { const db = await open(); return req(db.transaction(s).objectStore(s).get(k)); }
export async function count(s) { const db = await open(); return req(db.transaction(s).objectStore(s).count()); }

/** 读取全部用户数据（单个只读事务，保证各仓库一致） */
export async function readAll() {
  const db = await open();
  const t = db.transaction(DATA_STORES);
  const res = await Promise.all(DATA_STORES.map(s => req(t.objectStore(s).getAll())));
  return Object.fromEntries(DATA_STORES.map((s, i) => [s, res[i]]));
}

/** 读写事务：fn 必须同步发出请求；整体成功或整体回滚 */
export function tx(names, fn) {
  return open().then(db => new Promise((ok, no) => {
    const t = db.transaction(names, 'readwrite');
    let out;
    try { out = fn(...names.map(n => t.objectStore(n))); }
    catch (e) { try { t.abort(); } catch {} return no(e); }
    t.oncomplete = () => { bus.dispatchEvent(new Event('saved')); ok(out); };
    t.onerror = () => no(t.error);
    t.onabort = () => no(t.error || new Error('写入被中止'));
  }));
}

export const put = (s, r) => tx([s], st => { st.put(r); });
export const putMany = (s, rs) => tx([s], st => { rs.forEach(r => st.put(r)); });
export const del = (s, k) => tx([s], st => { st.delete(k); });
export const clearStore = s => tx([s], st => { st.clear(); });

export const replaceAll = data => tx(DATA_STORES, (...ss) => {
  ss.forEach((st, i) => { st.clear(); data[DATA_STORES[i]].forEach(r => st.put(r)); });
});

export async function getMeta(k) { return (await get('meta', k))?.value; }
export const setMeta = (k, value) => put('meta', { key: k, value });

// ---------- 删除 / 撤销：先进回收站，30 天后清理 ----------
export const trashBills = ids => tx(['bills', 'trash'], (b, t) => {
  const now = Date.now();
  ids.forEach(id => {
    const r = b.get(id);
    r.onsuccess = () => { if (r.result) { t.put({ ...r.result, deletedAt: now }); b.delete(id); } };
  });
});

export const restoreBills = (ids, fix = x => x) => tx(['bills', 'trash'], (b, t) => {
  ids.forEach(id => {
    const r = t.get(id);
    r.onsuccess = () => {
      if (!r.result) return;
      const { deletedAt, ...rec } = r.result;
      b.put(fix(rec)); t.delete(id);
    };
  });
});

export const purgeTrash = maxAgeMs => tx(['trash'], t => {
  const r = t.openCursor();
  r.onsuccess = () => {
    const c = r.result; if (!c) return;
    if (Date.now() - c.value.deletedAt > maxAgeMs) c.delete();
    c.continue();
  };
});

/** 把某分类下的账单/回收站/模板/周期规则全部改到另一个分类（可顺便删除原分类及其预算），一个事务完成 */
export const remapCategory = (from, to, removeCat) =>
  tx(['bills', 'trash', 'templates', 'recurring', 'categories', 'budgets'], (b, t, tp, rc, ct, bd) => {
    for (const st of [b, t, tp, rc]) {
      const r = st.openCursor();
      r.onsuccess = () => {
        const c = r.result; if (!c) return;
        if (c.value.categoryId === from) c.update({ ...c.value, categoryId: to });
        c.continue();
      };
    }
    if (removeCat) { ct.delete(from); bd.delete(from); }
  });