const API_URL = 'https://script.google.com/macros/s/AKfycbxE-zBMDGpxztaqZA0C94foLnE0olWSYlVMp777ga0IaFD_TKXWZhgJSpWPDlPHPdWF/exec';
const TYPES = ['支出', '收入', '轉帳'];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const PALETTE = ['#0d9488', '#f59e0b', '#3b82f6', '#ef4444', '#8b5cf6', '#ec4899',
  '#10b981', '#f97316', '#06b6d4', '#84cc16', '#a855f7', '#64748b', '#eab308'];

const $ = sel => document.querySelector(sel);

// localStorage 內容損壞時退回預設值，避免啟動即死白畫面
function safeParse(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || fallback); } catch (_) { return JSON.parse(fallback); }
}

let config = safeParse('mb_config', 'null');

const state = {
  view: 'add', // 冷啟動直接落在新增頁（輸入摩擦力優先；捷徑/Siri 流程也省掉一個 ➕）
  type: '支出',
  category: null,
  sub: null,
  account: '',
  from: '',
  to: '',
  toAmount: '',
  holding: null, // 轉帳模式的持倉異動 {ticker, side, shares}，送出時組「標的 股數股」進備註
  tags: new Set(),
  customTags: safeParse('mb_tags', '[]'),
  note: '',
  date: today(),
  expr: '',
  editingTs: null,
  lockedAccount: null,
  listDate: today(),
  accView: null,
  accTab: 'accounts', // 帳戶頁頂部 tab：accounts=帳戶總覽、holdings=持倉
  stats: {
    mode: 'month', // month / year / all（總覽：與期間無關的圖表，2026-07-19 取代很少用的自訂區間）
    month: today().slice(0, 7),
    year: Number(today().slice(0, 4)),
    chart: 'expense',
    tag: null,
    expanded: null,
    excluded: new Set(),   // '類型|分類'，session 內有效；作用於圓環/收支/月均（趨勢圖不套，避免看不見的過濾）
  },
};

// ---------- 前端快取（localStorage 持久化）----------

// 快取鍵只認 m: 月粒度；舊版遺留的 r: 區間鍵與裸日期鍵載入時直接丟掉（殘留會供過期資料）
const recordCache = new Map(Object.entries(safeParse('mb_cache', '{}')).filter(([k]) => k.startsWith('m:')));
let balancesCache = safeParse('mb_balances', 'null');
let writeSeq = 0; // 每次寫入 +1；批次撈取完成時發現變了就丟棄結果，避免舊資料蓋掉剛寫入的記錄

function persistCaches() {
  while (recordCache.size > 96) recordCache.delete(recordCache.keys().next().value);
  try {
    localStorage.setItem('mb_cache', JSON.stringify(Object.fromEntries(recordCache)));
  } catch (e) {
    // localStorage 超量：丟掉最久沒用的一半再試一次
    const keys = [...recordCache.keys()];
    keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => recordCache.delete(k));
    try { localStorage.setItem('mb_cache', JSON.stringify(Object.fromEntries(recordCache))); } catch (e2) {}
  }
  localStorage.setItem('mb_balances', JSON.stringify(balancesCache));
}

function invalidateCaches(date) {
  writeSeq++;
  allRecords = null;
  recordCache.delete(`m:${date.slice(0, 7)}`);
  balancesCache = null;
  persistCaches();
}

function clearAllCaches() {
  writeSeq++;
  allRecords = null;
  recordCache.clear();
  balancesCache = null;
  persistCaches();
}

// ---------- 寫入後就地修補快取（省掉整月重撈的 ~4 秒）----------

// getRecords 的回傳排序 = sheet 列序反轉（越晚寫入越前面），新記錄插到月陣列最前面同義
function cachePatchAdd(rec) {
  const key = `m:${rec.date.slice(0, 7)}`;
  if (recordCache.has(key)) recordCache.get(key).unshift(rec);
}

function cachePatchRemove(ts) {
  [...recordCache.keys()].filter(k => k.startsWith('m:')).forEach(k => {
    const arr = recordCache.get(k);
    const i = arr.findIndex(r => r.ts === ts);
    if (i >= 0) arr.splice(i, 1);
  });
}

// 每筆記錄對餘額的影響前端算得出來：轉出側 -金額、轉入側 +（入帳金額 or 金額），同 getBalances
function balancesPatch(rec, sign) {
  [[rec.from, -rec.amount], [rec.to, rec.toAmount || rec.amount]].forEach(([name, d]) => {
    if (!name || !balancesCache) return;
    const b = balancesCache.find(x => x.name === name);
    if (b) b.balance += d * sign;
    else balancesCache = null; // 快取建立後才新增的帳戶，就地修補不了，退回整包重撈
  });
}

// 新增/編輯/刪除成功後呼叫：m:/餘額就地修補（統計/帳戶明細都組裝自 m:，一併受惠）
function applyWrite(newRec, oldRec) {
  writeSeq++;
  allRecords = null;
  if (oldRec) {
    cachePatchRemove(oldRec.ts);
    balancesPatch(oldRec, -1);
  }
  if (newRec) {
    cachePatchAdd(newRec);
    balancesPatch(newRec, 1);
  }
  persistCaches();
}

// 把送出的 payload 補上後端回傳的 ts，組成與 getRecords 相同形狀的記錄物件
function recordFromPayload(p, ts) {
  return {
    date: p.date, type: p.type, category: p.category || '', sub: p.sub || '',
    amount: p.amount, currency: p.currency || 'TWD', from: p.from || '', to: p.to || '',
    tags: (p.tags || []).join(','), note: p.note || '', ts, toAmount: p.toAmount || 0,
  };
}

// 讀取時把鍵移到最後（LRU），超量淘汰才不會先踢掉天天在用的鍵
function cacheTouch(key) {
  const v = recordCache.get(key);
  recordCache.delete(key);
  recordCache.set(key, v);
  return v;
}

// ---------- 上次選擇記憶 ----------

const token = () => localStorage.getItem('mb_token') || '';
// 遮蔽模式（demo 給別人看）：只遮金額數字，fmtMoney/fmtShort 單一出口統一處理；寫入照常
let masked = localStorage.getItem('mb_mask') === '1';
const lastAccounts = () => safeParse('mb_last', '{}');

function rememberAccount(type, category, sub, account) {
  const m = lastAccounts();
  m[`${type}|${category}|${sub}`] = account;
  m[`${type}|${category}`] = account;
  localStorage.setItem('mb_last', JSON.stringify(m));
}

function saveCustomTags() {
  state.customTags = [...new Set(state.customTags)];
  localStorage.setItem('mb_tags', JSON.stringify(state.customTags));
}

const entryDefaults = () => safeParse('mb_entry', '{}');

function saveEntryDefaults() {
  const m = entryDefaults();
  m._type = state.type;
  if (state.type === '轉帳') m['轉帳'] = { from: state.from, to: state.to };
  else m[state.type] = { category: state.category, sub: state.sub, account: state.account };
  localStorage.setItem('mb_entry', JSON.stringify(m));
}

function restoreEntryDefaults(type) {
  const m = entryDefaults()[type] || {};
  if (type === '轉帳') {
    state.from = m.from || state.from;
    state.to = m.to || state.to;
  } else {
    state.category = m.category || null;
    state.sub = m.sub || null;
    state.account = m.account || '';
  }
}

state.type = entryDefaults()._type || '支出';
restoreEntryDefaults(state.type);

// 每次「新增」都從乾淨狀態開始：只保留各類型的預設類別/帳戶
function resetEntry() {
  state.expr = '';
  state.note = '';
  state.toAmount = '';
  state.holding = null;
  state.divTicker = null;
  state.tags.clear();
  state.editingTs = null;
  state.editingOld = null;
  state.date = today();
  restoreEntryDefaults(state.type);
}

// 點常用 chip：填入類型/分類/帳戶/金額，等使用者按 OK 送出（金額為 0 = 只填分類，保留已輸入的金額）
function fillQuick(q) {
  state.type = q.type;
  state.category = q.category;
  state.sub = q.sub;
  state.account = state.lockedAccount || defaultAccountFor(q.type, q.category, q.sub);
  if (q.amount) state.expr = String(q.amount);
  saveEntryDefaults();
  renderAdd();
}

// 捷徑 OCR/Siri 帶入：剪貼簿格式 MB|類型|金額|帳戶|日期|備註|分類|子分類（帳戶與後三欄選填）
// 帳戶走 lockedAccount（同帳戶明細 ✏️ FAB），接著選分類不會被該分類的預設帳戶蓋掉；
// 沒帶帳戶時吃分類的預設帳戶。分類組合對不上 config 只提示不中斷，其餘欄位照帶
async function pasteImport() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch (_) {}
  const p = String(text || '').trim().split('|');
  if (p[0] !== 'MB' || p.length < 5) return toast('剪貼簿沒有記帳資料', true);
  const [, type, amountStr, account, date, note = '', cat = '', sub = ''] = p;
  const amount = Number(String(amountStr).replace(/,/g, ''));
  if (type !== '支出' && type !== '收入') return toast(`無法辨識類型「${type}」`, true);
  if (!(amount > 0)) return toast(`無法辨識金額「${amountStr}」`, true);
  if (account && !config.accounts.some(a => a.name === account)) return toast(`帳戶「${account}」不存在`, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast(`無法辨識日期「${date}」`, true);
  state.type = type;
  restoreEntryDefaults(type);
  if (cat) {
    if (config.categories.some(c => c.type === type && c.category === cat && c.sub === sub)) {
      state.category = cat;
      state.sub = sub;
    } else {
      toast(`分類「${cat} - ${sub}」不存在，請自選`, true);
    }
  }
  state.expr = String(amount);
  state.account = account || defaultAccountFor(type, state.category, state.sub);
  state.lockedAccount = account || null;
  state.date = date;
  state.note = note;
  renderAdd();
}

// ---------- 小工具 ----------

// 使用者輸入（備註、標籤）進 innerHTML / 屬性前都要過這層，避免 < 或 " 弄壞版面
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// emoji 對照存「設定」分頁 O:P（分類/帳戶）與 R:S（子分類），隨 config 載入——名稱是個資，不寫死在 public repo
function emojiFor(name, kind) {
  const map = (config && config.emoji) || {};
  if (map[name]) return map[name];
  const s = String(name);
  if (s.includes('信用卡')) return '💳';
  if (s.includes('銀行') || s.includes('bank') || s.includes('帳戶') || s.includes('交割')) return '🏦';
  return kind === 'account' ? '💼' : '📁';
}

const subEmojiFor = (cat, sub) => ((config && config.subEmoji) || {})[sub] || emojiFor(cat);
const withEmoji = (name, kind) => `${emojiFor(name, kind)} ${esc(name)}`;

const visibleAccounts = () => config.accounts.filter(a => a.show);
const categoriesOf = type => [...new Set(config.categories.filter(c => c.type === type).map(c => c.category))];
const subsOf = (type, category) => config.categories.filter(c => c.type === type && c.category === category).map(c => c.sub);

function defaultAccountFor(type, category, sub) {
  const last = lastAccounts();
  const row = config.categories.find(c => c.type === type && c.category === category && c.sub === sub);
  return last[`${type}|${category}|${sub}`]
    || last[`${type}|${category}`]
    || (row && row.defaultAccount)
    || (visibleAccounts()[0] || {}).name
    || '';
}

function currencyOf(accountName) {
  const a = config.accounts.find(a => a.name === accountName);
  return a ? a.currency : 'TWD';
}

// ---------- 信用卡帳單週期（config.cards：Sheet 設定分頁 Z:AC）----------

const cardOf = name => ((config && config.cards) || []).find(c => c.name === name);

// 每月幾號，超過當月天數就取月底（結帳日 31 在 2 月 = 2/28）
function clampDay(month, day) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(Math.min(day, new Date(y, m, 0).getDate())).padStart(2, '0')}`;
}

// 週期以「結帳月」標識：結帳日 20 的 2026-07 期 = 06-21 ～ 07-20
function billRange(card, month) {
  return {
    from: shiftDate(clampDay(shiftMonth(month, -1), card.closeDay), 1),
    to: clampDay(month, card.closeDay),
  };
}

// 繳費日 = 結帳日之後第一個到期的繳費日（繳費日在結帳日前 = 下個月繳）
function billPayDate(card, month) {
  const pd = clampDay(month, card.payDay);
  return pd > clampDay(month, card.closeDay) ? pd : clampDay(shiftMonth(month, 1), card.payDay);
}

const currentBillMonth = card =>
  today() <= clampDay(today().slice(0, 7), card.closeDay) ? today().slice(0, 7) : shiftMonth(today().slice(0, 7), 1);

const fmtMD = s => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;

// 匯率來自設定分頁的 GOOGLEFINANCE；缺匯率時 fallback 1（等同舊行為：原始數字直加）
const rateOf = cur => cur === 'TWD' ? 1 : (config.rates || {})[cur] || 1;
const toTWD = r => r.amount * rateOf(r.currency);

function today() {
  return dateStr(new Date());
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDate(str, days) {
  const d = new Date(`${str}T12:00:00`);
  d.setDate(d.getDate() + days);
  return dateStr(d);
}

function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return dateStr(new Date(y, m, 0));
}

function dateLabel(str) {
  return `${str}（週${WEEKDAYS[new Date(`${str}T12:00:00`).getDay()]}）`;
}

function fmtMoney(n) {
  const sign = n < 0 ? '-' : '';
  if (masked) return `${sign}$ ••••`;
  return `${sign}$ ${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

const spinnerHTML = '<p class="loading"><i class="spinner"></i></p>';

// 寫入中全頁遮罩：擋住重複點擊，也讓「正在存」比按鍵上的小 spinner 明顯
function showBusy(msg) {
  $('#busy span').textContent = msg;
  $('#busy').classList.remove('hidden');
}

function hideBusy() {
  $('#busy').classList.add('hidden');
}

let toastTimer;
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2200);
}

// ---------- API ----------

async function apiGet(params) {
  const qs = new URLSearchParams(Object.assign({ token: token() }, params));
  const res = await fetch(`${API_URL}?${qs}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data;
}

async function apiPost(payload) {
  const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify(Object.assign({ token: token() }, payload)) });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data;
}

function handleAuthError(err) {
  if (String(err.message) === 'unauthorized') {
    localStorage.removeItem('mb_token');
    toast('Token 錯誤，請重新設定', true);
    showTokenScreen();
    return true;
  }
  return false;
}

async function fetchConfig() {
  const data = await apiGet({});
  config = data;
  localStorage.setItem('mb_config', JSON.stringify(data));
}

// 已有整月快取（開過月曆/統計）就直接取子集，翻日不逐日打 API
async function fetchDayRecords(date) {
  const monthKey = `m:${date.slice(0, 7)}`;
  if (recordCache.has(monthKey)) return cacheTouch(monthKey).filter(r => r.date === date);
  return (await fetchMonthRecords(date.slice(0, 7))).filter(r => r.date === date);
}

// GAS 每次呼叫固定 ~4 秒、資料量的邊際成本趨近零（實測 101 筆與 8,499 筆同速）——
// 缺月快取時一次把前後月一起撈回來，翻日跨月、統計換月都不用再等
async function fetchMonthRecords(month) {
  const key = `m:${month}`;
  if (recordCache.has(key)) return cacheTouch(key);
  const prev = shiftMonth(month, -1), next = shiftMonth(month, 1);
  const seq = writeSeq;
  const data = await apiGet({ action: 'records', from: `${prev}-01`, to: monthEnd(next) });
  const result = data.records.filter(r => r.date.slice(0, 7) === month);
  if (writeSeq !== seq) return result; // 撈的期間有寫入：只回傳顯示用，不快取（下次重撈拿到含新記錄的版本）
  [prev, month, next].forEach(m =>
    recordCache.set(`m:${m}`, data.records.filter(r => r.date.slice(0, 7) === m)));
  persistCaches();
  return cacheTouch(key);
}

// 區間查詢（統計年/自訂、帳戶明細）組裝 m: 月快取的聯集：與日常翻頁共用快取、
// 寫入靠 applyWrite 修補單月即可。缺的月份「一次」撈回補齊（頭尾一刀，GAS 固定開銷只付一次）
async function fetchSpanRecords(from, to) {
  const months = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = shiftMonth(m, 1)) months.push(m);
  const missing = months.filter(m => !recordCache.has(`m:${m}`));
  const seq = writeSeq;
  const fetched = new Map();
  if (missing.length) {
    const data = await apiGet({ action: 'records', from: `${missing[0]}-01`, to: monthEnd(missing[missing.length - 1]) });
    missing.forEach(m => fetched.set(m, data.records.filter(r => r.date.slice(0, 7) === m)));
    // 純填空且撈取期間無寫入才快取；先組結果再 persist，超量淘汰不影響本次回傳
    if (writeSeq === seq) missing.forEach(m => recordCache.set(`m:${m}`, fetched.get(m)));
  }
  const result = months
    .flatMap(m => fetched.get(m) || (recordCache.has(`m:${m}`) ? cacheTouch(`m:${m}`) : []))
    .filter(r => r.date >= from && r.date <= to)
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.ts).localeCompare(String(a.ts)));
  if (missing.length && writeSeq === seq) persistCaches();
  return result;
}

// 背景預熱：開 app／⚙️ 重新整理後，一次撈當年 1 月到本月切成 m: 月快取，讓之後翻月即時。
// 射後不理、失敗靜默；純填空（只寫仍缺的月份，不覆蓋既有快取，避免與同時發生的寫入搶更新）
async function warmCurrentYear() {
  if (!token()) return;
  const year = today().slice(0, 4), thisMonth = today().slice(0, 7);
  const months = [];
  for (let m = `${year}-01`; m <= thisMonth; m = shiftMonth(m, 1)) months.push(m);
  if (months.every(m => recordCache.has(`m:${m}`))) return;
  const seq = writeSeq;
  try {
    const data = await apiGet({ action: 'records', from: `${year}-01-01`, to: monthEnd(thisMonth) });
    if (writeSeq !== seq) return; // 預熱期間有寫入：整批丟棄，下次開啟再熱
    months.filter(m => !recordCache.has(`m:${m}`))
      .forEach(m => recordCache.set(`m:${m}`, data.records.filter(r => r.date.slice(0, 7) === m)));
    persistCaches();
  } catch (_) { /* 背景預熱，靜默失敗，下次再試 */ }
}

// 換日檢查：週期記帳凌晨生成的記錄不會失效前端快取，新的一天首次開啟時
// 背景重抓「上次開啟～今天」涉及的已快取月份（先出舊資料再靜默更新），餘額整包重抓
function refreshStaleMonths() {
  const last = localStorage.getItem('mb_day');
  localStorage.setItem('mb_day', today());
  if (!last || last === today()) return;
  const seq = writeSeq;
  balancesCache = null;
  persistCaches();
  apiGet({ action: 'balances' }).then(d => {
    if (writeSeq !== seq) return;
    balancesCache = d.balances;
    persistCaches();
  }).catch(() => {});
  const months = [];
  for (let m = last.slice(0, 7); m <= today().slice(0, 7); m = shiftMonth(m, 1)) months.push(m);
  const stale = months.filter(m => recordCache.has(`m:${m}`));
  if (!stale.length) return;
  // 頭尾一刀一次撈回（GAS 固定開銷只付一次），同 fetchSpanRecords 策略
  apiGet({ action: 'records', from: `${stale[0]}-01`, to: monthEnd(stale[stale.length - 1]) }).then(data => {
    if (writeSeq !== seq) return;
    stale.forEach(m => recordCache.set(`m:${m}`, data.records.filter(r => r.date.slice(0, 7) === m)));
    persistCaches();
    if (state.view === 'list' && stale.includes(state.listDate.slice(0, 7))) renderList();
  }).catch(() => { /* 背景更新，靜默失敗，畫面維持舊快取 */ });
}

async function fetchBalances() {
  if (!balancesCache) {
    balancesCache = (await apiGet({ action: 'balances' })).balances;
    persistCaches();
  }
  return balancesCache;
}

// 全史記錄（搜尋、全期間資產趨勢、標籤全期間總計共用）：15 年僅 1.6MB、與撈一個月同速，
// 只留在記憶體不落 localStorage，session 內第一次用付 4 秒之後即時；任何寫入直接作廢
let allRecords = null;

async function fetchAllRecords() {
  if (allRecords) return allRecords;
  const seq = writeSeq;
  const records = (await apiGet({ action: 'records', from: '', to: '' })).records;
  if (writeSeq === seq) allRecords = records;
  return records;
}

// ---------- 計算機 ----------

function evalExpr(expr) {
  const tokens = expr.match(/(\d+\.?\d*|[+\-*/])/g);
  if (!tokens || /[+\-*/]$/.test(expr)) return null;
  const pass1 = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '*' || t === '/') {
      const a = pass1.pop();
      const b = parseFloat(tokens[++i]);
      pass1.push(t === '*' ? a * b : a / b);
    } else if (t === '+' || t === '-') {
      pass1.push(t);
    } else {
      pass1.push(parseFloat(t));
    }
  }
  let result = pass1[0];
  for (let i = 1; i < pass1.length; i += 2) {
    result = pass1[i] === '+' ? result + pass1[i + 1] : result - pass1[i + 1];
  }
  return isFinite(result) ? Math.round(result * 100) / 100 : null;
}

function keyPress(key) {
  let e = state.expr;
  if (key === 'AC') e = '';
  else if (key === 'DEL') e = e.slice(0, -1);
  else if ('+-*/'.includes(key)) {
    if (e === '') return;
    e = /[+\-*/]$/.test(e) ? e.slice(0, -1) + key : e + key;
  } else if (key === '.') {
    const cur = e.split(/[+\-*/]/).pop();
    if (!cur.includes('.')) e += cur === '' ? '0.' : '.';
  } else {
    e += key;
  }
  state.expr = e;
  updateAmountDisplay();
}

// 顯示層格式化：千分位逗號 + 運算子換成 × ÷ −（state.expr 保持原始字串給 evalExpr）
const OP_DISPLAY = { '*': '×', '/': '÷', '-': '−' };
function fmtExpr(expr) {
  return expr
    .replace(/\d+\.?\d*/g, t => {
      const [int, frac] = t.split('.');
      return Number(int).toLocaleString('en-US') + (frac !== undefined ? `.${frac}` : '');
    })
    .replace(/[*/-]/g, op => OP_DISPLAY[op]);
}

function updateAmountDisplay() {
  const el = $('#amount-display');
  if (el) el.textContent = state.expr ? fmtExpr(state.expr) : '0';
  const pv = $('#amount-preview');
  if (pv) {
    const r = /[+\-*/]/.test(state.expr.slice(1)) ? evalExpr(state.expr) : null;
    pv.textContent = r === null ? '' : `= ${r.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
  const ta = $('#to-amount');
  if (ta) ta.placeholder = toAmountHint();
}

// 跨幣別轉帳的入帳金額參考價（僅 placeholder 提示，實際金額自己輸入）
function toAmountHint() {
  const n = evalExpr(state.expr || '') || 0;
  const v = n * rateOf(currencyOf(state.from)) / rateOf(currencyOf(state.to));
  return v ? `≈ ${Math.round(v * 100) / 100}` : '轉入金額';
}

// ---------- Views ----------

function render() {
  document.querySelectorAll('#bottom-nav button[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === state.view));
  const v = $('#view');
  v.className = '';
  // 重播淡入動畫（只在切換分頁時，換日/換月的局部重繪不觸發）
  v.style.animation = 'none';
  void v.offsetWidth;
  v.style.animation = '';
  if (state.view === 'add') renderAdd();
  else if (state.view === 'list') renderList();
  else if (state.view === 'stats') renderStats();
  else renderAccounts();
}

// ---------- 新增 ----------

function renderAdd() {
  const isTransfer = state.type === '轉帳';
  $('#view').className = { '支出': 'type-expense', '收入': 'type-income', '轉帳': 'type-transfer' }[state.type];
  const rows = [];

  const crossCurrency = isTransfer && state.from && state.to && currencyOf(state.from) !== currencyOf(state.to);
  if (isTransfer) {
    rows.push(row('轉出', state.from ? withEmoji(state.from, 'account') : '選擇帳戶', 'pick-from', !state.from));
    rows.push(row('轉入', state.to ? withEmoji(state.to, 'account') : '選擇帳戶', 'pick-to', !state.to));
    if (crossCurrency) {
      rows.push(`<div class="row-item"><span class="row-label">入帳金額</span>
        <input id="to-amount" inputmode="decimal" placeholder="${toAmountHint()}" value="${esc(state.toAmount)}">
        <span class="row-label">${currencyOf(state.to)}</span></div>`);
    }
    if ((config.holdings || []).length) {
      const h = state.holding;
      const side = h && holdingSide(h.ticker);
      const label = h
        ? `📈 ${esc(h.ticker)} ${side || '⚠️'} ${h.shares.toLocaleString('en-US')} 股`
        : '無';
      rows.push(row('持倉', label, 'pick-holding', !h));
    }
  } else {
    const catLabel = state.category
      ? `${emojiFor(state.category)} ${esc(state.category)} - ${subEmojiFor(state.category, state.sub)} ${esc(state.sub)}`
      : '選擇分類';
    rows.push(row('類別', catLabel, 'pick-cat', !state.category));
    const accLabel = state.account ? `${state.lockedAccount ? '📌 ' : ''}${withEmoji(state.account, 'account')}` : '選擇帳戶';
    rows.push(row(state.type === '支出' ? '帳戶' : '收款帳戶', accLabel, 'pick-account', !state.account));
  }
  const tagLabel = state.tags.size ? esc([...state.tags].join('、')) : '無';
  rows.push(row('標籤', tagLabel, 'pick-tags', !state.tags.size));

  // 常用快速記帳：只在支出/收入顯示、依當前類型過濾（編輯模式不顯示，避免誤蓋正在改的記錄）
  const quickItems = (isTransfer || state.editingTs) ? [] : (config.quick || []).filter(q => q.type === state.type);
  const quickBar = quickItems.length
    ? `<div class="quick-bar">${quickItems.map((q, i) => {
        const name = q.sub || q.category;
        // emoji 固定用主類別：不同分類下的同名子類別才分得出來
        return `<button class="quick-chip" data-qi="${i}">${emojiFor(q.category)} ${esc(name)}</button>`;
      }).join('')}</div>`
    : '';

  $('#view').innerHTML = `
    ${state.editingTs ? `<div class="edit-banner"><span>✏️ 編輯模式</span><button id="edit-cancel">取消編輯</button></div>` : ''}
    <div class="seg">${TYPES.map(t => `<button data-type="${t}" class="${t === state.type ? 'active' : ''}">${t}</button>`).join('')}</div>
    ${quickBar}
    <div class="amount-bar">
      <span class="cur">${isTransfer ? currencyOf(state.from) : currencyOf(state.account)}</span>
      <span class="amount-right"><small id="amount-preview"></small><span id="amount-display">${state.expr ? fmtExpr(state.expr) : '0'}</span></span>
    </div>
    <div class="date-bar">
      <button id="date-prev">‹</button>
      <span id="date-label" title="點一下回到今天">${dateLabel(state.date)}</span>
      ${state.editingTs ? '' : '<button id="paste-import" title="帶入捷徑剪貼簿">📋</button>'}
      <span class="cal-btn">📅<input type="date" id="date-input" value="${state.date}"></span>
      <button id="date-next">›</button>
    </div>
    <div class="rows">${rows.join('')}
      <div class="row-item"><span class="row-label">備註</span>
        <input id="note" placeholder="選填" value="${esc(state.note)}"></div>
    </div>
    <div id="keypad">
      <button data-k="AC" class="fn">AC</button><button data-k="DEL" class="fn del">DEL</button><button data-k="/" class="fn">÷</button><button data-k="*" class="fn">×</button>
      <button data-k="7">7</button><button data-k="8">8</button><button data-k="9">9</button><button data-k="-" class="fn">−</button>
      <button data-k="4">4</button><button data-k="5">5</button><button data-k="6">6</button><button data-k="+" class="fn">+</button>
      <button data-k="1">1</button><button data-k="2">2</button><button data-k="3">3</button><button id="ok" class="ok">${state.editingTs ? '更新' : 'OK'}</button>
      <button data-k="0" class="zero">0</button><button data-k=".">.</button>
    </div>`;

  const cancel = $('#edit-cancel');
  if (cancel) cancel.addEventListener('click', () => {
    resetEntry();
    renderAdd();
  });

  $('#view').querySelectorAll('.seg button').forEach(b =>
    b.addEventListener('click', () => {
      state.type = b.dataset.type;
      restoreEntryDefaults(state.type);
      if (state.type === '轉帳') {
        const vis = visibleAccounts();
        state.from = state.from || (vis[0] ? vis[0].name : '');
        state.to = state.to || (vis[1] ? vis[1].name : '');
      }
      saveEntryDefaults();
      renderAdd();
    }));

  const syncDate = () => { $('#date-label').textContent = dateLabel(state.date); $('#date-input').value = state.date; };
  $('#date-prev').addEventListener('click', () => { state.date = shiftDate(state.date, -1); syncDate(); });
  $('#date-next').addEventListener('click', () => { state.date = shiftDate(state.date, 1); syncDate(); });
  $('#date-label').addEventListener('click', () => { state.date = today(); syncDate(); });
  // iOS 點到 input 本身就會開原生選擇器；showPicker 只是桌面瀏覽器的輔助
  $('#date-input').addEventListener('click', e => { try { e.target.showPicker && e.target.showPicker(); } catch (_) {} });
  $('#date-input').addEventListener('change', e => { state.date = e.target.value || today(); syncDate(); });
  const pasteBtn = $('#paste-import');
  if (pasteBtn) pasteBtn.addEventListener('click', pasteImport);

  $('#note').addEventListener('input', e => (state.note = e.target.value));
  const toAmountInput = $('#to-amount');
  if (toAmountInput) toAmountInput.addEventListener('input', e => (state.toAmount = e.target.value));

  const actions = {
    'pick-cat': openCategorySheet,
    'pick-account': () => openAccountSheet(name => {
      state.account = name;
      if (state.lockedAccount) state.lockedAccount = name;
      saveEntryDefaults();
      renderAdd();
    }),
    'pick-from': () => openAccountSheet(name => { state.from = name; saveEntryDefaults(); renderAdd(); }),
    'pick-to': () => openAccountSheet(name => { state.to = name; saveEntryDefaults(); renderAdd(); }),
    'pick-tags': openTagSheet,
    'pick-holding': openHoldingSheet,
  };
  $('#view').querySelectorAll('[data-action]').forEach(el =>
    el.addEventListener('click', () => actions[el.dataset.action]()));

  $('#view').querySelectorAll('.quick-chip').forEach(b =>
    b.addEventListener('click', () => fillQuick(quickItems[Number(b.dataset.qi)])));

  $('#keypad').querySelectorAll('button[data-k]').forEach(b =>
    b.addEventListener('click', () => keyPress(b.dataset.k)));
  $('#ok').addEventListener('click', okPress);
  updateAmountDisplay();
}

function row(label, value, action, dim) {
  return `<div class="row-item" data-action="${action}">
    <span class="row-label">${label}</span>
    <span class="row-value ${dim ? 'dim' : ''}">${value}</span>
    <span class="chev">›</span></div>`;
}

function okPress() {
  if (/[+\-*/]/.test(state.expr.slice(1))) {
    const result = evalExpr(state.expr);
    if (result === null) return toast('算式不完整', true);
    state.expr = String(result);
    updateAmountDisplay();
    return;
  }
  submitRecord();
}

async function submitRecord() {
  const amount = parseFloat(state.expr);
  if (!amount || amount <= 0) return toast('請輸入金額', true);

  const payload = {
    type: state.type,
    amount,
    date: state.date,
    tags: [...state.tags],
    note: state.note.trim(),
  };

  if (state.type === '轉帳') {
    if (!state.from || !state.to) return toast('請選擇帳戶', true);
    if (state.from === state.to) return toast('轉出轉入不能相同', true);
    payload.category = '轉帳';
    payload.sub = '一般轉帳';
    payload.from = state.from;
    payload.to = state.to;
    payload.currency = currencyOf(state.from);
    if (currencyOf(state.from) !== currencyOf(state.to)) {
      const ta = parseFloat(state.toAmount);
      if (!ta || ta <= 0) return toast(`請輸入入帳金額（${currencyOf(state.to)}）`, true);
      payload.toAmount = ta;
    }
    if (state.holding) {
      const side = holdingSide(state.holding.ticker);
      if (!side) return toast(`無法判斷買賣：轉出/轉入沒有 ${state.holding.ticker} 的帳戶`, true);
      payload.note = [payload.note, holdingNote(state.holding, side)].filter(Boolean).join(' ');
    }
  } else {
    if (!state.category) return toast('請選擇分類', true);
    payload.category = state.category;
    payload.sub = state.sub;
    payload.currency = currencyOf(state.account);
    if (state.type === '支出') payload.from = state.account;
    else payload.to = state.account;
    rememberAccount(state.type, state.category, state.sub, state.account);
  }

  const wasEditing = state.editingTs;
  if (wasEditing) {
    payload.action = 'update';
    payload.ts = wasEditing;
  }
  saveEntryDefaults();

  const btn = $('#ok');
  btn.disabled = true;
  btn.innerHTML = '<i class="spinner sm light"></i>';
  showBusy(wasEditing ? '更新中…' : '記錄中…');
  try {
    const res = await apiPost(payload);
    toast(`${wasEditing ? '已更新' : '已記錄'} ${emojiFor(payload.category)} ${payload.category} ${fmtMoney(amount)}`);
    // 💰 股息流程送出成功：記住分類與該標的的帳戶，下次一鍵帶入
    if (state.divTicker && payload.type === '收入') {
      const div = safeParse('mb_div', '{}');
      div.category = payload.category;
      div.sub = payload.sub;
      (div.accounts = div.accounts || {})[state.divTicker] = payload.to;
      localStorage.setItem('mb_div', JSON.stringify(div));
    }
    // 後端回 ts 就就地修補快取（跳回明細零等待）；沒回（新版 Code.gs 還沒部署）退回舊的整月失效
    if (res.ts && (!wasEditing || state.editingOld)) {
      applyWrite(recordFromPayload(payload, res.ts), wasEditing ? state.editingOld : null);
    } else if (wasEditing) clearAllCaches();
    else invalidateCaches(payload.date);
    state.expr = '';
    state.note = '';
    state.toAmount = '';
    state.holding = null;
    state.divTicker = null;
    state.tags.clear();
    state.editingTs = null;
    state.editingOld = null;
    state.lockedAccount = null;
    state.view = 'list';
    state.listDate = payload.date;
    render();
  } catch (err) {
    if (!handleAuthError(err)) toast(`寫入失敗：${err.message}`, true);
    if (document.contains(btn)) {
      btn.disabled = false;
      btn.textContent = state.editingTs ? '更新' : 'OK';
    }
  } finally {
    hideBusy();
  }
}

// ---------- 明細 ----------

async function renderList() {
  const d = state.listDate;
  const cached = recordCache.has(`m:${d.slice(0, 7)}`);
  $('#view').innerHTML = `
    <div class="date-bar big">
      <button id="list-prev">‹</button>
      <span id="list-label" title="點一下回到今天">${dateLabel(d)}</span>
      <button id="list-search">🔍</button>
      <button id="list-cal">📅</button>
      <button id="list-next">›</button>
    </div>
    <div id="day-total" class="day-total"></div>
    <div id="record-list" class="record-list">${cached ? '' : spinnerHTML}</div>`;

  $('#list-prev').addEventListener('click', () => { state.listDate = shiftDate(state.listDate, -1); renderList(); });
  $('#list-next').addEventListener('click', () => { state.listDate = shiftDate(state.listDate, 1); renderList(); });
  $('#list-label').addEventListener('click', () => { state.listDate = today(); renderList(); });
  $('#list-cal').addEventListener('click', () => openCalendarSheet(d.slice(0, 7)));
  $('#list-search').addEventListener('click', openSearchSheet);

  try {
    const records = await fetchDayRecords(d);
    if (state.view !== 'list' || state.listDate !== d) return;

    const net = records.reduce((sum, r) =>
      r.type === '支出' ? sum - r.amount : r.type === '收入' ? sum + r.amount : sum, 0);
    $('#day-total').textContent = `當日小計 ${fmtMoney(net)}`;
    $('#day-total').className = 'day-total ' + (net < 0 ? 'neg' : 'pos');

    $('#record-list').innerHTML = records.length === 0
      ? '<p class="loading">這天沒有記錄</p><button id="empty-add" class="empty-add">＋ 記一筆</button>'
      : records.map((r, i) => {
          const isExpense = r.type === '支出';
          const isTransfer = r.type === '轉帳';
          const accountText = esc(isTransfer ? `${r.from} → ${r.to}` : (r.from || r.to));
          const amountText = isTransfer && r.toAmount
            ? `${r.currency} ${masked ? '••••' : r.amount.toLocaleString('en-US')} → ${currencyOf(r.to)} ${masked ? '••••' : r.toAmount.toLocaleString('en-US')}`
            : `${r.currency !== 'TWD' ? r.currency + ' ' : ''}${fmtMoney(isExpense ? -r.amount : r.amount)}`;
          const catText = isTransfer
            ? '🔄 轉帳'
            : `${emojiFor(r.category)} ${esc(r.category)}${r.sub ? ` - ${subEmojiFor(r.category, r.sub)} ${esc(r.sub)}` : ''}`;
          return `<div class="record" data-i="${i}">
            <div class="rec-main">
              <span class="rec-cat">${catText}</span>
              <span class="rec-amount ${isExpense ? 'neg' : isTransfer ? '' : 'pos'}">${amountText}</span>
            </div>
            <div class="rec-sub">
              <span>${esc([r.note, r.tags].filter(Boolean).join('　#'))}</span>
              <span>${accountText}</span>
            </div>
          </div>`;
        }).join('');

    $('#record-list').querySelectorAll('.record').forEach(el =>
      el.addEventListener('click', () => openRecordSheet(records[Number(el.dataset.i)])));

    const emptyAdd = $('#empty-add');
    if (emptyAdd) emptyAdd.addEventListener('click', () => {
      resetEntry();
      state.date = d;
      state.view = 'add';
      render();
    });
  } catch (err) {
    if (!handleAuthError(err)) $('#record-list').innerHTML = `<p class="loading">載入失敗：${err.message}</p>`;
  }
}

// 月曆：每日收入/支出小計，點日期跳該日明細（金額同當日小計，不做匯率折算）
async function openCalendarSheet(month) {
  openSheet(`
    <div class="date-bar big">
      <button id="cal-prev">‹</button>
      <span>${month.replace('-', ' 年 ')} 月</span>
      <button id="cal-next">›</button>
    </div>
    <div id="cal-body" data-month="${month}">${recordCache.has(`m:${month}`) ? '' : spinnerHTML}</div>`);

  $('#cal-prev').addEventListener('click', () => openCalendarSheet(shiftMonth(month, -1)));
  $('#cal-next').addEventListener('click', () => openCalendarSheet(shiftMonth(month, 1)));

  let records;
  try {
    records = await fetchMonthRecords(month);
  } catch (err) {
    if (handleAuthError(err)) return;
    const body = $('#cal-body');
    if (body && body.dataset.month === month) body.innerHTML = `<p class="loading">載入失敗：${err.message}</p>`;
    return;
  }
  const body = $('#cal-body');
  if (!body || body.dataset.month !== month) return;

  const sums = {};
  records.forEach(r => {
    if (r.type === '轉帳') return;
    const s = sums[r.date] || (sums[r.date] = { exp: 0, inc: 0 });
    if (r.type === '支出') s.exp += r.amount;
    else s.inc += r.amount;
  });

  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const cells = Array.from({ length: new Date(y, m - 1, 1).getDay() }, () => '<span></span>');
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const s = sums[date];
    cells.push(`<button class="cal-day${date === today() ? ' today' : ''}${date === state.listDate ? ' sel' : ''}" data-date="${date}">
      <span class="d">${d}</span>
      <span class="pos">${s && s.inc ? fmtShort(s.inc) : ''}</span>
      <span class="neg">${s && s.exp ? `-${fmtShort(s.exp)}` : ''}</span>
    </button>`);
  }

  body.innerHTML = `
    <div class="cal-grid head">${WEEKDAYS.map(w => `<span>${w}</span>`).join('')}</div>
    <div class="cal-grid">${cells.join('')}</div>`;

  body.querySelectorAll('.cal-day').forEach(el =>
    el.addEventListener('click', () => {
      closeSheet();
      state.listDate = el.dataset.date;
      renderList();
    }));
}

function setStateFromRecord(r, mode) {
  state.lockedAccount = null;
  state.type = TYPES.includes(r.type) ? r.type : '支出';
  if (state.type === '轉帳') {
    state.from = r.from;
    state.to = r.to;
  } else {
    state.category = r.category;
    state.sub = r.sub;
    state.account = r.from || r.to;
  }
  state.tags = new Set(r.tags ? r.tags.split(',').filter(Boolean) : []);
  state.customTags.push(...state.tags);
  saveCustomTags();
  state.note = r.note || '';
  // 備註裡恰有一筆已知標的的持倉字串時反解回「持倉」列（多筆或未知標的就留在備註手改）；
  // 正負號不留存——送出時 holdingSide 從轉出/轉入方向重算
  state.holding = null;
  if (state.type === '轉帳' && state.note) {
    const ms = [...state.note.matchAll(SHARE_RE)];
    if (ms.length === 1 && ((config && config.holdings) || []).some(h => h.ticker === ms[0][1].toUpperCase())) {
      state.holding = { ticker: ms[0][1].toUpperCase(), shares: Math.abs(Number(ms[0][2])) };
      state.note = state.note.replace(ms[0][0], '').replace(/\s{2,}/g, ' ').trim();
    }
  }
  state.expr = String(r.amount);
  state.toAmount = r.toAmount ? String(r.toAmount) : '';
  state.date = mode === 'edit' ? r.date : today();
  state.editingTs = mode === 'edit' ? r.ts : null;
  state.editingOld = mode === 'edit' ? r : null; // 更新成功後要用舊值反向修補快取/餘額
}

function openRecordSheet(r) {
  const isExpense = r.type === '支出';
  const isTransfer = r.type === '轉帳';
  const amountCls = isExpense ? 'neg' : isTransfer ? '' : 'pos';
  const cur = r.currency !== 'TWD' ? `${r.currency} ` : '';

  const detail = [['日期', dateLabel(r.date)], ['類型', r.type]];
  if (!isTransfer) {
    detail.push(['類別', `${emojiFor(r.category)} ${esc(r.category)}${r.sub ? ` - ${subEmojiFor(r.category, r.sub)} ${esc(r.sub)}` : ''}`]);
  }
  detail.push(['金額', `${cur}${fmtMoney(r.amount)}`, amountCls]);
  if (isTransfer) {
    if (r.toAmount) detail.push(['入帳金額', `${config ? currencyOf(r.to) + ' ' : ''}${fmtMoney(r.toAmount)}`]);
    detail.push(['轉出', withEmoji(r.from, 'account')]);
    detail.push(['轉入', withEmoji(r.to, 'account')]);
  } else {
    detail.push([isExpense ? '付款帳戶' : '收款帳戶', withEmoji(r.from || r.to, 'account')]);
  }
  if (r.tags) detail.push(['標籤', r.tags.split(',').filter(Boolean).map(t => `#${esc(t)}`).join('　')]);
  if (r.note) detail.push(['備註', esc(r.note)]);

  openSheet(`
    <h3>明細</h3>
    <div class="rows">${detail.map(([k, v, cls]) => `
      <div class="row-item"><span class="row-label">${k}</span><span class="row-value plain ${cls || ''}">${v}</span></div>`).join('')}
    </div>
    <div class="sheet-actions">
      <button id="rec-edit">✏️ 編輯</button>
      <button id="rec-copy">📄 複製</button>
      <button id="rec-del" class="danger">🗑️ 刪除</button>
    </div>
    <p class="hint">複製會建立新的一筆，日期改為今天</p>`);

  const needTs = fn => () => {
    if (!r.ts) return toast('這筆沒有記錄時間，請直接在 Sheet 修改', true);
    fn();
  };

  $('#rec-edit').addEventListener('click', needTs(() => {
    closeSheet();
    setStateFromRecord(r, 'edit');
    state.view = 'add';
    render();
  }));

  $('#rec-copy').addEventListener('click', () => {
    closeSheet();
    setStateFromRecord(r, 'copy');
    state.view = 'add';
    render();
  });

  $('#rec-del').addEventListener('click', needTs(async () => {
    // 兩段式確認：第一次點變紅，再點一次才真的刪
    const btn = $('#rec-del');
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = '確定刪除？';
      return;
    }
    closeSheet();
    toast('刪除中…');
    try {
      await apiPost({ action: 'delete', ts: r.ts });
      applyWrite(null, r);
      toast('已刪除');
      render();
    } catch (err) {
      if (!handleAuthError(err)) toast(`刪除失敗：${err.message}`, true);
    }
  }));
}

// ---------- 統計 ----------

const CHART_LABELS = {
  expense: '支出分類', income: '收入分類', tag: '標籤分佈',
  expenseTrend: '支出趨勢', incomeTrend: '收入趨勢', netTrend: '結餘趨勢', assetTrend: '資產趨勢',
};

function yearMonths(year) {
  const nowM = today().slice(0, 7);
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
    .filter(m => m <= nowM);
}

function fmtShort(n) {
  if (masked) return '••';
  const a = Math.abs(n);
  if (a >= 10000) return `${(n / 10000).toFixed(a >= 1000000 ? 0 : 1)}萬`;
  if (a >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function statsSnapshot() {
  const st = state.stats;
  return [state.view, st.mode, st.month, st.year, st.chart, st.tag, st.expanded].join('|');
}

async function renderStats() {
  const st = state.stats;
  const charts = st.mode === 'year'
    ? ['expense', 'income', 'tag', 'expenseTrend', 'incomeTrend', 'netTrend', 'assetTrend']
    : ['expense', 'income', 'tag'];
  if (st.mode !== 'all' && !charts.includes(st.chart)) st.chart = 'expense';

  let periodBar = '';
  if (st.mode === 'month') {
    periodBar = `<div class="date-bar big">
      <button id="stats-prev">‹</button>
      <span id="stats-label" title="點一下回到本月">${st.month.replace('-', ' 年 ')} 月</span>
      <button id="stats-next">›</button>
    </div>`;
  } else if (st.mode === 'year') {
    periodBar = `<div class="date-bar big">
      <button id="stats-prev">‹</button>
      <span id="stats-label" title="點一下回到今年">${st.year} 年</span>
      <button id="stats-next">›</button>
    </div>`;
  }

  $('#view').innerHTML = `
    <div class="seg">${[['month', '月'], ['year', '年'], ['all', '總覽']].map(([k, l]) =>
      `<button data-mode="${k}" class="${st.mode === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    ${periodBar}
    ${st.mode === 'all' ? '' : `<div class="chart-select"><select id="chart-select">${charts.map(c =>
      `<option value="${c}" ${st.chart === c ? 'selected' : ''}>${CHART_LABELS[c]}</option>`).join('')}</select></div>`}
    <div id="stats-body">${spinnerHTML}</div>`;

  $('#view').querySelectorAll('[data-mode]').forEach(b =>
    b.addEventListener('click', () => {
      st.mode = b.dataset.mode;
      if (st.mode === 'year') st.year = Number(st.month.slice(0, 4));
      st.expanded = null;
      renderStats();
    }));

  const chartSel = $('#chart-select');
  if (chartSel) chartSel.addEventListener('change', e => {
    st.chart = e.target.value;
    st.expanded = null;
    renderStats();
  });

  const prev = $('#stats-prev');
  if (prev) {
    prev.addEventListener('click', () => {
      if (st.mode === 'month') st.month = shiftMonth(st.month, -1);
      else st.year -= 1;
      st.expanded = null;
      renderStats();
    });
    $('#stats-next').addEventListener('click', () => {
      if (st.mode === 'month') st.month = shiftMonth(st.month, 1);
      else st.year += 1;
      st.expanded = null;
      renderStats();
    });
    $('#stats-label').addEventListener('click', () => {
      if (st.mode === 'month') st.month = today().slice(0, 7);
      else st.year = Number(today().slice(0, 4));
      st.expanded = null;
      renderStats();
    });
  }

  const snap = statsSnapshot();
  try {
    // 總覽：與期間無關的三張圖直排一頁看完（資產配置快照 + 全期間資產/支出趨勢）
    if (st.mode === 'all') {
      const [balances, shares, records] = await Promise.all([
        fetchBalances(), computeHoldingShares(), fetchAllRecords(),
      ]);
      if (statsSnapshot() !== snap) return;
      $('#stats-body').innerHTML = `
        <div class="sec-title">資產配置（市值快照）</div>
        ${allocHTML(balances, shares)}
        <div class="sec-title">資產趨勢（全期間）</div>
        ${assetAllHTML(records, balances)}
        <div class="sec-title">支出趨勢（全期間）</div>
        ${expenseAllHTML(records)}`;
      $('#stats-body').querySelectorAll('.cat-row').forEach(el =>
        el.addEventListener('click', () => {
          st.expanded = st.expanded === el.dataset.cat ? null : el.dataset.cat;
          renderStats();
        }));
      return;
    }

    if (st.chart === 'assetTrend') {
      const nowYear = Number(today().slice(0, 4));
      if (st.year > nowYear) {
        $('#stats-body').innerHTML = '<p class="loading">還沒到這一年</p>';
        return;
      }
      const to = st.year === nowYear ? `${st.year}-12-31` : today();
      const [records, balances] = await Promise.all([
        fetchSpanRecords(`${st.year}-01-01`, to),
        fetchBalances(),
      ]);
      if (statsSnapshot() !== snap) return;
      $('#stats-body').innerHTML = assetTrendHTML(records, balances);
      return;
    }

    const records = st.mode === 'month'
      ? await fetchMonthRecords(st.month)
      : await fetchSpanRecords(`${st.year}-01-01`, `${st.year}-12-31`);
    if (statsSnapshot() !== snap) return;

    // assetTrend 已在上面 return，這裡的 *Trend 只剩支出/收入/結餘月趨勢
    if (st.chart.endsWith('Trend')) $('#stats-body').innerHTML = monthlyTrendHTML(records, st.chart.slice(0, -5));
    else renderPieStats(records);
  } catch (err) {
    if (!handleAuthError(err)) $('#stats-body').innerHTML = `<p class="loading">載入失敗：${err.message}</p>`;
  }
}

function renderPieStats(all) {
  const st = state.stats;
  const isTag = st.chart === 'tag';
  const type = st.chart === 'income' ? '收入' : '支出';

  if (st.excluded.size) all = all.filter(r => !st.excluded.has(`${r.type}|${r.category}`));

  const rangeTags = [...new Set(all.flatMap(r => r.tags ? r.tags.split(',') : []))].filter(Boolean);
  if (st.tag && !rangeTags.includes(st.tag)) st.tag = null;
  const records = !isTag && st.tag
    ? all.filter(r => (r.tags || '').split(',').includes(st.tag))
    : all;

  const totalExpense = records.filter(r => r.type === '支出').reduce((s, r) => s + toTWD(r), 0);
  const totalIncome = records.filter(r => r.type === '收入').reduce((s, r) => s + toTWD(r), 0);

  const groups = new Map();
  const add = (name, sub, amount) => {
    if (!groups.has(name)) groups.set(name, { total: 0, subs: new Map() });
    const g = groups.get(name);
    g.total += amount;
    g.subs.set(sub, (g.subs.get(sub) || 0) + amount);
  };
  records.filter(r => r.type === type).forEach(r => {
    const amount = toTWD(r);
    if (isTag) {
      const tags = (r.tags || '').split(',').filter(Boolean);
      (tags.length ? tags : ['無標籤']).forEach(t => add(t, r.category, amount));
    } else {
      add(r.category, r.sub, amount);
    }
  });
  const rows = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
  const donutTotal = rows.reduce((s, [, g]) => s + g.total, 0);

  let acc = 0;
  const segments = rows.map(([, g], i) => {
    const start = acc / donutTotal * 360;
    acc += g.total;
    return `${PALETTE[i % PALETTE.length]} ${start.toFixed(1)}deg ${(acc / donutTotal * 360).toFixed(1)}deg`;
  });

  const label = name => isTag ? (name === '無標籤' ? '🏷️ 無標籤' : `#${esc(name)}`) : `${emojiFor(name)} ${esc(name)}`;
  const subLabel = (name, sub) => isTag ? `${emojiFor(sub)} ${esc(sub)}` : `${subEmojiFor(name, sub)} ${esc(sub)}`;

  const tagChips = !isTag && rangeTags.length
    ? `<div class="chips stats-tags">
        <button data-tag="" class="${!st.tag ? 'active' : ''}">全部</button>
        ${rangeTags.map(t => `<button data-tag="${esc(t)}" class="${t === st.tag ? 'active' : ''}">#${esc(t)}</button>`).join('')}
      </div>${st.tag ? '<p class="hint" id="tag-alltime"></p>' : ''}`
    : '';

  const excludedBar = st.excluded.size
    ? `<div class="chips stats-excluded">${[...st.excluded].map(k => {
        const [t, c] = k.split('|');
        return `<button data-restore="${esc(k)}">⊘ ${emojiFor(c)} ${esc(c)}（${t}）✕</button>`;
      }).join('')}</div>`
    : '';

  // 年模式的月均支出：過去年度 ÷12；今年分子分母都只取已完整結束的月份（吃排除/標籤過濾後的數字）
  let avgRow = '';
  if (st.mode === 'year') {
    const nowY = Number(today().slice(0, 4));
    const months = st.year < nowY ? 12 : st.year === nowY ? Number(today().slice(5, 7)) - 1 : 0;
    if (months > 0) {
      const doneExpense = st.year === nowY
        ? records.filter(r => r.type === '支出' && Number(r.date.slice(5, 7)) <= months)
            .reduce((s, r) => s + toTWD(r), 0)
        : totalExpense;
      const avgLabel = st.year === nowY ? `月均支出（1–${months}月）` : '月均支出';
      avgRow = `<div><span>${avgLabel}</span><b class="neg">${fmtMoney(-Math.round(doneExpense / months))}</b></div>`;
    }
  }

  $('#stats-body').innerHTML = `
    ${excludedBar}
    ${tagChips}
    <div class="totals">
      <div><span>支出</span><b class="neg">${fmtMoney(-totalExpense)}</b></div>
      <div><span>收入</span><b class="pos">${fmtMoney(totalIncome)}</b></div>
      <div><span>收支</span><b class="${totalIncome - totalExpense < 0 ? 'neg' : 'pos'}">${fmtMoney(totalIncome - totalExpense)}</b></div>
      ${avgRow}
    </div>
    ${rows.length === 0
      ? `<p class="loading">這段期間沒有${type}記錄</p>`
      : `<div class="donut" style="background:conic-gradient(${segments.join(',')})"><span>${fmtShort(type === '收入' ? totalIncome : totalExpense)}</span></div>
         <div class="record-list">${rows.map(([name, g], i) => `
           <div class="record cat-row" data-cat="${esc(name)}">
             <div class="rec-main">
               <span class="rec-cat"><i class="dot" style="background:${PALETTE[i % PALETTE.length]}"></i>${label(name)}</span>
               <span class="rec-amount">${fmtMoney(g.total)}<small class="pct">${(g.total / donutTotal * 100).toFixed(0)}%</small></span>
               ${isTag ? '' : `<button class="ex-btn" data-ex="${esc(name)}" title="排除此分類">⊘</button>`}
             </div>
             ${st.expanded === name
               ? `<div class="sub-breakdown">${[...g.subs.entries()].sort((a, b) => b[1] - a[1])
                   .map(([s, v]) => `<div><span>${subLabel(name, s)}</span><span>${fmtMoney(v)}</span></div>`).join('')}</div>
                  ${st.mode === 'year' ? catTrendHTML(records, type, name, isTag) : ''}`
               : ''}
           </div>`).join('')}
         </div>`}`;

  $('#stats-body').querySelectorAll('.stats-tags button').forEach(b =>
    b.addEventListener('click', () => {
      st.tag = b.dataset.tag || null;
      renderStats();
    }));
  $('#stats-body').querySelectorAll('.ex-btn').forEach(b =>
    b.addEventListener('click', e => {
      e.stopPropagation();
      st.excluded.add(`${type}|${b.dataset.ex}`);
      renderStats();
    }));
  $('#stats-body').querySelectorAll('.stats-excluded button').forEach(b =>
    b.addEventListener('click', () => {
      st.excluded.delete(b.dataset.restore);
      renderStats();
    }));
  $('#stats-body').querySelectorAll('.cat-row').forEach(el =>
    el.addEventListener('click', () => {
      st.expanded = st.expanded === el.dataset.cat ? null : el.dataset.cat;
      renderStats();
    }));

  // 標籤全期間總計：旅行這類跨月標籤不用調自訂區間就能看總帳（全史第一次撈付 4 秒，之後即時）
  if (st.tag && !isTag) {
    const tag = st.tag;
    const snap = statsSnapshot();
    fetchAllRecords().then(all => {
      const el = $('#tag-alltime');
      if (!el || statsSnapshot() !== snap) return;
      const hits = all.filter(r => (r.tags || '').split(',').includes(tag));
      const ex = hits.filter(r => r.type === '支出').reduce((s, r) => s + toTWD(r), 0);
      const inc = hits.filter(r => r.type === '收入').reduce((s, r) => s + toTWD(r), 0);
      el.textContent = `#${tag} 全期間：支出 ${fmtMoney(ex)}・收入 ${fmtMoney(inc)}（${hits.length} 筆）`;
    }).catch(() => {});
  }
}

// 展開分類/標籤時的 12 個月長條（只在年模式，資料就是年統計已撈的 records）
function catTrendHTML(records, type, name, isTag) {
  const months = yearMonths(state.stats.year);
  const sums = new Map(months.map(m => [m, 0]));
  records.filter(r => r.type === type).forEach(r => {
    const tags = (r.tags || '').split(',').filter(Boolean);
    const hit = isTag ? (name === '無標籤' ? !tags.length : tags.includes(name)) : r.category === name;
    const k = r.date.slice(0, 7);
    if (hit && sums.has(k)) sums.set(k, sums.get(k) + toTWD(r));
  });
  return barChartHTML(months.map(m => ({ label: String(Number(m.slice(5))), v: sums.get(m) })));
}

// 支出/收入/結餘的年度月趨勢共用（chart key 去掉 Trend 後綴 = kind）
const TREND_META = {
  income: { title: '年度收入', empty: '收入', pick: r => r.type === '收入' ? toTWD(r) : 0 },
  expense: { title: '年度支出', empty: '支出', pick: r => r.type === '支出' ? -toTWD(r) : 0 },
  net: { title: '年度結餘', empty: '', pick: r => r.type === '收入' ? toTWD(r) : r.type === '支出' ? -toTWD(r) : 0 },
};

function monthlyTrendHTML(records, kind) {
  const meta = TREND_META[kind];
  const months = yearMonths(state.stats.year);
  if (!months.length) return '<p class="loading">還沒到這一年</p>';
  const sums = new Map(months.map(m => [m, 0]));
  records.forEach(r => {
    const v = meta.pick(r);
    const k = r.date.slice(0, 7);
    if (v && sums.has(k)) sums.set(k, sums.get(k) + v);
  });
  if (![...sums.values()].some(v => v)) return `<p class="loading">這一年沒有${meta.empty}記錄</p>`;
  const total = [...sums.values()].reduce((s, v) => s + v, 0);
  const cls = total < 0 ? 'neg' : 'pos';
  const points = months.map(m => ({ label: String(Number(m.slice(5))), v: sums.get(m) }));
  return `
    <div class="totals">
      <div><span>${meta.title}</span><b class="${cls}">${fmtMoney(total)}</b></div>
      <div><span>月平均</span><b class="${cls}">${fmtMoney(total / months.length)}</b></div>
    </div>
    ${barChartHTML(points)}`;
}

// 支援負值：高度取絕對值比例、負值長條與數字標紅（結餘趨勢、支出趨勢以負值呈現）
function barChartHTML(points) {
  const max = Math.max(...points.map(p => Math.abs(p.v)), 1);
  return `<div class="bar-chart">${points.map(p => `
    <div class="bar-col">
      <div class="bar-area">
        <span class="bar-val${p.v < 0 ? ' neg' : ''}">${p.v ? fmtShort(p.v) : ''}</span>
        <div class="bar${p.v < 0 ? ' negbar' : ''}" style="height:${(Math.abs(p.v) / max * 88).toFixed(1)}%"></div>
      </div>
      <span class="bar-label">${p.label}</span>
    </div>`).join('')}</div>`;
}

function assetTrendHTML(records, balances) {
  const y = state.stats.year;
  const anchor = balances.reduce((s, b) => s + b.balance * rateOf(b.currency), 0);

  const netByMonth = {};
  records.forEach(r => {
    const v = r.type === '收入' ? toTWD(r) : r.type === '支出' ? -toTWD(r) : 0;
    if (!v) return;
    const k = r.date.slice(0, 7);
    netByMonth[k] = (netByMonth[k] || 0) + v;
  });

  const nowM = today().slice(0, 7);
  const seq = [];
  for (let m = `${y}-01`; m <= nowM; m = shiftMonth(m, 1)) seq.push(m);

  let acc = anchor;
  const assetAt = {};
  for (let i = seq.length - 1; i >= 0; i--) {
    assetAt[seq[i]] = acc;
    acc -= netByMonth[seq[i]] || 0;
  }
  const yearStart = acc;

  const points = seq.filter(m => m.startsWith(`${y}-`))
    .map(m => ({ label: String(Number(m.slice(5))), v: assetAt[m] }));
  const last = points[points.length - 1].v;
  const diff = last - yearStart;
  const lastLabel = y === Number(nowM.slice(0, 4)) ? '目前' : '年末';

  return `
    <div class="totals">
      <div><span>年初</span><b>${fmtMoney(yearStart)}</b></div>
      <div><span>${lastLabel}</span><b>${fmtMoney(last)}</b></div>
      <div><span>增減</span><b class="${diff < 0 ? 'neg' : 'pos'}">${fmtMoney(diff)}</b></div>
    </div>
    ${lineChartHTML(points)}
    <p class="hint">以目前結餘（外幣依即期匯率折算）扣回各月收支推算月底資產。</p>`;
}

// 全期間資產趨勢：同 assetTrendHTML 的往回推邏輯，但一路推到第一筆真實記錄。
// 2012-01 是期初/校正的 sentinel 月，跳過它當起點（金額仍計入起點餘額），免得前面一長段水平線
function assetAllHTML(records, balances) {
  const anchor = balances.reduce((s, b) => s + b.balance * rateOf(b.currency), 0);

  const netByMonth = {};
  records.forEach(r => {
    const v = r.type === '收入' ? toTWD(r) : r.type === '支出' ? -toTWD(r) : 0;
    if (!v) return;
    const k = r.date.slice(0, 7);
    netByMonth[k] = (netByMonth[k] || 0) + v;
  });
  const act = Object.keys(netByMonth).sort();
  if (!act.length) return '<p class="loading">沒有記錄</p>';
  const start = act.find(m => m > '2012-01') || act[0];

  const nowM = today().slice(0, 7);
  const seq = [];
  for (let m = start; m <= nowM; m = shiftMonth(m, 1)) seq.push(m);
  let acc = anchor;
  const assetAt = {};
  for (let i = seq.length - 1; i >= 0; i--) {
    assetAt[seq[i]] = acc;
    acc -= netByMonth[seq[i]] || 0;
  }

  // 每年 1 月標年份（'19），其餘留空由 lineChartHTML 略過
  const points = seq.map(m => ({ label: m.endsWith('-01') ? `'${m.slice(2, 4)}` : '', v: assetAt[m] }));
  const first = points[0].v, last = points[points.length - 1].v;
  return `
    <div class="totals">
      <div><span>${start.replace('-', ' 年 ')} 月</span><b>${fmtMoney(first)}</b></div>
      <div><span>目前</span><b>${fmtMoney(last)}</b></div>
      <div><span>增減</span><b class="${last - first < 0 ? 'neg' : 'pos'}">${fmtMoney(last - first)}</b></div>
    </div>
    ${lineChartHTML(points)}
    <p class="hint">以目前結餘（外幣依即期匯率折算）扣回各月收支推算月底資產。</p>`;
}

// 全期間支出趨勢：每年一根長條（逐月上百根擠不下）。2012-01-01 期初/校正 sentinel 不計
function expenseAllHTML(records) {
  const sums = {};
  records.forEach(r => {
    if (r.type !== '支出' || r.date === '2012-01-01') return;
    const y = r.date.slice(0, 4);
    sums[y] = (sums[y] || 0) + toTWD(r);
  });
  const years = Object.keys(sums).sort();
  if (!years.length) return '<p class="loading">沒有支出記錄</p>';
  const nowY = today().slice(0, 4);
  const seq = [];
  for (let y = Number(years[0]); y <= Number(nowY); y++) seq.push(String(y));
  const points = seq.map(y => ({ label: `'${y.slice(2)}`, v: -(sums[y] || 0) }));
  const total = points.reduce((s, p) => s + p.v, 0);
  const past = seq.filter(y => y < nowY);
  const avgRow = past.length
    ? `<div><span>年平均（不含今年）</span><b class="neg">${fmtMoney(past.reduce((s, y) => s - (sums[y] || 0), 0) / past.length)}</b></div>`
    : '';
  return `
    <div class="totals">
      <div><span>全期間支出</span><b class="neg">${fmtMoney(total)}</b></div>
      ${avgRow}
    </div>
    ${barChartHTML(points)}
    <p class="hint">今年是 1 月至今的累計，非完整年度。</p>`;
}

// 資產配置（市值快照）：券商帳戶（出現在持倉帳戶欄的）以持倉市值計，其餘帳戶以餘額計併成「現金」桶；
// 桶別 = 持倉分頁桶別欄的自由文字（改 Sheet 就改分類）；美股標的（代號字母開頭）以 USD 匯率折算。
// 無報價（現價 0/#N/A）的標的不計入，列在下方提示——持倉分頁 G 欄手動填價格即可補上
function allocHTML(balances, shares) {
  const holdings = (config && config.holdings) || [];
  const items = holdings.map((h, i) => ({ h, shares: shares[i], value: holdingValue(h, shares[i]) }));
  const brokers = new Set(holdings.map(h => h.account).filter(Boolean));
  const cash = balances.filter(b => !brokers.has(b.name))
    .reduce((s, b) => s + b.balance * rateOf(b.currency), 0);

  const groups = new Map();
  if (cash) groups.set('現金', { total: cash, items: [] });
  items.forEach(it => {
    if (it.value === null || !it.shares) return;
    const k = it.h.bucket || '未分類';
    if (!groups.has(k)) groups.set(k, { total: 0, items: [] });
    const g = groups.get(k);
    g.total += it.value;
    g.items.push(it);
  });
  const rows = [...groups.entries()].filter(([, g]) => g.total > 0).sort((a, b) => b[1].total - a[1].total);
  const total = rows.reduce((s, [, g]) => s + g.total, 0);
  const noPrice = items.filter(it => it.value === null && it.shares > 0);
  if (!rows.length) return '<p class="loading">沒有可計算的資產（檢查持倉分頁現價欄）</p>';

  let acc = 0;
  const segments = rows.map(([, g], i) => {
    const start = acc / total * 360;
    acc += g.total;
    return `${PALETTE[i % PALETTE.length]} ${start.toFixed(1)}deg ${(acc / total * 360).toFixed(1)}deg`;
  });

  return `
    <div class="totals">
      <div><span>資產總額（市值）</span><b class="pos">${fmtMoney(total)}</b></div>
    </div>
    <div class="donut" style="background:conic-gradient(${segments.join(',')})"><span>${fmtShort(total)}</span></div>
    <div class="record-list">${rows.map(([name, g], i) => `
      <div class="record cat-row" data-cat="${esc(name)}">
        <div class="rec-main">
          <span class="rec-cat"><i class="dot" style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(name)}</span>
          <span class="rec-amount">${fmtMoney(g.total)}<small class="pct">${(g.total / total * 100).toFixed(1)}%</small></span>
        </div>
        ${state.stats.expanded === name && g.items.length
          ? `<div class="sub-breakdown">${g.items.sort((a, b) => b.value - a.value).map(it =>
              `<div><span>${esc(it.h.ticker)} ${esc(it.h.name || '')}</span><span>${fmtShares(it.shares)} 股・${fmtMoney(it.value)}</span></div>`).join('')}</div>`
          : ''}
      </div>`).join('')}
    </div>
    ${noPrice.length ? `<p class="hint">無報價不計入：${noPrice.map(it => esc(it.h.ticker)).join('、')}（持倉分頁「現價」欄手動填數字即可）</p>` : ''}
    <p class="hint">券商帳戶以持倉市值計、其餘帳戶以餘額計；美股與外幣依即期匯率折算 TWD。與帳戶頁結餘的差額≈未實現損益。</p>`;
}

function lineChartHTML(points) {
  const w = 340, h = 180, padT = 18, padB = 20, padL = 12, padR = 12;
  const vs = points.map(p => p.v);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  min -= span * 0.08;
  max += span * 0.08;
  const x = i => padL + i * (w - padL - padR) / Math.max(points.length - 1, 1);
  const yv = v => padT + (max - v) / (max - min) * (h - padT - padB);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${yv(p.v).toFixed(1)}`).join(' ');
  const iLast = points.length - 1;
  const marked = [...new Set([vs.indexOf(Math.min(...vs)), vs.indexOf(Math.max(...vs)), iLast])];
  const dense = points.length > 24; // 全期間上百個月：只畫最低/最高/最新的圓點
  return `<div class="line-chart"><svg viewBox="0 0 ${w} ${h}">
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    ${points.map((p, i) => dense && !marked.includes(i) ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${yv(p.v).toFixed(1)}" r="${marked.includes(i) ? 3 : 2}" fill="var(--accent)"/>`).join('')}
    ${marked.map(i => `<text x="${x(i).toFixed(1)}" y="${(yv(points[i].v) - 7).toFixed(1)}" text-anchor="${i === 0 ? 'start' : i === iLast ? 'end' : 'middle'}" class="chart-val">${fmtShort(points[i].v)}</text>`).join('')}
    ${points.map((p, i) => p.label ? `<text x="${x(i).toFixed(1)}" y="${h - 5}" text-anchor="middle" class="chart-ax">${p.label}</text>` : '').join('')}
  </svg></div>`;
}

// ---------- 帳戶 ----------

async function renderAccounts() {
  if (state.accView) return renderAccountDetail();

  // 有持倉設定時頂部給「帳戶/持倉」tab 整頁切換（Robert 嫌捲到底下麻煩）；沒設定維持原樣
  const hasHold = ((config && config.holdings) || []).length > 0;
  const tab = hasHold ? state.accTab : 'accounts';
  $('#view').innerHTML = `
    ${hasHold
      ? `<div class="seg">${[['accounts', '帳戶'], ['holdings', '持倉']].map(([k, l]) =>
          `<button data-acctab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>`
      : `<div class="date-bar big">
          <span style="padding-left:12px">帳戶總覽</span>
        </div>`}
    <div id="acc-body">${balancesCache || tab === 'holdings' ? '' : spinnerHTML}</div>`;

  $('#view').querySelectorAll('[data-acctab]').forEach(b =>
    b.addEventListener('click', () => {
      if (state.accTab === b.dataset.acctab) return;
      state.accTab = b.dataset.acctab;
      renderAccounts();
    }));

  if (tab === 'holdings') {
    $('#acc-body').innerHTML = '<div id="hold-body"></div>';
    fillHoldings();
    return;
  }

  try {
    const balances = await fetchBalances();
    if (state.view !== 'accounts' || state.accView) return;

    const assets = balances.filter(b => b.balance > 0).reduce((s, b) => s + b.balance * rateOf(b.currency), 0);
    const debts = balances.filter(b => b.balance < 0).reduce((s, b) => s + b.balance * rateOf(b.currency), 0);

    const listed = balances.filter(b => b.show || b.balance !== 0);

    $('#acc-body').innerHTML = `
      <div class="totals">
        <div><span>總資產</span><b class="pos">${fmtMoney(assets)}</b></div>
        <div><span>總負債</span><b class="neg">${fmtMoney(debts)}</b></div>
        <div><span>結餘</span><b>${fmtMoney(assets + debts)}</b></div>
      </div>
      <div class="record-list">${listed.map(b => `
        <div class="record acc-row" data-name="${esc(b.name)}">
          <div class="rec-main">
            <span class="rec-cat">${withEmoji(b.name, 'account')}${b.currency !== 'TWD' ? `（${b.currency}）` : ''}</span>
            <span class="rec-amount ${b.balance < 0 ? 'neg' : 'pos'}">${fmtMoney(b.balance)}<span class="chev">›</span></span>
          </div>
        </div>`).join('')}
      </div>
      <p class="hint">總額中外幣依即期匯率折算為 TWD</p>`;

    $('#acc-body').querySelectorAll('.acc-row').forEach(el =>
      el.addEventListener('click', () => {
        state.accView = {
          name: el.dataset.name,
          mode: 'month',
          month: today().slice(0, 7),
          year: Number(today().slice(0, 4)),
        };
        renderAccounts();
      }));
  } catch (err) {
    if (!handleAuthError(err)) $('#acc-body').innerHTML = `<p class="loading">載入失敗：${err.message}</p>`;
  }
}

// ---------- 持倉（config.holdings：Sheet「持倉」分頁）----------

// 備註格式「標的 股數股」：標的與股數之間要有空格，賣出記負數（0050 1000股、0050 -500股、VOO 3.5股）
const SHARE_RE = /([A-Za-z0-9]+)\s+([+-]?\d+(?:\.\d+)?)\s*股/g;

const fmtShares = n => masked ? '••••' : n.toLocaleString('en-US', { maximumFractionDigits: 4 });

// 市值 = 現價 × 股數；美股（代號字母開頭）以 USD 匯率折 TWD。無報價（現價 0/#N/A）回 null
const holdingValue = (h, shares) =>
  h.price > 0 ? shares * h.price * (/^\d/.test(h.ticker) ? 1 : rateOf('USD')) : null;

const holdingNote = (h, side) => `${h.ticker} ${side === '賣' ? '-' : ''}${h.shares}股`;

// 買賣從轉帳方向推導：轉入該標的的帳戶=買、轉出=賣（帳戶對照存持倉分頁「帳戶」欄，
// 同標的跨券商多列時逐列比對）。帳戶欄沒填或轉帳兩端都對不上 → 回 null，送出時擋下不猜方向
function holdingSide(ticker) {
  for (const h of (config.holdings || [])) {
    if (h.ticker !== ticker || !h.account) continue;
    if (state.to === h.account) return '買';
    if (state.from === h.account) return '賣';
  }
  return null;
}

// 持倉異動輸入（轉帳模式的「持倉」列）：選標的＋股數，送出時組「標的 股數股」進備註。
// UI 只是備註字串的產生器——儲存格式不變，直接手打備註同樣有效
function openHoldingSheet() {
  // 同標的多列（跨券商）在選單只出現一次——選的是標的，歸哪個券商由轉帳方向決定
  const hs = [];
  (config.holdings || []).forEach(h => { if (!hs.some(x => x.ticker === h.ticker)) hs.push(h); });
  let ticker = state.holding ? state.holding.ticker : null;
  openSheet(`
    <h3>持倉異動</h3>
    <div class="grid" id="hold-tickers">${hs.map(h =>
      `<button data-ticker="${esc(h.ticker)}" class="${h.ticker === ticker ? 'active' : ''}">${esc(h.ticker)}<br>${esc(h.name || '')}</button>`).join('')}</div>
    <div class="rows"><div class="row-item"><span class="row-label">股數</span>
      <input id="hold-shares" inputmode="decimal" placeholder="如 1000" value="${state.holding ? state.holding.shares : ''}"></div></div>
    <div class="sheet-actions">
      <button id="hold-clear">清除</button>
      <button id="hold-ok">確定</button>
    </div>
    <p class="hint">買賣由轉帳方向自動判斷：轉入標的帳戶＝買、轉出＝賣</p>`);

  $('#hold-tickers').querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => {
      ticker = b.dataset.ticker;
      $('#hold-tickers').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    }));
  $('#hold-clear').addEventListener('click', () => { state.holding = null; closeSheet(); renderAdd(); });
  $('#hold-ok').addEventListener('click', () => {
    const shares = parseFloat($('#hold-shares').value);
    if (!ticker) return toast('請選擇標的', true);
    if (!(shares > 0)) return toast('請輸入股數', true);
    state.holding = { ticker, shares };
    closeSheet();
    renderAdd();
  });
}

// 現有股數 = 基準股數 + 基準日之後備註符合格式的記錄加總——每次從 m: 月快取重算，
// 編輯/刪除自動正確；新標的要先在「持倉」分頁加一列再 ⚙️ 重新整理。
// 同一標的跨券商 = 多列（帳戶欄不同），每筆異動依轉帳碰到的帳戶歸戶；
// 歸不了戶（多列但轉帳兩端都對不上）就略過不計，寧可少算也不記錯列。
// 撈取窗口多看 14 天：記在未來日的買賣（如 T+2 記交割日）也要計入，與餘額/明細行為一致
async function computeHoldingShares() {
  const holdings = (config && config.holdings) || [];
  const from = holdings.map(h => h.baseDate || today()).sort()[0];
  const to = shiftDate(today(), 14);
  let records = [];
  try {
    if (from < to) records = await fetchSpanRecords(shiftDate(from, 1), to);
  } catch (_) { /* 撈不到就只用基準股數 */ }

  const shares = holdings.map(h => h.baseShares);
  records.forEach(r => {
    if (!r.note) return;
    for (const m of r.note.matchAll(SHARE_RE)) {
      const rows = holdings.map((h, i) => [h, i]).filter(([h]) => h.ticker === m[1].toUpperCase());
      if (!rows.length) continue;
      const hit = rows.length === 1 ? rows[0]
        : rows.find(([h]) => h.account && (h.account === r.from || h.account === r.to));
      if (hit && r.date > (hit[0].baseDate || today())) shares[hit[1]] += Number(m[2]);
    }
  });
  return shares;
}

async function fillHoldings() {
  const holdings = (config && config.holdings) || [];
  if (!holdings.length || !$('#hold-body')) return;
  $('#hold-body').innerHTML = spinnerHTML;

  const shares = await computeHoldingShares();
  const box = $('#hold-body');
  if (state.view !== 'accounts' || state.accView || !box) return;

  const dup = t => holdings.filter(h => h.ticker === t).length > 1;
  const totalVal = holdings.reduce((s, h, i) => s + (holdingValue(h, shares[i]) || 0), 0);
  box.innerHTML = `
    ${totalVal ? `<div class="totals">
      <div><span>持倉市值</span><b class="pos">${fmtMoney(totalVal)}</b></div>
    </div>` : ''}
    <div class="record-list">${holdings.map((h, i) => {
      const sub = [h.bucket, dup(h.ticker) ? h.account : ''].filter(Boolean).join('・');
      const val = holdingValue(h, shares[i]);
      return `
      <div class="record hold-row">
        <div class="rec-main">
          <span class="rec-cat">${esc(h.ticker)}${h.name ? `<small>${esc(h.name)}</small>` : ''}</span>
          <span class="hold-nums">
            <span class="rec-amount">${fmtShares(shares[i])} 股</span>
            ${val !== null ? `<small class="hold-val">${fmtMoney(val)}</small>` : ''}
          </span>
          <button class="div-btn" data-hi="${i}" title="記股息">💰</button>
        </div>
        ${sub ? `<div class="rec-sub"><span>${esc(sub)}</span></div>` : ''}
      </div>`;
    }).join('')}
    </div>
    <p class="hint">市值＝現價 × 股數，外幣依即期匯率折算 TWD；無報價的標的只顯示股數（持倉分頁「現價」欄手動填數字即可）</p>`;

  box.querySelectorAll('.div-btn').forEach(b =>
    b.addEventListener('click', () => startDividend(holdings[Number(b.dataset.hi)])));
}

// 持倉列 💰：帶入股息的新增畫面（收入、上次記股息的分類、該標的上次用的帳戶、備註「標的 股息」），
// 金額自己打、按 OK 才送出。分類/帳戶不寫死（名稱不進 public repo）：存 mb_div，
// 第一次自己選、送出成功記回；帳戶按標的記（台股股息入交割戶、美股留券商，互不干擾）。
// 備註「股息」二字不含數字+股，SHARE_RE 不會誤算股數
function startDividend(h) {
  const div = safeParse('mb_div', '{}');
  state.type = '收入';
  resetEntry();
  if (div.category && config.categories.some(c =>
    c.type === '收入' && c.category === div.category && c.sub === div.sub)) {
    state.category = div.category;
    state.sub = div.sub;
  } else {
    // 第一次（或分類已被改掉）：清掉「上次收入」殘留，強制明確選一次，別讓股息掛在薪資下
    state.category = null;
    state.sub = null;
    state.account = '';
  }
  const acct = (div.accounts || {})[h.ticker];
  if (acct && config.accounts.some(a => a.name === acct)) {
    state.account = acct;
    state.lockedAccount = acct; // 選分類時不被該分類的預設帳戶蓋掉
  } else if (state.category) {
    state.account = defaultAccountFor('收入', state.category, state.sub);
  }
  state.note = `${h.ticker} 股息`;
  state.divTicker = h.ticker;
  state.view = 'add';
  render();
}

// ---------- 帳戶明細 ----------

function accountDelta(r, name) {
  if (r.type === '轉帳') {
    if (r.from === name) return -r.amount;
    if (r.to === name) return r.toAmount || r.amount;
    return 0;
  }
  if (r.type === '支出' && r.from === name) return -r.amount;
  if (r.type === '收入' && r.to === name) return r.amount;
  return 0;
}

async function renderAccountDetail() {
  const av = state.accView;
  const card = cardOf(av.name);
  if (av.mode === 'bill' && !card) av.mode = 'month'; // 卡設定被移除時退回月模式
  const isBill = av.mode === 'bill';
  const bill = isBill ? billRange(card, av.month) : null;
  const label = isBill ? `${fmtMD(bill.from)} ～ ${fmtMD(bill.to)}`
    : av.mode === 'month' ? `${av.month.replace('-', ' 年 ')} 月` : `${av.year} 年`;
  const modes = [['month', '月'], ...(card ? [['bill', '帳單']] : []), ['year', '年']];

  $('#view').innerHTML = `
    <div class="date-bar big">
      <button id="acc-back">‹</button>
      <span>${withEmoji(av.name, 'account')}</span>
      <span class="bar-spacer"></span>
    </div>
    <div class="seg">${modes.map(([k, l]) =>
      `<button data-accmode="${k}" class="${av.mode === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="date-bar big">
      <button id="accd-prev">‹</button>
      <span id="accd-label" title="點一下回到現在">${label}</span>
      <button id="accd-next">›</button>
    </div>
    <div id="accd-body">${spinnerHTML}</div>
    <button id="acc-add" class="fab" title="用這個帳戶記一筆">✏️</button>`;

  $('#acc-back').addEventListener('click', () => { state.accView = null; renderAccounts(); });
  $('#view').querySelectorAll('[data-accmode]').forEach(b =>
    b.addEventListener('click', () => {
      const mode = b.dataset.accmode;
      if (mode === av.mode) return;
      const prev = av.mode;
      av.mode = mode;
      if (mode === 'year') av.year = Number(av.month.slice(0, 4));
      else if (prev === 'year') {
        av.month = av.year === Number(today().slice(0, 4))
          ? (mode === 'bill' ? currentBillMonth(card) : today().slice(0, 7))
          : `${av.year}-01`;
      } // 月 ↔ 帳單互切保留 av.month（帳單模式把它當「結帳月」用）
      renderAccountDetail();
    }));
  $('#accd-prev').addEventListener('click', () => {
    if (av.mode === 'year') av.year -= 1;
    else av.month = shiftMonth(av.month, -1);
    renderAccountDetail();
  });
  $('#accd-next').addEventListener('click', () => {
    if (av.mode === 'year') av.year += 1;
    else av.month = shiftMonth(av.month, 1);
    renderAccountDetail();
  });
  $('#accd-label').addEventListener('click', () => {
    if (av.mode === 'year') av.year = Number(today().slice(0, 4));
    else if (isBill) av.month = currentBillMonth(card);
    else av.month = today().slice(0, 7);
    renderAccountDetail();
  });
  $('#acc-add').addEventListener('click', () => {
    resetEntry();
    state.lockedAccount = av.name;
    if (state.type === '轉帳') state.from = av.name;
    else state.account = av.name;
    state.view = 'add';
    render();
  });

  const from = isBill ? bill.from : av.mode === 'month' ? `${av.month}-01` : `${av.year}-01-01`;
  const end = isBill ? bill.to : av.mode === 'month' ? monthEnd(av.month) : `${av.year}-12-31`;
  const fetchTo = end > today() ? end : today();
  const snap = JSON.stringify(av);

  try {
    const [all, balances] = await Promise.all([fetchSpanRecords(from, fetchTo), fetchBalances()]);
    if (state.view !== 'accounts' || !state.accView || JSON.stringify(state.accView) !== snap) return;

    const acct = balances.find(b => b.name === av.name) || { balance: 0, currency: 'TWD' };
    // 從目前餘額往回走，得出每筆之後的餘額與上期累計
    let run = acct.balance;
    const items = [];
    all.forEach(r => {
      const d = accountDelta(r, av.name);
      if (!d) return;
      const item = { r, d, run };
      run -= d;
      if (r.date <= end) items.push(item);
    });
    items.forEach((item, n) => (item.n = n));
    const prevBal = run;
    const inflow = items.reduce((s, i) => s + (i.d > 0 ? i.d : 0), 0);
    const outflow = items.reduce((s, i) => s + (i.d < 0 ? i.d : 0), 0);

    // 帳單模式：結帳餘額 = 期初 + 期間淨變動（記錄推移算出，非目前餘額），應繳 = 其負數（全額繳清）
    const endBal = prevBal + inflow + outflow;
    const due = Math.round(-endBal * 100) / 100;
    const payDate = isBill ? billPayDate(card, av.month) : '';
    // 結帳日後、下期結帳日前已有進卡的轉帳 = 這期繳過了，改顯示已繳提示避免重複產生
    const paid = isBill ? all.find(r => r.type === '轉帳' && r.to === av.name
      && (!card.payFrom || r.from === card.payFrom)
      && r.date > end && r.date <= clampDay(shiftMonth(av.month, 1), card.closeDay)) : null;

    const groups = [];
    items.forEach(item => {
      const last = groups[groups.length - 1];
      if (last && last.date === item.r.date) last.items.push(item);
      else groups.push({ date: item.r.date, items: [item] });
    });

    $('#accd-body').innerHTML = `
      <div class="totals">
        ${isBill
          ? `<div><span>結帳餘額</span><b class="${endBal < 0 ? 'neg' : 'pos'}">${fmtMoney(endBal)}</b></div>
             <div><span>繳費日</span><b>${fmtMD(payDate)}</b></div>`
          : `<div><span>目前餘額</span><b class="${acct.balance < 0 ? 'neg' : 'pos'}">${fmtMoney(acct.balance)}</b></div>
             <div><span>累計至上期</span><b>${fmtMoney(prevBal)}</b></div>`}
        <div><span>期間收入</span><b class="pos">${fmtMoney(inflow)}</b></div>
        <div><span>期間支出</span><b class="neg">${fmtMoney(outflow)}</b></div>
      </div>
      ${!isBill ? '' : paid
        ? `<p class="hint">✓ ${fmtMD(paid.date)} 已繳 ${fmtMoney(paid.amount)}（${esc(paid.from)}）</p>`
        : due > 0 && card.payFrom && end < today()
          ? `<button id="bill-pay" class="empty-add">💸 產生繳費轉帳 ${fmtMoney(due)}</button>`
          : ''}
      ${items.length === 0
        ? '<p class="loading">這段期間沒有這個帳戶的記錄</p>'
        : groups.map(g => {
            const net = g.items.reduce((s, i) => s + i.d, 0);
            return `
              <div class="day-head"><span>${dateLabel(g.date)}</span><span class="${net < 0 ? 'neg' : 'pos'}">${fmtMoney(net)}</span></div>
              <div class="record-list">${g.items.map(i => {
                const r = i.r;
                const isTransfer = r.type === '轉帳';
                const catText = isTransfer
                  ? esc(`🔄 ${r.from} → ${r.to}`)
                  : `${emojiFor(r.category)} ${esc(r.category)}${r.sub ? ` - ${subEmojiFor(r.category, r.sub)} ${esc(r.sub)}` : ''}`;
                return `<div class="record accd-rec" data-i="${i.n}">
                  <div class="rec-main">
                    <span class="rec-cat">${catText}</span>
                    <span class="rec-amount ${i.d < 0 ? 'neg' : 'pos'}">${fmtMoney(i.d)}<small class="runbal">》${fmtMoney(i.run)}</small></span>
                  </div>
                  ${r.note || r.tags ? `<div class="rec-sub"><span>${esc([r.note, r.tags].filter(Boolean).join('　#'))}</span></div>` : ''}
                </div>`;
              }).join('')}</div>`;
          }).join('')}
      <div class="fab-spacer"></div>`;

    $('#accd-body').querySelectorAll('.accd-rec').forEach(el =>
      el.addEventListener('click', () => openRecordSheet(items[Number(el.dataset.i)].r)));

    const payBtn = $('#bill-pay');
    if (payBtn) payBtn.addEventListener('click', () => {
      resetEntry();
      state.type = '轉帳';
      state.from = card.payFrom;
      state.to = av.name;
      state.expr = String(due);
      state.date = payDate;
      state.note = `${av.month} 帳單`;
      state.view = 'add';
      render();
    });
  } catch (err) {
    if (!handleAuthError(err)) $('#accd-body').innerHTML = `<p class="loading">載入失敗：${err.message}</p>`;
  }
}

// ---------- Sheets（彈出選單）----------

function openSheet(html, cls) {
  const card = $('#sheet-content');
  card.className = 'sheet-card' + (cls ? ` ${cls}` : '');
  card.innerHTML = html;
  $('#sheet').classList.remove('hidden');
}

function closeSheet() {
  $('#sheet').classList.add('hidden');
}

$('#sheet').addEventListener('click', e => {
  if (e.target.id !== 'sheet') return;
  closeSheet();
  // 標籤 sheet 可能已改了 state.tags，點背景關閉也要讓新增頁的標籤列同步
  if (state.view === 'add') renderAdd();
});

function openCategorySheet() {
  renderCategorySheet(state.category);
}

function renderCategorySheet(cat) {
  const cats = categoriesOf(state.type);
  if (cat && !cats.includes(cat)) cat = null;

  if (!cat) {
    openSheet(`
      <h3>分類</h3>
      <div class="grid" id="sheet-cats">${cats.map(c =>
        `<button data-cat="${esc(c)}" class="${c === state.category ? 'active' : ''}">${emojiFor(c)}<br>${esc(c)}</button>`).join('')}</div>`);
    $('#sheet-cats').querySelectorAll('button').forEach(b =>
      b.addEventListener('click', () => renderCategorySheet(b.dataset.cat)));
    return;
  }

  openSheet(`
    <button class="cat-picked" id="cat-change">${emojiFor(cat)} ${esc(cat)}<span class="swap">更換 ›</span></button>
    <div class="grid" id="sheet-subs">${subsOf(state.type, cat).map(s =>
      `<button data-sub="${esc(s)}" class="${cat === state.category && s === state.sub ? 'active' : ''}">${subEmojiFor(cat, s)}<br>${esc(s)}</button>`).join('')}</div>`);
  $('#cat-change').addEventListener('click', () => renderCategorySheet(null));
  $('#sheet-subs').querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => {
      state.category = cat;
      state.sub = b.dataset.sub;
      state.account = state.lockedAccount || defaultAccountFor(state.type, cat, state.sub);
      saveEntryDefaults();
      closeSheet();
      renderAdd();
    }));
}

function openAccountSheet(onPick) {
  openSheet(`
    <h3>帳戶</h3>
    <div class="account-list">${visibleAccounts().map(a =>
      `<button data-name="${esc(a.name)}">${withEmoji(a.name, 'account')}${a.currency !== 'TWD' ? `（${a.currency}）` : ''}</button>`).join('')}
    </div>`);
  $('#sheet-content').querySelectorAll('[data-name]').forEach(b =>
    b.addEventListener('click', () => { closeSheet(); onPick(b.dataset.name); }));
}

// 全文搜尋：備註/分類/子分類/帳戶/標籤模糊比對、純數字另比對金額完全相等；點結果開明細（可編輯/刪除）
function openSearchSheet() {
  // tall：撐滿固定高度，輸入框停在畫面上緣附近，iOS 鍵盤彈出才不會蓋住它
  openSheet(`
    <h3>搜尋記錄</h3>
    <input id="search-input" placeholder="備註 / 分類 / 帳戶 / 標籤 / 金額" enterkeyhint="search">
    <div id="search-results" class="record-list"></div>`, 'tall');
  const input = $('#search-input');

  const run = async () => {
    const q = input.value.trim().toLowerCase();
    const box = $('#search-results');
    if (!box) return;
    if (!q) { box.innerHTML = ''; return; }
    if (!allRecords) box.innerHTML = spinnerHTML;
    let all;
    try {
      all = await fetchAllRecords();
    } catch (err) {
      if (!handleAuthError(err)) box.innerHTML = `<p class="loading">載入失敗：${err.message}</p>`;
      return;
    }
    if (!document.contains(box) || input.value.trim().toLowerCase() !== q) return; // 只認最後一次輸入

    const hits = all.filter(r =>
      [r.category, r.sub, r.note, r.tags, r.from, r.to].some(f => String(f || '').toLowerCase().includes(q))
      || String(r.amount) === q);
    if (!hits.length) {
      box.innerHTML = '<p class="loading">沒有符合的記錄</p>';
      return;
    }
    const ex = hits.filter(r => r.type === '支出').reduce((s, r) => s + toTWD(r), 0);
    const inc = hits.filter(r => r.type === '收入').reduce((s, r) => s + toTWD(r), 0);
    box.innerHTML = `
      <p class="hint">${hits.length} 筆・支出 ${fmtMoney(ex)}・收入 ${fmtMoney(inc)}</p>
      ${hits.slice(0, 50).map((r, i) => {
        const isExpense = r.type === '支出';
        const isTransfer = r.type === '轉帳';
        return `<div class="record" data-i="${i}">
          <div class="rec-main">
            <span class="rec-cat">${isTransfer ? '🔄 轉帳' : `${emojiFor(r.category)} ${esc(r.category)}${r.sub ? ` - ${esc(r.sub)}` : ''}`}</span>
            <span class="rec-amount ${isExpense ? 'neg' : isTransfer ? '' : 'pos'}">${r.currency !== 'TWD' ? `${r.currency} ` : ''}${fmtMoney(isExpense ? -r.amount : r.amount)}</span>
          </div>
          <div class="rec-sub">
            <span>${esc([r.note, r.tags].filter(Boolean).join('　#'))}</span>
            <span>${r.date}　${esc(isTransfer ? `${r.from} → ${r.to}` : (r.from || r.to))}</span>
          </div>
        </div>`;
      }).join('')}
      ${hits.length > 50 ? '<p class="hint">只顯示前 50 筆，加字縮小範圍</p>' : ''}`;
    box.querySelectorAll('.record').forEach(el =>
      el.addEventListener('click', () => openRecordSheet(hits[Number(el.dataset.i)])));
  };

  input.addEventListener('input', run);
  input.focus();
}

function openTagSheet() {
  const all = [...new Set([...(config.tags || []), ...state.customTags])];
  openSheet(`
    <h3>標籤</h3>
    <div class="chips" id="sheet-tags">${all.map(t =>
      `<button data-tag="${esc(t)}" class="${state.tags.has(t) ? 'active' : ''}">${esc(t)}</button>`).join('')}
      <input id="new-tag" placeholder="＋新標籤" enterkeyhint="done">
    </div>
    <button class="sheet-done" id="tags-done">完成</button>`);

  $('#sheet-tags').querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => {
      const t = b.dataset.tag;
      state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t);
      b.classList.toggle('active');
    }));
  $('#new-tag').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const t = e.target.value.trim();
    if (!t) return;
    // 後端以逗號串接標籤，含逗號的標籤讀回時會裂成多個
    if (t.includes(',')) return toast('標籤不能含逗號', true);
    state.customTags.push(t);
    saveCustomTags();
    state.tags.add(t);
    openTagSheet();
  });
  $('#tags-done').addEventListener('click', () => { closeSheet(); renderAdd(); });
}

// ---------- 功能說明（⚙️ 設定 → 📖）----------
// 文字全用通用詞，不放真實帳戶/分類名（app.js 在 public repo）

function openHelpSheet() {
  openSheet(`
    <h3>📖 功能說明</h3>
    <div class="help">
      <h4>📥 快速輸入</h4>
      <ul>
        <li><b>常用 chips</b>：新增頁類型下方的圓鈕，點一下帶入分類/帳戶/金額；金額 0 的只帶分類、不清掉已輸入的金額。清單在 Sheet 設定分頁 U:X 欄</li>
        <li><b>📋 捷徑帶入</b>：iPhone 捷徑（刷卡通知截圖 OCR）解析後放剪貼簿 → 開 app 點日期列的 📋 帶入，確認後按 OK 送出</li>
        <li><b>Siri 語音</b>：「嘿 Siri 記帳」→ 唸「分類 帳戶 金額」（如「吃飯 一二〇」），同樣經剪貼簿 → 📋 帶入</li>
        <li><b>補帳</b>：明細翻到哪一天，按「新增」或「＋記一筆」就帶那天的日期</li>
        <li><b>計算機</b>：支援 + − × ÷ 先乘除後加減；OK 第一次算出結果、第二次才送出</li>
      </ul>
      <h4>📈 投資</h4>
      <ul>
        <li><b>買賣輸入</b>：轉帳（交割戶↔券商）時用「持倉」列選標的＋股數，買/賣由轉帳方向自動判斷。等同在備註寫「0050 1000股」（賣出寫負數），手打也有效</li>
        <li><b>股息 💰</b>：帳戶頁持倉 tab 每列的 💰，帶入收入與備註；第一次自選分類/入帳帳戶，之後每檔標的都記住</li>
        <li><b>股數</b> = 持倉分頁的基準股數＋之後的備註累計；新標的先在 Sheet 持倉分頁加一列再「重新整理資料」</li>
        <li><b>資產配置</b>：統計「總覽」的市值快照；現價抓不到的標的在持倉分頁 G 欄手動填數字</li>
      </ul>
      <h4>💳 信用卡</h4>
      <ul>
        <li>帳戶明細的「帳單」模式：期間照結帳日切、顯示結帳餘額與繳費日；已結帳未繳時 💸 一鍵產生繳費轉帳（按 OK 才送出）。卡片設定在 Sheet 設定分頁 Z:AC 欄</li>
      </ul>
      <h4>🔁 週期記帳</h4>
      <ul>
        <li>Sheet「週期」分頁編輯規則（每月/每週/每年），每天凌晨自動生成到期的記錄——只生成到期的，未來的不會預先入帳；隔天開 app 背景自動更新</li>
      </ul>
      <h4>🔍 查詢與統計</h4>
      <ul>
        <li><b>搜尋</b>：明細頁 🔍，模糊比對分類/備註/帳戶/標籤；輸入純數字＝找金額完全相等的記錄；點結果可直接編輯</li>
        <li><b>月曆</b>：明細頁 📅，每日收支小計、點日期跳該日</li>
        <li><b>橫滑</b>：明細/統計/帳戶明細左右滑＝換日/月/年；期間標籤點一下回到今天/本月/本年</li>
        <li><b>圓環互動</b>：點分類展開子分類（年模式再多 12 個月長條）；⊘ 暫時排除該分類；標籤 chip 過濾統計</li>
        <li><b>總覽</b>：資產配置＋全期間資產/支出趨勢，與期間無關</li>
      </ul>
      <h4>✏️ 記錄操作</h4>
      <ul>
        <li>點任一筆記錄：編輯／複製（建新的一筆、日期改今天）／刪除（點兩次確認）</li>
        <li>帳戶明細的 ✏️ 會鎖定該帳戶（📌），選分類不會被預設帳戶蓋掉</li>
        <li>直接在 Sheet 手動加的列沒有「記錄時間」，app 無法編輯它</li>
      </ul>
      <h4>⚙️ 其他</h4>
      <ul>
        <li>🏦 管理帳戶：新增帳戶、切換顯示/隱藏（改名與排序仍到 Sheet）</li>
        <li>直接改 Sheet（帳戶、分類、emoji、chips、持倉、卡片…）後，要按「重新整理資料」才會生效</li>
        <li>🙈 遮蔽金額：demo 給別人看時用，只遮數字、其他照常</li>
        <li>跨幣別轉帳會多出「入帳金額」欄，兩邊金額都自己填</li>
      </ul>
    </div>`, 'tall');
}

// ---------- 管理帳戶（⚙️ 設定 → 🏦）----------
// 只做新增與顯示/隱藏切換（設定 A:C）；改名/排序/刪除仍留在 Sheet

function openAccountsSheet() {
  const accts = (config && config.accounts) || [];
  openSheet(`
    <h3>🏦 管理帳戶</h3>
    <div class="rows">
      <div class="row-item"><span class="row-label">名稱</span>
        <input id="acct-new-name" placeholder="新帳戶名稱"></div>
      <div class="row-item"><span class="row-label">幣別</span>
        <input id="acct-new-cur" value="TWD"></div>
    </div>
    <div class="sheet-actions"><button id="acct-add">新增帳戶</button></div>
    <div class="record-list">${accts.map(a => `
      <div class="record acct-manage-row${a.show ? '' : ' off'}">
        <div class="rec-main">
          <span class="rec-cat">${withEmoji(a.name, 'account')}${a.currency !== 'TWD' ? `（${esc(a.currency)}）` : ''}</span>
          <button class="acct-toggle" data-name="${esc(a.name)}" data-show="${a.show ? 1 : 0}">${a.show ? '顯示中' : '已隱藏'}</button>
        </div>
      </div>`).join('')}
    </div>
    <p class="hint">隱藏後，餘額不為 0 的帳戶仍會顯示在總覽（避免藏起還有錢的帳戶）；新帳戶排在最後，要調順序請到 Sheet 拖曳</p>`, 'tall');

  $('#acct-add').addEventListener('click', addAccount);
  $('#sheet-content').querySelectorAll('.acct-toggle').forEach(b =>
    b.addEventListener('click', () => toggleAccountShow(b.dataset.name, Number(b.dataset.show))));
}

async function addAccount() {
  const name = $('#acct-new-name').value.trim();
  // 轉大寫：rateOf/rates 的幣別鍵是大寫，小寫會 fallback 匯率 1 折算失真
  const currency = ($('#acct-new-cur').value.trim() || 'TWD').toUpperCase();
  if (!name) return toast('請輸入帳戶名稱', true);
  if ((config.accounts || []).some(a => a.name === name)) return toast('帳戶已存在', true);
  showBusy('新增中…');
  try {
    await apiPost({ action: 'addAccount', name, currency });
    config.accounts.push({ name, show: true, currency });
    localStorage.setItem('mb_config', JSON.stringify(config));
    if (balancesCache) { balancesCache.push({ name, show: true, currency, balance: 0 }); persistCaches(); }
    toast('已新增');
    openAccountsSheet();
    if (state.view === 'accounts' && !state.accView) renderAccounts();
  } catch (err) {
    if (!handleAuthError(err)) toast(`新增失敗：${err.message}`, true);
  } finally {
    hideBusy();
  }
}

async function toggleAccountShow(name, cur) {
  const show = cur ? 0 : 1;
  showBusy(show ? '顯示中…' : '隱藏中…');
  try {
    await apiPost({ action: 'setAccountShow', name, show });
    const a = (config.accounts || []).find(x => x.name === name);
    if (a) a.show = !!show;
    localStorage.setItem('mb_config', JSON.stringify(config));
    if (balancesCache) {
      const b = balancesCache.find(x => x.name === name);
      if (b) b.show = !!show;
      persistCaches();
    }
    openAccountsSheet();
    if (state.view === 'accounts' && !state.accView) renderAccounts();
  } catch (err) {
    if (!handleAuthError(err)) toast(`更新失敗：${err.message}`, true);
  } finally {
    hideBusy();
  }
}

// ---------- Token ----------

function showTokenScreen() {
  $('#token-input').value = '';
  syncMaskBtn();
  $('#token-screen').classList.remove('hidden');
}

function syncMaskBtn() {
  $('#mask-toggle').textContent = masked ? '👁 取消遮蔽（金額遮蔽中）' : '🙈 遮蔽金額（demo 用）';
}

async function saveToken() {
  const t = $('#token-input').value.trim();
  if (!t) return;
  localStorage.setItem('mb_token', t);
  $('#token-screen').classList.add('hidden');
  clearAllCaches();
  await init();
}

// ---------- Init ----------

// 橫滑換日/換月（明細、統計、帳戶明細）。
// 這個 touchstart listener 同時滿足 iOS Safari 需要任一 touchstart 才會觸發 :active 樣式的怪癖
let swipeStart = null;
document.addEventListener('touchstart', e => {
  swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });

document.addEventListener('touchend', e => {
  if (!swipeStart) return;
  const dx = e.changedTouches[0].clientX - swipeStart.x;
  const dy = e.changedTouches[0].clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
  if (!$('#sheet').classList.contains('hidden') || !$('#token-screen').classList.contains('hidden')) return;
  const dir = dx < 0 ? 1 : -1;
  if (state.view === 'list') {
    state.listDate = shiftDate(state.listDate, dir);
    renderList();
  } else if (state.view === 'stats' && state.stats.mode !== 'all') {
    const st = state.stats;
    if (st.mode === 'month') st.month = shiftMonth(st.month, dir);
    else st.year += dir;
    st.expanded = null;
    renderStats();
  } else if (state.view === 'accounts' && state.accView) {
    const av = state.accView;
    if (av.mode === 'year') av.year += dir;
    else av.month = shiftMonth(av.month, dir);
    renderAccountDetail();
  }
}, { passive: true });

document.querySelectorAll('#bottom-nav button[data-view]').forEach(b =>
  b.addEventListener('click', () => {
    // 明細頁翻到別的日期時按「新增」= 要補那天的帳，日期跟著帶過去；其他頁進來維持今天
    const fromList = state.view === 'list' && b.dataset.view === 'add';
    state.view = b.dataset.view;
    state.accView = null;
    state.lockedAccount = null;
    if (state.view === 'add') {
      resetEntry();
      if (fromList) state.date = state.listDate;
    }
    render();
  }));

$('#gear').addEventListener('click', showTokenScreen);
$('#token-save').addEventListener('click', saveToken);
$('#token-cancel').addEventListener('click', () => {
  if (token()) $('#token-screen').classList.add('hidden');
});
$('#mask-toggle').addEventListener('click', () => {
  masked = !masked;
  if (masked) localStorage.setItem('mb_mask', '1');
  else localStorage.removeItem('mb_mask');
  syncMaskBtn();
  if (token()) {
    $('#token-screen').classList.add('hidden');
    render();
  }
  toast(masked ? '金額已遮蔽，再進 ⚙️ 可取消' : '已取消遮蔽');
});
$('#help-open').addEventListener('click', () => {
  if (!token()) return; // 首次開啟還在輸入 token：sheet 會被 token 卡蓋住，先不動作
  $('#token-screen').classList.add('hidden');
  openHelpSheet();
});
$('#accounts-manage').addEventListener('click', () => {
  if (!token()) return;
  $('#token-screen').classList.add('hidden');
  openAccountsSheet();
});
$('#config-reload').addEventListener('click', async () => {
  if (!token()) return;
  $('#token-screen').classList.add('hidden');
  try {
    await fetchConfig();
    clearAllCaches();
    render();
    toast('已重新整理');
    warmCurrentYear();
  } catch (err) {
    if (!handleAuthError(err)) toast(`更新失敗：${err.message}`, true);
  }
});

function validateDefaults() {
  if (!config) return;
  if (state.category && !subsOf(state.type, state.category).includes(state.sub)) {
    state.category = null;
    state.sub = null;
  }
  if (state.account && !config.accounts.some(a => a.name === state.account)) state.account = '';
  if (state.category && !state.account) {
    state.account = state.lockedAccount || defaultAccountFor(state.type, state.category, state.sub);
  }
}

async function init() {
  if (!token()) return showTokenScreen();
  if (config) {
    validateDefaults();
    render();
  }
  refreshStaleMonths();
  try {
    await fetchConfig();
    validateDefaults();
    if (state.view === 'add') render();
    warmCurrentYear();
  } catch (err) {
    if (!handleAuthError(err) && !config) toast(`載入設定失敗：${err.message}`, true);
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

init();
