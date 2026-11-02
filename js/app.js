// 口袋记账 · 主程序（界面全部用 h() 构建，不使用 innerHTML）
import * as db from './db.js';
import * as bk from './backup.js';
import { donut, cartesian, PALETTE } from './charts.js';
import {
  $, h, uid, debounce, parseMoney, fmt, centsToStr, MAX_CENTS, pad, ymd, monthOf, addMonth, monthLabel,
  daysIn, toLocalInput, fromLocalInput, validYmd, occurrence, csvCell, saveFile,
} from './util.js';

const VERSION = '2.0.1';
const ACC_TYPES = { cash: '现金', bank: '银行卡', alipay: '支付宝', wechat: '微信', credit: '信用卡', other: '其他' };
const FREQ = { daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' };
const TYPE_LABEL = { out: '支出', in: '收入', transfer: '转账' };
const WD = '日一二三四五六';
const DAY = 864e5;

const S = {
  bills: [], trash: [], accounts: [], categories: [], budgets: {}, templates: [], recurring: [],
  snapCount: 0, lastBackup: 0, persisted: false, savedAt: 0,
  view: 'home', month: monthOf(Date.now()), year: new Date().getFullYear(), statTab: 'month', statKind: 'out',
  filter: { type: 'all', cat: '', acc: '', q: '' }, limit: 100, selecting: false, picked: new Set(),
  accMap: new Map(), catMap: new Map(),
};
let post = [];      // 渲染后需要绘制的图表
let refill = null;  // 账单页局部刷新函数
let lastView = '';

// =============== 数据加载 ===============
async function load() {
  const d = await db.readAll();
  S.bills = d.bills.sort((a, b) => b.time - a.time);
  S.accounts = d.accounts.sort((a, b) => a.created - b.created);
  S.categories = d.categories.sort((a, b) => a.o - b.o || a.name.localeCompare(b.name));
  S.budgets = Object.fromEntries(d.budgets.map(x => [x.key, x.cents]));
  S.templates = d.templates; S.recurring = d.recurring;
  S.trash = await db.getAll('trash');
  S.snapCount = await db.count('snapshots');
  S.lastBackup = (await db.getMeta('lastBackup')) || 0;
  S.accMap = new Map(S.accounts.map(a => [a.id, a]));
  S.catMap = new Map(S.categories.map(c => [c.id, c]));
}
async function refresh() { await load(); render(); }

// =============== 统计计算（金额均为整数分） ===============
const monthBills = m => S.bills.filter(b => monthOf(b.time) === m);
function sumBills(list) {
  let inc = 0, exp = 0; const byCat = {};
  for (const b of list) {
    if (b.type === 'in') inc += b.amount;
    else if (b.type === 'out') { exp += b.amount; byCat[b.categoryId] = (byCat[b.categoryId] || 0) + b.amount; }
  }
  return { inc, exp, bal: inc - exp, byCat };
}
function monthTotals() {
  const m = new Map();
  for (const b of S.bills) {
    if (b.type === 'transfer') continue;
    const k = monthOf(b.time); const t = m.get(k) || { inc: 0, exp: 0 };
    if (b.type === 'in') t.inc += b.amount; else t.exp += b.amount;
    m.set(k, t);
  }
  return m;
}
function balances() {
  const m = new Map(S.accounts.map(a => [a.id, a.initial]));
  const add = (id, v) => m.set(id, (m.get(id) || 0) + v);
  for (const b of S.bills) {
    if (b.type === 'in') add(b.accountId, b.amount);
    else if (b.type === 'out') add(b.accountId, -b.amount);
    else { add(b.accountId, -b.amount); add(b.toAccountId, b.amount); }
  }
  return m;
}
const catName = id => S.catMap.get(id)?.name || '未分类';
const accName = id => S.accMap.get(id)?.name || '已删除账户';

// =============== 通用 UI：提示、弹窗、表单 ===============
let toastTimer;
function toast(msg, { action, ms = 3000 } = {}) {
  const t = $('#toast');
  const kids = [h('span', { text: msg })];
  if (action) kids.push(h('button', { type: 'button', text: action.text, onclick: () => { t.hidden = true; action.run(); } }));
  t.replaceChildren(...kids);
  t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function mkDialog() { const d = h('dialog', { class: 'sheet' }); document.body.append(d); return d; }

/** 通用底部弹出面板（自定义内容） */
function sheet(title, build) {
  const dlg = mkDialog();
  const close = () => { try { dlg.close(); } catch {} dlg.remove(); };
  dlg.append(h('div', { class: 'sheet-h' }, h('b', { text: title }), h('button', { class: 'icon', type: 'button', 'aria-label': '关闭', text: '✕', onclick: close })), h('div', { class: 'sheet-body' }, build(close)));
  dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  dlg.showModal();
  return close;
}

/** 通用表单弹窗。fields: [{key,type,label,value,options,show,validate,required,max,...}]，取消返回 null */
function form(title, fields, opt = {}) {
  return new Promise(resolve => {
    const dlg = mkDialog(), vals = {}, ctl = {}, els = {}, wraps = [];
    let done = false;
    const finish = v => { if (done) return; done = true; try { dlg.close(); } catch {} dlg.remove(); resolve(v); };
    const err = h('div', { class: 'err', role: 'alert' });
    const say = (m, ok) => { err.textContent = m; err.classList.toggle('ok', !!ok); };
    const refreshF = () => { for (const [f, w, lab] of wraps) { w.hidden = f.show ? !f.show(vals) : false; if (f.labelFn && lab) lab.textContent = f.labelFn(vals); } };
    const change = k => { refreshF(); opt.onInput?.(vals, k); };
    const api = {
      close: finish, error: m => say(m, false), say,
      set(o) { for (const [k, v] of Object.entries(o)) { vals[k] = v; ctl[k]?.(v); } refreshF(); opt.onInput?.(vals); },
    };
    const body = h('div', { class: 'fields' });
    for (const f of fields) {
      vals[f.key] = f.value ?? (f.type === 'checkbox' ? false : '');
      if (f.type === 'info') { const p = h('p', { class: 'hint', text: f.text }); wraps.push([f, p, null]); body.append(p); continue; }
      const lab = h('span', { class: 'lab', text: f.labelFn ? f.labelFn(vals) : f.label || '' });
      let node;
      if (f.type === 'seg') {
        const paint = v => bs.forEach((b, i) => b.classList.toggle('on', f.options[i][0] === v));
        const bs = f.options.map(([v, t]) => h('button', { type: 'button', class: 'seg-b', text: t, onclick: () => { vals[f.key] = v; paint(v); change(f.key); } }));
        ctl[f.key] = paint; paint(vals[f.key]); node = h('div', { class: 'seg' }, bs);
      } else {
        const isSel = f.type === 'select', isChk = f.type === 'checkbox';
        const el = isSel
          ? h('select', {}, f.options.map(([v, t]) => h('option', { value: v, text: t })))
          : h('input', {
            type: { money: 'text', text: 'text', password: 'password', date: 'date', datetime: 'datetime-local', checkbox: 'checkbox' }[f.type] || 'text',
            inputmode: f.type === 'money' ? 'decimal' : null, maxlength: f.max, placeholder: f.placeholder,
            autocomplete: f.type === 'password' ? 'new-password' : 'off', enterkeyhint: 'done',
          });
        if (f.disabled) el.disabled = true;
        const write = v => { if (isChk) el.checked = !!v; else el.value = v; };
        write(vals[f.key]); ctl[f.key] = write; els[f.key] = el;
        const on = () => { vals[f.key] = isChk ? el.checked : el.value; change(f.key); };
        el.addEventListener('input', on); el.addEventListener('change', on);
        node = isChk ? h('label', { class: 'check' }, el, h('span', { text: f.label })) : [lab, el];
      }
      const w = h('div', { class: 'field' }, node); wraps.push([f, w, lab]); body.append(w);
    }
    const submit = () => {
      say('');
      for (const f of fields) {
        if (f.type === 'info' || (f.show && !f.show(vals))) continue;
        const v = vals[f.key], empty = typeof v === 'string' ? v.trim() === '' : v == null;
        if (f.required && empty) { say(`请填写${f.label || ''}`); return; }
        const m = f.validate?.(v, vals);
        if (m) { say(m); return; }
      }
      finish({ ...vals });
    };
    const foot = h('div', { class: 'foot' },
      (opt.actions || []).map(a => h('button', { type: 'button', class: 'btn' + (a.danger ? ' danger' : ''), text: a.text, onclick: () => a.run({ ...vals }, api) })),
      h('div', { class: 'foot-main' },
        opt.noCancel ? null : h('button', { type: 'button', class: 'btn', text: '取消', onclick: () => finish(null) }),
        h('button', { type: 'submit', class: 'btn pri' + (opt.danger ? ' danger' : ''), text: opt.ok || '保存' })));
    dlg.append(h('div', { class: 'sheet-h' }, h('b', { text: title })),
      h('form', { novalidate: true, class: 'sheet-body', onsubmit: e => { e.preventDefault(); submit(); } },
        opt.header?.(api), opt.message && h('p', { class: 'msg', text: opt.message }), body, err, foot));
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
    dlg.addEventListener('click', e => { if (e.target === dlg) finish(null); });
    refreshF(); dlg.showModal();
    if (opt.focus && els[opt.focus]) els[opt.focus].focus();
  });
}
const confirmBox = (msg, ok = '确定', danger = false) => form('请确认', [], { message: msg, ok, danger }).then(Boolean);
const notice = (title, msg) => form(title, [], { message: msg, ok: '知道了', noCancel: true });
const optMoney = v => { if (!v.trim()) return ''; const c = parseMoney(v); return c == null || c > MAX_CENTS ? '金额格式不对（最多两位小数）' : ''; };
const reqMoney = v => { const c = parseMoney(v); return c == null ? '金额格式不对（最多两位小数）' : c < 1 ? '金额必须大于 0' : c > MAX_CENTS ? '金额过大' : ''; };
const accOptions = (keep = []) => S.accounts.filter(a => !a.archived || keep.includes(a.id)).map(a => [a.id, a.name + (a.archived ? '（已停用）' : '')]);
const catOptions = () => S.categories.map(c => [c.id, c.name]);

// =============== 小组件 ===============
const dot = color => { const d = h('i', { class: 'dot' }); d.style.background = color; return d; };
const sel = (opts, val, fn) => { const s = h('select', { onchange: e => fn(e.target.value) }, opts.map(([v, t]) => h('option', { value: v, text: t }))); s.value = val; return s; };
const row = (t, sub, fn) => h('button', { type: 'button', class: 'rowbtn', onclick: fn }, h('span', { class: 'grow' }, h('b', { text: t }), sub ? h('small', { text: sub }) : null), h('span', { class: 'chev', text: '›' }));

function monthNav(key, setKey, label = monthLabel, step = addMonth) {
  return h('div', { class: 'mnav' },
    h('button', { type: 'button', class: 'icon', 'aria-label': '上一个', text: '‹', onclick: () => setKey(step(key, -1)) }),
    h('button', { type: 'button', class: 'mlabel', text: label(key), onclick: () => setKey(label === monthLabel ? monthOf(Date.now()) : String(new Date().getFullYear())) }),
    h('button', { type: 'button', class: 'icon', 'aria-label': '下一个', text: '›', onclick: () => setKey(step(key, 1)) }));
}
function bar(label, used, limit) {
  const over = used > limit, fill = h('div', { class: 'fill' + (over ? ' over' : '') });
  fill.style.width = Math.min(100, used / limit * 100) + '%';
  return h('div', { class: 'bar' }, h('div', { class: 'row' }, h('span', { text: label }), h('span', { class: over ? 'neg' : '', text: `${fmt(used)} / ${fmt(limit)}` })), h('div', { class: 'track' }, fill));
}
function billRow(b) {
  const sub = b.type === 'transfer' ? `${accName(b.accountId)} → ${accName(b.toAccountId)}` : accName(b.accountId);
  const d = new Date(b.time), picked = S.picked.has(b.id);
  const act = () => (S.selecting ? togglePick(b.id) : billForm(b));
  return h('div', { class: 'bill' + (picked ? ' picked' : ''), role: 'button', tabindex: 0, onclick: act, onkeydown: e => { if (e.key === 'Enter') act(); } },
    S.selecting ? h('span', { class: 'chk' + (picked ? ' on' : ''), text: picked ? '✓' : '' }) : null,
    h('div', { class: 'b-main' },
      h('div', { class: 'b-title' }, b.type === 'transfer' ? '转账' : catName(b.categoryId), b.note ? h('span', { class: 'b-note', text: ' · ' + b.note }) : null, b.recurringId ? h('span', { class: 'b-note', text: ' 🔁' }) : null),
      h('div', { class: 'b-sub', text: `${pad(d.getHours())}:${pad(d.getMinutes())} · ${sub}` })),
    h('div', { class: 'amt ' + b.type, text: (b.type === 'in' ? '+' : b.type === 'out' ? '-' : '') + fmt(b.amount) }));
}
function togglePick(id) { if (S.picked.has(id)) S.picked.delete(id); else S.picked.add(id); refill?.(); }

// =============== 视图：概览 ===============
function vHome() {
  const s = sumBills(monthBills(S.month));
  const net = [...balances().values()].reduce((a, b) => a + b, 0);
  const root = h('div', { class: 'page' }, monthNav(S.month, m => { S.month = m; render(); }));
  if (S.bills.length && (!S.lastBackup || Date.now() - S.lastBackup > 30 * DAY))
    root.append(h('div', { class: 'banner' }, h('span', { text: S.lastBackup ? `已超过 ${Math.floor((Date.now() - S.lastBackup) / DAY)} 天没有导出备份` : '还没有导出过备份' }), h('button', { type: 'button', class: 'btn sm', text: '去备份', onclick: exportDialog })));
  const stat = (t, v, c) => h('div', { class: 'stat ' + c }, h('small', { text: t }), h('b', { text: v }));
  root.append(h('div', { class: 'stats' }, stat('收入', fmt(s.inc), 'in'), stat('支出', fmt(s.exp), 'out'), stat('结余', fmt(s.bal), 'bal')));
  root.append(h('button', { type: 'button', class: 'card rowbtn', onclick: () => go('accounts') }, h('span', { class: 'grow' }, h('small', { text: '总资产' }), h('b', { class: 'big', text: fmt(net) })), h('span', { class: 'chev', text: '›' })));
  const total = S.budgets._total || 0;
  const bc = h('section', { class: 'card' }, h('h3', { text: '预算' }));
  if (total) bc.append(bar('本月总预算', s.exp, total));
  else bc.append(h('p', { class: 'hint', text: '还没设置总预算：更多 → 分类与预算' }));
  for (const c of S.categories) if (S.budgets[c.id]) bc.append(bar(c.name, s.byCat[c.id] || 0, S.budgets[c.id]));
  root.append(bc);
  const rc = h('section', { class: 'card' }, h('h3', { text: '最近账单' }));
  if (!S.bills.length) rc.append(h('p', { class: 'hint', text: '还没有账单，点右下角 ＋ 记第一笔' }));
  S.bills.slice(0, 5).forEach(b => rc.append(billRow(b)));
  if (S.bills.length) rc.append(h('button', { type: 'button', class: 'btn block', text: '查看全部账单', onclick: () => go('bills') }));
  root.append(rc);
  return root;
}

// =============== 视图：账单 ===============
function vBills() {
  const f = S.filter, root = h('div', { class: 'page' });
  root.append(monthNav(S.month, m => { S.month = m; S.limit = 100; S.picked.clear(); render(); }));
  const listBox = h('div'), batch = h('div', { class: 'batch' });
  const filtered = () => {
    const q = f.q.trim().toLowerCase();
    return monthBills(S.month).filter(b => (f.type === 'all' || b.type === f.type)
      && (!f.cat || b.categoryId === f.cat) && (!f.acc || b.accountId === f.acc || b.toAccountId === f.acc)
      && (!q || (b.note || '').toLowerCase().includes(q) || catName(b.categoryId).toLowerCase().includes(q)));
  };
  function fill() {
    const list = filtered(), shown = list.slice(0, S.limit), kids = [];
    let cur = '', daySum = 0, head = null;
    const closeDay = () => { if (head) head.lastChild.textContent = daySum ? `支出 ${fmt(daySum)}` : ''; };
    for (const b of shown) {
      const d = new Date(b.time), key = ymd(d);
      if (key !== cur) {
        closeDay(); cur = key; daySum = 0;
        head = h('div', { class: 'dayh' }, h('span', { text: `${d.getMonth() + 1}月${d.getDate()}日 周${WD[d.getDay()]}` }), h('span', { text: '' }));
        kids.push(head);
      }
      if (b.type === 'out') daySum += b.amount;
      kids.push(billRow(b));
    }
    closeDay();
    if (!list.length) kids.push(h('p', { class: 'hint center', text: '没有符合条件的账单' }));
    if (list.length > S.limit) kids.push(h('button', { type: 'button', class: 'btn block', text: `加载更多（还有 ${list.length - S.limit} 条）`, onclick: () => { S.limit += 100; fill(); } }));
    listBox.replaceChildren(...kids);
    batch.replaceChildren(...(S.selecting ? [
      h('button', { type: 'button', class: 'btn sm', text: '全选/取消', onclick: () => { const full = list.every(b => S.picked.has(b.id)); list.forEach(b => (full ? S.picked.delete(b.id) : S.picked.add(b.id))); fill(); } }),
      h('span', { class: 'hint grow', text: `已选 ${S.picked.size} 条` }),
      h('button', { type: 'button', class: 'btn sm danger', disabled: !S.picked.size, text: '删除', onclick: batchDelete }),
      h('button', { type: 'button', class: 'btn sm', text: '完成', onclick: () => { S.selecting = false; S.picked.clear(); fill(); } }),
    ] : [
      h('span', { class: 'hint grow', text: `共 ${list.length} 条` }),
      h('button', { type: 'button', class: 'btn sm', text: '多选', onclick: () => { S.selecting = true; fill(); } }),
    ]));
  }
  refill = fill;
  root.append(h('div', { class: 'filters' },
    sel([['all', '全部类型'], ['out', '支出'], ['in', '收入'], ['transfer', '转账']], f.type, v => { f.type = v; S.limit = 100; fill(); }),
    sel([['', '全部分类'], ...catOptions()], f.cat, v => { f.cat = v; S.limit = 100; fill(); }),
    sel([['', '全部账户'], ...S.accounts.map(a => [a.id, a.name])], f.acc, v => { f.acc = v; S.limit = 100; fill(); }),
    h('input', { type: 'search', placeholder: '搜索备注 / 分类', value: f.q, oninput: e => { f.q = e.target.value; S.limit = 100; fill(); } })));
  root.append(batch, listBox);
  fill();
  return root;
}
async function batchDelete() {
  const ids = [...S.picked];
  if (!ids.length) return;
  if (!await confirmBox(`删除选中的 ${ids.length} 条账单？删除后可在 8 秒内撤销，也可在回收站找回。`, '删除', true)) return;
  S.picked.clear(); S.selecting = false;
  await deleteBills(ids);
}
async function deleteBills(ids) {
  await db.trashBills(ids); await refresh();
  toast(`已删除 ${ids.length} 条`, { ms: 8000, action: { text: '撤销', run: () => undelete(ids) } });
}
async function undelete(ids) {
  await db.restoreBills(ids, r => (r.type === 'transfer' || S.catMap.has(r.categoryId) ? r : { ...r, categoryId: 'cat_other' }));
  await refresh(); toast('已恢复');
}

// =============== 记一笔 / 编辑 ===============
const saveDraft = debounce(v => db.setMeta('draft', { type: v.type, amount: v.amount, categoryId: v.categoryId, accountId: v.accountId, toAccountId: v.toAccountId, note: v.note }), 400);

async function billForm(b, preset = {}) {
  const isNew = !b;
  const accs = accOptions(b ? [b.accountId, b.toAccountId] : []);
  if (!accs.length) { toast('请先在「账户」里添加或启用一个账户'); return; }
  const draft = isNew ? await db.getMeta('draft') : null;
  const first = accs[0][0];
  let init = b
    ? { type: b.type, amount: centsToStr(b.amount), categoryId: b.categoryId || 'cat_other', accountId: b.accountId, toAccountId: b.toAccountId, time: toLocalInput(b.time), note: b.note }
    : { type: 'out', amount: '', categoryId: S.catMap.has('cat_food') ? 'cat_food' : S.categories[0]?.id, accountId: first, toAccountId: '', time: toLocalInput(Date.now()), note: '', ...(draft || {}), ...preset };
  if (!S.accMap.has(init.accountId)) init.accountId = first;
  if (!S.catMap.has(init.categoryId)) init.categoryId = 'cat_other';
  if (!S.accMap.has(init.toAccountId) || init.toAccountId === init.accountId) init.toAccountId = accs.find(([id]) => id !== init.accountId)?.[0] || '';
  if (init.type === 'transfer' && accs.length < 2) init.type = 'out';
  const restored = isNew && draft && (draft.amount || draft.note);
  const v = await form(isNew ? '记一笔' : '编辑账单', [
    { key: 'type', type: 'seg', value: init.type, options: [['out', '支出'], ['in', '收入'], ['transfer', '转账']] },
    { key: 'amount', type: 'money', label: '金额', value: init.amount, placeholder: '0.00', required: true, validate: reqMoney },
    { key: 'categoryId', type: 'select', label: '分类', value: init.categoryId, options: catOptions(), show: x => x.type !== 'transfer' },
    { key: 'accountId', type: 'select', label: '账户', labelFn: x => (x.type === 'transfer' ? '转出账户' : '账户'), value: init.accountId, options: accs },
    { key: 'toAccountId', type: 'select', label: '转入账户', value: init.toAccountId, options: accs, show: x => x.type === 'transfer', validate: (x, vv) => (!x ? '请选择转入账户' : x === vv.accountId ? '转入和转出账户不能相同' : '') },
    { key: 'time', type: 'datetime', label: '时间', value: init.time, required: true, validate: x => (fromLocalInput(x) == null ? '时间格式不对' : '') },
    { key: 'note', type: 'text', label: '备注（可选）', value: init.note, max: 200 },
  ], {
    ok: '保存', focus: isNew ? 'amount' : null,
    message: restored ? '已恢复上次没保存完的草稿' : null,
    onInput: isNew ? saveDraft : null,
    header: api => (isNew && S.templates.length ? h('div', { class: 'chips' }, S.templates.map(t => h('button', {
      type: 'button', class: 'chip', text: `${t.name} ${fmt(t.amount)}`,
      onclick: () => api.set({ type: t.type, amount: centsToStr(t.amount), categoryId: S.catMap.has(t.categoryId) ? t.categoryId : init.categoryId, accountId: S.accMap.has(t.accountId) ? t.accountId : init.accountId, note: t.note || '' }),
    }))) : null),
    actions: isNew
      ? [{
        text: '存为模板', run: async (vals, api) => {
          const c = parseMoney(vals.amount);
          if (vals.type === 'transfer' || c == null || c < 1) { api.error('模板需要有效金额，且不支持转账'); return; }
          const r = await form('模板名称', [{ key: 'name', type: 'text', label: '名称', value: catName(vals.categoryId), required: true, max: 20 }]);
          if (!r) return;
          await db.put('templates', { id: uid(), name: r.name.trim(), type: vals.type, amount: c, categoryId: vals.categoryId, accountId: vals.accountId, note: vals.note.trim().slice(0, 200) });
          await load(); api.say('已存为模板 ✓', true);
        },
      }]
      : [{ text: '删除', danger: true, run: async (vals, api) => { api.close(null); await deleteBills([b.id]); } }],
  });
  if (!v) return;
  const rec = {
    id: b?.id || uid(), type: v.type, amount: parseMoney(v.amount),
    categoryId: v.type === 'transfer' ? '' : v.categoryId, accountId: v.accountId,
    toAccountId: v.type === 'transfer' ? v.toAccountId : '', note: v.note.trim().slice(0, 200), time: fromLocalInput(v.time),
  };
  if (b?.recurringId) rec.recurringId = b.recurringId;
  await db.put('bills', rec);
  if (isNew) { saveDraft.cancel?.(); await db.del('meta', 'draft'); }
  await refresh(); toast(isNew ? '已保存' : '已更新');
}

// =============== 视图：统计 ===============
function vStats() {
  const root = h('div', { class: 'page' });
  root.append(h('div', { class: 'seg big' }, [['month', '月度'], ['trend', '趋势'], ['year', '年度']].map(([v, t]) =>
    h('button', { type: 'button', class: 'seg-b' + (S.statTab === v ? ' on' : ''), text: t, onclick: () => { S.statTab = v; render(); } }))));
  ({ month: statMonth, trend: statTrend, year: statYear })[S.statTab](root);
  return root;
}
const legend = items => h('div', { class: 'legend' }, items);
function ranking(byCat, total) {
  const items = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([id, v], i) => ({ label: catName(id), value: v, color: PALETTE[i % PALETTE.length] }));
  return { items, total, rows: items.map(it => h('div', { class: 'lg' }, dot(it.color), h('span', { class: 'grow', text: it.label }), h('span', { text: fmt(it.value) }), h('span', { class: 'hint pct', text: total ? (it.value / total * 100).toFixed(1) + '%' : '' }))) };
}
function statMonth(root) {
  root.append(monthNav(S.month, m => { S.month = m; render(); }));
  root.append(h('div', { class: 'seg' }, [['out', '支出'], ['in', '收入']].map(([v, t]) => h('button', { type: 'button', class: 'seg-b' + (S.statKind === v ? ' on' : ''), text: t, onclick: () => { S.statKind = v; render(); } }))));
  const by = {}; let total = 0;
  monthBills(S.month).filter(b => b.type === S.statKind).forEach(b => { by[b.categoryId] = (by[b.categoryId] || 0) + b.amount; total += b.amount; });
  const r = ranking(by, total), cv = h('canvas', { class: 'chart sq' });
  post.push(() => donut(cv, r.items, { title: S.statKind === 'out' ? '支出' : '收入', total: fmt(total) }));
  root.append(h('section', { class: 'card' }, cv, legend(r.rows)));
}
function statTrend(root) {
  root.append(monthNav(S.month, m => { S.month = m; render(); }));
  const tot = monthTotals(), months = Array.from({ length: 12 }, (_, i) => addMonth(S.month, i - 11));
  const inc = months.map(m => tot.get(m)?.inc || 0), exp = months.map(m => tot.get(m)?.exp || 0);
  const cv1 = h('canvas', { class: 'chart' });
  post.push(() => cartesian(cv1, months.map(m => +m.slice(5) + '月'), [{ color: '#10b981', values: inc }, { color: '#ef4444', values: exp }], 'line'));
  root.append(h('section', { class: 'card' }, h('h3', { text: '近 12 个月收支' }), cv1,
    h('div', { class: 'legend row' }, h('span', {}, dot('#10b981'), ' 收入'), h('span', {}, dot('#ef4444'), ' 支出'))));
  const n = daysIn(S.month), days = Array(n).fill(0);
  monthBills(S.month).filter(b => b.type === 'out').forEach(b => { days[new Date(b.time).getDate() - 1] += b.amount; });
  const sum = days.reduce((a, b) => a + b, 0), elapsed = S.month === monthOf(Date.now()) ? new Date().getDate() : n;
  const maxD = Math.max(...days), cv2 = h('canvas', { class: 'chart' });
  post.push(() => cartesian(cv2, days.map((_, i) => String(i + 1)), [{ color: '#ef4444', values: days }], 'bars'));
  root.append(h('section', { class: 'card' }, h('h3', { text: '本月每日支出' }), cv2,
    h('div', { class: 'srow2' }, h('span', { text: `日均 ${fmt(Math.round(sum / elapsed))}` }), h('span', { text: maxD ? `单日最高 ${fmt(maxD)}（${days.indexOf(maxD) + 1} 日）` : '' }))));
}
function statYear(root) {
  const y = S.year;
  root.append(monthNav(String(y), k => { S.year = +k; render(); }, k => `${k}年`, (k, d) => String(+k + d)));
  const tot = monthTotals(), rows = Array.from({ length: 12 }, (_, i) => ({ m: i + 1, ...(tot.get(`${y}-${pad(i + 1)}`) || { inc: 0, exp: 0 }) }));
  const inc = rows.reduce((a, r) => a + r.inc, 0), exp = rows.reduce((a, r) => a + r.exp, 0);
  const span = y === new Date().getFullYear() ? new Date().getMonth() + 1 : 12;
  const top = rows.reduce((a, r) => (r.exp > a.exp ? r : a), rows[0]);
  const stat = (t, v, c) => h('div', { class: 'stat ' + c }, h('small', { text: t }), h('b', { text: v }));
  root.append(h('div', { class: 'stats' }, stat('年收入', fmt(inc), 'in'), stat('年支出', fmt(exp), 'out'), stat('年结余', fmt(inc - exp), 'bal')));
  const cv = h('canvas', { class: 'chart' });
  post.push(() => cartesian(cv, rows.map(r => String(r.m)), [{ color: '#10b981', values: rows.map(r => r.inc) }, { color: '#ef4444', values: rows.map(r => r.exp) }], 'bars'));
  root.append(h('section', { class: 'card' }, h('h3', { text: '各月收支' }), cv,
    h('div', { class: 'srow2' }, h('span', { text: `月均支出 ${fmt(Math.round(exp / span))}` }), h('span', { text: top.exp ? `支出最高 ${top.m} 月 ${fmt(top.exp)}` : '' }))));
  const by = {}; S.bills.filter(b => b.type === 'out' && new Date(b.time).getFullYear() === y).forEach(b => { by[b.categoryId] = (by[b.categoryId] || 0) + b.amount; });
  const r = ranking(by, exp), cv2 = h('canvas', { class: 'chart sq' });
  post.push(() => donut(cv2, r.items, { title: '年支出', total: fmt(exp) }));
  root.append(h('section', { class: 'card' }, h('h3', { text: '年度支出构成' }), cv2, legend(r.rows)));
  root.append(h('section', { class: 'card' }, h('h3', { text: '月度明细' }),
    h('div', { class: 'tbl head' }, h('span', { text: '月' }), h('span', { text: '收入' }), h('span', { text: '支出' }), h('span', { text: '结余' })),
    rows.map(r => h('div', { class: 'tbl' }, h('span', { text: r.m + '月' }), h('span', { text: fmt(r.inc) }), h('span', { text: fmt(r.exp) }), h('span', { class: r.inc - r.exp < 0 ? 'neg' : '', text: fmt(r.inc - r.exp) })))));
}

// =============== 视图：账户 ===============
function vAccounts() {
  const bal = balances(), net = [...bal.values()].reduce((a, b) => a + b, 0);
  const root = h('div', { class: 'page' },
    h('section', { class: 'card' }, h('small', { class: 'hint', text: '净资产（含信用卡负债）' }), h('b', { class: 'big' + (net < 0 ? ' neg' : ''), text: fmt(net) })));
  const card = h('section', { class: 'card' }, h('h3', { text: '我的账户' }));
  S.accounts.forEach(a => {
    const v = bal.get(a.id) || 0;
    card.append(h('button', { type: 'button', class: 'rowbtn' + (a.archived ? ' dim' : ''), onclick: () => accountForm(a) },
      h('span', { class: 'grow' }, h('b', { text: a.name }), h('small', { text: ACC_TYPES[a.type] + (a.archived ? ' · 已停用' : '') })),
      h('b', { class: v < 0 ? 'neg' : '', text: fmt(v) }), h('span', { class: 'chev', text: '›' })));
  });
  root.append(card, h('div', { class: 'two' },
    h('button', { type: 'button', class: 'btn pri', text: '＋ 新增账户', onclick: () => accountForm(null) }),
    h('button', { type: 'button', class: 'btn', text: '⇄ 账户转账', onclick: () => billForm(null, { type: 'transfer' }) })));
  return root;
}
async function accountForm(a) {
  const isNew = !a;
  const v = await form(isNew ? '新增账户' : '编辑账户', [
    { key: 'name', type: 'text', label: '名称', value: a?.name, required: true, max: 30, placeholder: '如：招商银行卡' },
    { key: 'type', type: 'select', label: '类型', value: a?.type || 'cash', options: Object.entries(ACC_TYPES) },
    { key: 'initial', type: 'money', label: '期初余额（信用卡欠款填负数）', value: a ? centsToStr(a.initial) : '0.00', validate: x => (!x.trim() || parseMoney(x, { signed: true }) != null ? '' : '金额格式不对') },
    { key: 'archived', type: 'checkbox', label: '停用（不再出现在记账选项里，历史账单保留）', value: !!a?.archived },
  ], {
    actions: isNew ? [] : [{
      text: '删除', danger: true, run: async (vals, api) => {
        const used = S.bills.some(b => b.accountId === a.id || b.toAccountId === a.id) || S.trash.some(b => b.accountId === a.id || b.toAccountId === a.id)
          || S.recurring.some(r => r.accountId === a.id) || S.templates.some(t => t.accountId === a.id);
        if (used) { api.error('该账户已有账单或规则，不能删除，可以改为「停用」'); return; }
        if (S.accounts.length < 2) { api.error('至少要保留一个账户'); return; }
        if (!await confirmBox(`删除账户「${a.name}」？`, '删除', true)) return;
        await db.del('accounts', a.id); api.close(null); await refresh();
      },
    }],
  });
  if (!v) return;
  await db.put('accounts', { id: a?.id || uid(), name: v.name.trim(), type: v.type, initial: v.initial.trim() ? parseMoney(v.initial, { signed: true }) : 0, archived: !!v.archived, created: a?.created || Date.now() });
  await refresh();
}

// =============== 视图：更多 ===============
function vMore() {
  const root = h('div', { class: 'page' });
  const sec = (t, ...kids) => root.append(h('section', { class: 'card' }, h('h3', { text: t }), ...kids));
  const total = S.budgets._total;
  sec('分类与预算',
    row('月度总预算', total ? fmt(total) : '未设置', totalBudgetForm),
    S.categories.map(c => row(c.name, S.budgets[c.id] ? '预算 ' + fmt(S.budgets[c.id]) : '', () => catForm(c))),
    row('＋ 新增分类', '', () => catForm(null)));
  sec('周期账单',
    S.recurring.map(r => row(`${r.type === 'in' ? '+' : '-'}${fmt(r.amount)} · ${catName(r.categoryId)}`, `${FREQ[r.freq]} · 从 ${r.start}${r.end ? ' 到 ' + r.end : ''}${r.active ? '' : ' · 已暂停'}`, () => recurringForm(r))),
    row('＋ 新增周期账单', '工资、房租、订阅等，打开应用时自动入账', () => recurringForm(null)));
  sec('快捷模板',
    S.templates.map(t => row(t.name, `${TYPE_LABEL[t.type]} ${fmt(t.amount)}`, () => templateForm(t))),
    h('p', { class: 'hint', text: '在「记一笔」里填好后点「存为模板」即可添加。' }));
  sec('数据与安全',
    h('p', { class: 'hint', text: '所有改动实时写入本机数据库，无需手动保存；每天首次打开会自动创建快照。' }),
    row('导出备份', '含校验码，可加密', exportDialog),
    row('导入备份', '支持加密备份和旧版备份', importFlow),
    row('导出 CSV', '当月明细 / 全部明细 / 分类汇总 / 年度汇总', csvSheet),
    row('历史快照', `${S.snapCount} 个 · 导入、恢复前也会自动创建`, snapshotsSheet),
    row('回收站', `${S.trash.length} 条 · 保留 30 天`, trashSheet),
    row('持久存储', S.persisted ? '已启用' : '未启用，点击申请（防止系统清理）', askPersist),
    row('清空全部数据', '会先创建快照', clearAll));
  sec('关于', row('添加到 iPhone 主屏幕', '像 App 一样离线使用', installSheet),
    h('p', { class: 'hint', text: `口袋记账 v${VERSION} · ${navigator.onLine ? '在线' : '离线'}` }),
    h('p', { class: 'hint', text: '免责声明：本软件免费提供，按现状使用，不保证没有错误。所有数据只保存在你自己的设备上，开发者无法查看，也无法找回。清除浏览器数据、更换或损坏设备都可能导致数据丢失，请定期导出备份；因数据丢失或软件错误造成的损失，由使用者自行承担。' }));
  return root;
}
async function totalBudgetForm() {
  const v = await form('月度总预算', [{ key: 'b', type: 'money', label: '金额（留空表示不设置）', value: S.budgets._total ? centsToStr(S.budgets._total) : '', validate: optMoney }]);
  if (!v) return;
  const c = v.b.trim() ? parseMoney(v.b) : 0;
  if (c) await db.put('budgets', { key: '_total', cents: c }); else await db.del('budgets', '_total');
  await refresh();
}
async function catForm(c) {
  const isNew = !c;
  const v = await form(isNew ? '新增分类' : '编辑分类', [
    { key: 'name', type: 'text', label: '名称', value: c?.name, required: true, max: 30 },
    { key: 'budget', type: 'money', label: '月度预算（可选）', value: c && S.budgets[c.id] ? centsToStr(S.budgets[c.id]) : '', placeholder: '不设置请留空', validate: optMoney },
  ], {
    actions: isNew ? [] : [
      { text: '合并到…', run: async (vals, api) => { api.close(null); await mergeDialog(c); } },
      ...(c.id !== 'cat_other' ? [{
        text: '删除', danger: true, run: async (vals, api) => {
          if (!await confirmBox(`删除「${c.name}」？该分类下的账单会归入「其他」。`, '删除', true)) return;
          await bk.takeSnapshot('删除分类前'); await db.remapCategory(c.id, 'cat_other', true); api.close(null); await refresh();
        },
      }] : []),
    ],
  });
  if (!v) return;
  const id = c?.id || uid(), cents = v.budget.trim() ? parseMoney(v.budget) : 0;
  await db.tx(['categories', 'budgets'], (ct, bd) => {
    ct.put({ id, name: v.name.trim(), o: c?.o ?? Date.now() });
    if (cents) bd.put({ key: id, cents }); else bd.delete(id);
  });
  await refresh();
}
async function mergeDialog(c) {
  const others = S.categories.filter(x => x.id !== c.id);
  if (!others.length) return;
  const v = await form(`合并「${c.name}」`, [{ key: 'to', type: 'select', label: '合并到', options: others.map(x => [x.id, x.name]), value: others[0].id }],
    { message: '该分类的账单、模板、周期规则都会归入目标分类，然后删除本分类。', ok: '合并', danger: true });
  if (!v) return;
  if (c.id === 'cat_other') { await notice('不能合并', '「其他」是兜底分类，不能被合并掉。'); return; }
  await bk.takeSnapshot('合并分类前'); await db.remapCategory(c.id, v.to, true); await refresh(); toast('已合并');
}
async function templateForm(t) {
  const v = await form('编辑模板', [{ key: 'name', type: 'text', label: '名称', value: t.name, required: true, max: 20 }],
    { actions: [{ text: '删除', danger: true, run: async (vals, api) => { await db.del('templates', t.id); api.close(null); await refresh(); } }] });
  if (!v) return;
  await db.put('templates', { ...t, name: v.name.trim() }); await refresh();
}
async function recurringForm(r) {
  const isNew = !r, locked = !!r && r.n > 0, today = ymd(new Date());
  const accs = accOptions(r ? [r.accountId] : []);
  if (!accs.length) { toast('请先添加账户'); return; }
  const v = await form(isNew ? '新增周期账单' : '编辑周期账单', [
    { key: 'type', type: 'seg', value: r?.type || 'out', options: [['out', '支出'], ['in', '收入']] },
    { key: 'amount', type: 'money', label: '金额', value: r ? centsToStr(r.amount) : '', required: true, validate: reqMoney },
    { key: 'categoryId', type: 'select', label: '分类', value: r?.categoryId || 'cat_other', options: catOptions() },
    { key: 'accountId', type: 'select', label: '账户', value: r?.accountId || accs[0][0], options: accs },
    { key: 'freq', type: 'select', label: '频率', value: r?.freq || 'monthly', options: Object.entries(FREQ), disabled: locked },
    { key: 'start', type: 'date', label: '开始日期', value: r?.start || today, required: true, disabled: locked, validate: x => (validYmd(x) ? '' : '日期不正确') },
    { key: 'end', type: 'date', label: '结束日期（可选）', value: r?.end || '', validate: (x, vv) => (x && !validYmd(x) ? '日期不正确' : x && x < vv.start ? '结束日期不能早于开始日期' : '') },
    { key: 'note', type: 'text', label: '备注（可选）', value: r?.note || '', max: 200 },
    { key: 'active', type: 'checkbox', label: '启用', value: r ? r.active : true },
    ...(locked ? [{ key: 'i', type: 'info', text: '已生成过账单的规则不能改开始日期和频率；需要调整请暂停本规则并新建一条。' }] : []),
  ], {
    message: isNew ? '开始日期早于今天会自动补记；月底日期遇到短月自动取当月最后一天。' : null,
    actions: isNew ? [] : [{ text: '删除规则', danger: true, run: async (vals, api) => { if (!await confirmBox('删除这条规则？已生成的账单不受影响。', '删除', true)) return; await db.del('recurring', r.id); api.close(null); await refresh(); } }],
  });
  if (!v) return;
  await db.put('recurring', {
    id: r?.id || uid(), type: v.type, amount: parseMoney(v.amount), categoryId: v.categoryId, accountId: v.accountId,
    note: v.note.trim().slice(0, 200), freq: v.freq, start: v.start, end: v.end || '', n: r?.n || 0, active: !!v.active,
  });
  await load(); await runRecurring(); await refresh();
}

// =============== 周期账单自动入账 ===============
async function runRecurring() {
  const now = new Date(), end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
  const newBills = [], rules = [];
  for (const r of S.recurring) {
    if (!r.active) continue;
    let n = r.n, cnt = 0;
    while (cnt < 5000) {
      const d = occurrence(r.start, r.freq, n);
      if (d.getTime() > end || (r.end && ymd(d) > r.end)) break;
      newBills.push({ id: `rec:${r.id}:${n}`, type: r.type, amount: r.amount, categoryId: r.categoryId, accountId: r.accountId, toAccountId: '', note: r.note, time: d.getTime(), recurringId: r.id });
      n++; cnt++;
    }
    if (cnt) rules.push({ ...r, n });
  }
  if (!newBills.length) return 0;
  await db.tx(['bills', 'recurring'], (b, rc) => { newBills.forEach(x => b.put(x)); rules.forEach(x => rc.put(x)); });
  await load();
  toast(`已自动入账 ${newBills.length} 笔周期账单`, { ms: 4000 });
  return newBills.length;
}

// =============== 导出 / 导入 / 快照 / 回收站 ===============
async function exportDialog() {
  const secure = !!globalThis.crypto?.subtle;
  const v = await form('导出备份', [
    { key: 'enc', type: 'checkbox', label: '加密导出（推荐）', value: secure },
    { key: 'pw', type: 'password', label: '密码（至少 8 位）', show: x => x.enc, validate: (x, vv) => (vv.enc && x.length < 8 ? '密码至少 8 位' : '') },
    { key: 'pw2', type: 'password', label: '再输一次密码', show: x => x.enc, validate: (x, vv) => (vv.enc && x !== vv.pw ? '两次密码不一致' : '') },
    { key: 'i', type: 'info', text: '加密使用 AES-256-GCM，密码忘记后无法找回。备份文件含校验码，导入时会检测是否被改动或损坏。' },
  ], { ok: '导出' });
  if (!v) return;
  try {
    if (v.enc && !secure) throw new Error('当前环境不支持加密（需要 HTTPS 访问）');
    if (v.enc) toast('正在加密…', { ms: 20000 });
    const data = await db.readAll();
    const text = v.enc ? JSON.stringify(await bk.makeEncrypted(data, v.pw)) : JSON.stringify(await bk.makeBackup(data), null, 1);
    $('#toast').hidden = true;
    const saved = await saveFile(text, `ledger-backup-${ymd(new Date())}${v.enc ? '-encrypted' : ''}.json`, 'application/json');
    if (saved) { await db.setMeta('lastBackup', Date.now()); await refresh(); toast('备份已导出'); }
  } catch (e) { await notice('导出失败', e.message); }
}

function pickFile(accept) {
  return new Promise(res => { const i = h('input', { type: 'file', accept }); i.onchange = () => res(i.files[0] || null); i.addEventListener('cancel', () => res(null)); i.click(); });
}
async function importFlow() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  if (file.size > bk.MAX_FILE) { await notice('无法导入', '文件超过 30MB，不像是记账备份。'); return; }
  const text = await file.text();
  let res, pw, msg = '这是加密备份，请输入导出时设置的密码。';
  for (;;) {
    try { res = await bk.parseBackup(text, pw); break; }
    catch (e) {
      if (e.code === 'NEED_PASSWORD' || e.code === 'BAD_PASSWORD') {
        const r = await form('输入密码', [{ key: 'pw', type: 'password', label: '密码', required: true }], { message: e.code === 'BAD_PASSWORD' ? e.message + '，请重试。' : msg, ok: '解密' });
        if (!r) return; pw = r.pw; continue;
      }
      await notice('导入失败', e.message); return;
    }
  }
  const { data, info } = res, c = bk.countsOf(data);
  const ok = await confirmBox([
    info.legacy ? '格式：旧版备份（无校验码）' : '格式：新版备份，校验通过' + (info.encrypted ? '，已解密' : ''),
    info.exportedAt ? `导出时间：${info.exportedAt}` : null,
    `内容：${c.bills} 笔账单 · ${c.accounts} 个账户 · ${c.categories} 个分类 · ${c.recurring} 条周期规则`,
    info.dropped ? `已跳过 ${info.dropped} 条无效记录` : null,
    '', '将覆盖当前全部数据；导入前会自动创建快照，可随时恢复。',
  ].filter(x => x != null).join('\n'), '覆盖导入', true);
  if (!ok) return;
  try { await bk.takeSnapshot('导入前自动备份'); await db.replaceAll(data); await db.clearStore('trash'); }
  catch (e) { await notice('导入失败', e.message); return; }
  S.picked.clear(); await refresh(); toast('导入成功');
}

const fmtTime = ms => { const d = new Date(ms); return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

async function snapshotsSheet() {
  const snaps = (await db.getAll('snapshots')).sort((a, b) => b.time - a.time);
  sheet('历史快照', close => h('div', { class: 'list' },
    h('p', { class: 'hint', text: '自动快照保留最近 20 个；手动快照不会被自动清理。恢复前会再自动创建一个快照。' }),
    h('button', { type: 'button', class: 'btn pri block', text: '现在创建快照', onclick: async () => { await bk.takeSnapshot('手动快照', false); close(); await refresh(); toast('快照已创建'); } }),
    snaps.length ? snaps.map(s => h('div', { class: 'srow' },
      h('div', { class: 'grow' }, h('b', { text: fmtTime(s.time) }), h('small', { text: `${s.reason} · ${s.counts.bills} 笔账单` })),
      h('button', { type: 'button', class: 'btn sm', text: '恢复', onclick: () => restoreSnap(s, close) }),
      h('button', { type: 'button', class: 'btn sm danger', text: '删除', onclick: async () => { await db.del('snapshots', s.id); close(); await refresh(); snapshotsSheet(); } })))
      : h('p', { class: 'hint center', text: '还没有快照' })));
}
async function restoreSnap(s, close) {
  if (!await confirmBox(`恢复到 ${fmtTime(s.time)} 的状态？当前数据会先自动备份成一个快照。`, '恢复', true)) return;
  try { await bk.restoreSnapshot(s.id); } catch (e) { await notice('恢复失败', e.message); return; }
  close(); await refresh(); toast('已恢复');
}

function trashSheet() {
  const items = S.trash.slice().sort((a, b) => b.deletedAt - a.deletedAt);
  sheet('回收站', close => h('div', { class: 'list' },
    items.length ? items.map(b => h('div', { class: 'srow' },
      h('div', { class: 'grow' }, h('b', { text: `${b.type === 'transfer' ? '转账' : catName(b.categoryId)} ${fmt(b.amount)}${b.note ? ' · ' + b.note : ''}` }), h('small', { text: `账单时间 ${fmtTime(b.time)}` })),
      h('button', { type: 'button', class: 'btn sm', text: '恢复', onclick: async () => { await undelete([b.id]); close(); trashSheet(); } })))
      : h('p', { class: 'hint center', text: '回收站是空的' }),
    items.length ? h('button', { type: 'button', class: 'btn danger block', text: '清空回收站', onclick: async () => { if (await confirmBox('永久删除回收站里的全部账单？', '清空', true)) { await db.clearStore('trash'); close(); await refresh(); } } }) : null));
}

async function clearAll() {
  const v = await form('清空全部数据', [{ key: 'w', type: 'text', label: '输入「清空」确认', validate: x => (x.trim() === '清空' ? '' : '请输入：清空') }],
    { message: '账单、账户、分类、预算、模板、周期规则都会被清除（会先创建快照，可在历史快照里恢复）。', ok: '清空', danger: true });
  if (!v) return;
  await bk.takeSnapshot('清空前自动备份', false);
  await db.replaceAll(bk.defaultData()); await db.clearStore('trash');
  await refresh(); toast('已清空');
}
async function askPersist() {
  try { S.persisted = (await navigator.storage?.persist?.()) || false; } catch {}
  render(); toast(S.persisted ? '已启用持久存储' : '系统暂未批准，请先添加到主屏幕再试');
}

function csvSheet() {
  const mk = async (kind) => {
    const head = ['日期', '类型', '分类', '账户', '转入账户', '金额', '备注'];
    const line = b => { const d = new Date(b.time); return [`${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`, TYPE_LABEL[b.type], b.type === 'transfer' ? '' : catName(b.categoryId), accName(b.accountId), b.type === 'transfer' ? accName(b.toAccountId) : '', centsToStr(b.amount), b.note || '']; };
    let rows, name;
    if (kind === 'month') { rows = [head, ...monthBills(S.month).reverse().map(line)]; name = `bills-${S.month}`; }
    else if (kind === 'all') { rows = [head, ...[...S.bills].reverse().map(line)]; name = `bills-all-${ymd(new Date())}`; }
    else if (kind === 'summary') {
      const s = sumBills(monthBills(S.month));
      rows = [['分类', '支出', '占比'], ...Object.entries(s.byCat).sort((a, b) => b[1] - a[1]).map(([id, v]) => [catName(id), centsToStr(v), (v / s.exp * 100).toFixed(2) + '%']), ['合计', centsToStr(s.exp), '100%']];
      name = `category-summary-${S.month}`;
    } else {
      const tot = monthTotals();
      rows = [['月份', '收入', '支出', '结余'], ...Array.from({ length: 12 }, (_, i) => { const t = tot.get(`${S.year}-${pad(i + 1)}`) || { inc: 0, exp: 0 }; return [`${S.year}-${pad(i + 1)}`, centsToStr(t.inc), centsToStr(t.exp), centsToStr(t.inc - t.exp)]; })];
      name = `year-${S.year}`;
    }
    await saveFile('﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), name + '.csv', 'text/csv');
  };
  sheet('导出 CSV', close => h('div', { class: 'list' },
    [['month', `当月明细（${monthLabel(S.month)}）`], ['all', '全部明细'], ['summary', `分类汇总（${monthLabel(S.month)}）`], ['year', `年度汇总（${S.year} 年）`]]
      .map(([k, t]) => h('button', { type: 'button', class: 'btn block', text: t, onclick: async () => { await mk(k); close(); } }))));
}

function installSheet() {
  sheet('添加到 iPhone 主屏幕', () => h('div', { class: 'list' },
    h('ol', { class: 'steps' },
      h('li', { text: '用 Safari 打开本页面（必须是 Safari）。' }),
      h('li', { text: '点底部的「分享」按钮。' }),
      h('li', { text: '选择「添加到主屏幕」，点「添加」。' }),
      h('li', { text: '以后从主屏幕图标打开，可全屏、离线使用。' })),
    h('p', { class: 'hint', text: '重要：主屏幕版和 Safari 网页版的数据是分开存的。换到主屏幕版后，请用「导出备份 → 导入备份」把旧数据搬过去。' })));
}

// =============== 渲染与启动 ===============
function render() {
  refill = null; post = [];
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === S.view));
  const y = window.scrollY, same = lastView === S.view;
  const node = ({ home: vHome, bills: vBills, stats: vStats, accounts: vAccounts, more: vMore })[S.view]();
  $('#view').replaceChildren(node);
  post.forEach(fn => fn());
  window.scrollTo(0, same ? y : 0); lastView = S.view;
}
function go(v) { S.view = v; S.selecting = false; S.picked.clear(); render(); }
function paintStatus() {
  const t = S.savedAt ? new Date(S.savedAt) : null;
  $('#status').textContent = (navigator.onLine ? '' : '离线 · ') + (t ? `已保存 ${pad(t.getHours())}:${pad(t.getMinutes())}` : '数据已就绪');
}

async function seed() {
  if (await db.getMeta('seeded')) return;
  let migrated = 0;
  if (!(await db.count('bills')) && !(await db.count('accounts'))) {
    let data = null;
    try {
      const ls = k => JSON.parse(localStorage.getItem(k) || 'null');
      const old = { bills: ls('acc_bills'), categories: ls('acc_categories'), budgets: ls('acc_budgets'), templates: ls('acc_templates') };
      if (Array.isArray(old.bills) && old.bills.length) {
        old.categories = old.categories || ['餐饮', '交通', '购物', '医疗', '学习', '工资', '其他'];
        data = bk.validateData(bk.fromLegacy(old).data); migrated = data.bills.length;
      }
    } catch { data = null; }
    await db.replaceAll(data || bk.defaultData());
  }
  await db.setMeta('seeded', true);
  if (migrated) setTimeout(() => toast(`已从旧版迁移 ${migrated} 笔账单`, { ms: 5000 }), 500);
}

async function init() {
  try { await db.open(); }
  catch (e) { $('#view').replaceChildren(h('div', { class: 'page' }, h('section', { class: 'card' }, h('h3', { text: '无法打开本地数据库' }), h('p', { class: 'hint', text: '可能是浏览器的隐私/无痕模式，或存储被禁用。请用正常模式的 Safari 打开。' + (e?.message ? `（${e.message}）` : '') })))); return; }
  await seed();
  await db.purgeTrash(30 * DAY);
  await bk.dailySnapshot();
  await load();
  await runRecurring();
  try { S.persisted = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; } catch {}

  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) go(b.dataset.v); });
  $('#fab').addEventListener('click', () => billForm(null));
  db.bus.addEventListener('saved', () => { S.savedAt = Date.now(); paintStatus(); bc?.postMessage(1); });
  addEventListener('online', paintStatus); addEventListener('offline', paintStatus);
  addEventListener('resize', debounce(() => { if (S.view === 'stats') render(); }, 150));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (S.view === 'stats') render(); });
  addEventListener('unhandledrejection', e => toast('出错了：' + (e.reason?.message || e.reason), { ms: 5000 }));
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    await bk.dailySnapshot(); await load(); await runRecurring(); render();
  });
  let bc = null;
  if ('BroadcastChannel' in globalThis) { bc = new BroadcastChannel('pocket-ledger'); bc.onmessage = debounce(() => { if (!document.querySelector('dialog[open]')) refresh(); }, 300); }
  paintStatus(); render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('新版本已就绪，下次打开自动生效', { ms: 5000 }); });
    })).catch(() => {});
  }
}
init();
