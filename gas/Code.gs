// token 存 Script Properties（Apps Script 專案設定 → 指令碼屬性 → 新增「TOKEN」）——
// repo 與貼上的 code 都不含秘密，之後貼新版整份蓋掉即可。屬性沒設時 TOKEN=null，所有請求都被擋
const TOKEN = PropertiesService.getScriptProperties().getProperty('TOKEN');
const TZ = 'Asia/Taipei';

// 入帳金額只在跨幣別轉帳時有值（轉入帳戶幣別的金額），放最後一欄避免動到既有資料
const RECORD_HEADERS = ['日期','類型','分類','子分類','金額','幣別','付款帳戶','收款帳戶','標籤','備註','記錄時間','入帳金額'];

// 首次 bootstrap 的範例資料。實際的帳戶/分類由 importOldData() 從匯入資料重建，或直接在「設定」分頁維護
const ACCOUNTS = [
  ['現金', 1, 'TWD'], ['銀行', 1, 'TWD'], ['信用卡', 1, 'TWD'],
];

const EXPENSE_CATEGORIES = {
  '餐飲': ['早餐', '午餐', '晚餐', '飲料'],
  '交通': ['大眾運輸', '油錢'],
  '生活': ['日用品'],
};

const INCOME_CATEGORIES = {
  '收入': ['薪資', '利息'],
};

function initSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // 只給全新試算表用——會清空「設定」重寫範例資料，誤跑會毀掉重建好的真實設定
  const cfg0 = ss.getSheetByName('設定');
  if (cfg0 && cfg0.getLastRow() > 10) {
    throw new Error('「設定」分頁已有資料，initSheets 只給全新試算表用（會清空設定）');
  }
  const rec = ss.getSheetByName('記錄') || ss.insertSheet('記錄');
  rec.getRange(1, 1, 1, RECORD_HEADERS.length).setValues([RECORD_HEADERS]).setFontWeight('bold');
  rec.setFrozenRows(1);

  const cfg = ss.getSheetByName('設定') || ss.insertSheet('設定');
  cfg.clear();
  cfg.getRange(1, 1, 1, 3).setValues([['帳戶','顯示','幣別']]);
  cfg.getRange(2, 1, ACCOUNTS.length, 3).setValues(ACCOUNTS);

  const catRows = [];
  Object.entries(EXPENSE_CATEGORIES).forEach(([cat, subs]) =>
    subs.forEach(sub => catRows.push(['支出', cat, sub, ''])));
  Object.entries(INCOME_CATEGORIES).forEach(([cat, subs]) =>
    subs.forEach(sub => catRows.push(['收入', cat, sub, ''])));
  cfg.getRange(1, 5, 1, 4).setValues([['類型','分類','子分類','預設帳戶']]);
  cfg.getRange(2, 5, catRows.length, 4).setValues(catRows);

  cfg.getRange(1, 10).setValue('常用標籤');
  cfg.getRange(1, 1, 1, 10).setFontWeight('bold');
  cfg.setFrozenRows(1);
  initRates();
}

const RECUR_HEADERS = ['啟用', '頻率', '週期值', '類型', '分類', '子分類', '金額', '幣別', '付款帳戶', '收款帳戶', '標籤', '備註', '已生成至'];

// 在編輯器跑一次，建「週期」分頁。規則直接在 Sheet 編輯：
// 啟用=1、頻率=每月/每週/每年、週期值=每月幾號(1-31)/週幾(1=週一..7=週日)/MM-DD
function initRecurring() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('週期') || ss.insertSheet('週期');
  sh.getRange(1, 1, 1, RECUR_HEADERS.length).setValues([RECUR_HEADERS]).setFontWeight('bold');
  sh.getRange(1, 13, sh.getMaxRows(), 1).setNumberFormat('@');
  sh.setFrozenRows(1);
  if (sh.getLastRow() < 2) {
    sh.getRange(2, 1, 2, RECUR_HEADERS.length).setValues([
      [0, '每月', 5, '支出', '費用', '電信費', 599, 'TWD', '信用卡', '', '', '範例：啟用改 1 才會生效', ''],
      [0, '每月', 1, '收入', '收入', '薪資', 50000, 'TWD', '', '銀行', '', '範例：收入填收款帳戶', ''],
    ]);
  }
}

// 在編輯器跑一次：自動建立 processRecurring 的每日觸發條件（專案時區凌晨 1-2 點）
// 重跑會先刪掉舊的，不會重複。跑之前先到「專案設定」把時區改成台北，觸發時間才是台灣的凌晨
function initRecurringTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processRecurring')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processRecurring').timeBased().everyDays(1).atHour(1).create();
}

const BACKUP_FOLDER = '記帳備份';
const BACKUP_KEEP = 8;

// 在編輯器跑一次：建立每週自動備份的觸發條件（週日凌晨 3-4 點；重跑會先清舊的）。
// 第一次會要求 Drive 授權。備份與正本在同一個 Google 帳號——防的是資料被弄壞，不防帳號出事
function initBackupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'backupSpreadsheet')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backupSpreadsheet').timeBased()
    .everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
}

// 整份試算表 copy 到雲端硬碟的備份資料夾，只留最近 BACKUP_KEEP 份（舊的移到垃圾桶）
function backupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + ' 備份 ' + stamp, folder);
  const files = [];
  const fit = folder.getFiles();
  while (fit.hasNext()) files.push(fit.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  files.slice(BACKUP_KEEP).forEach(f => f.setTrashed(true));
}

// 由「時間驅動觸發條件」每天執行一次（觸發條件 → processRecurring → 日計時器 → 凌晨 1-2 點）
// 只把「到期日 <= 今天」且尚未生成的記錄寫進「記錄」——日期沒到的記錄不存在，統計不會預先計入
function processRecurring() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('週期');
  if (!sh || sh.getLastRow() < 2) return;
  const rec = ss.getSheetByName('記錄');
  const todayStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, RECUR_HEADERS.length).getValues();
  let seq = 0;

  rows.forEach((row, i) => {
    const enabled = row[0], freq = String(row[1]), spec = String(row[2]);
    const type = row[3], cat = row[4], sub = row[5], amount = Number(row[6]);
    const currency = row[7], from = row[8], to = row[9], tags = row[10], note = row[11];
    const genUntil = row[12] instanceof Date
      ? Utilities.formatDate(row[12], TZ, 'yyyy-MM-dd')
      : String(row[12] || '');
    if (enabled != 1 || !amount || !type) return;

    // 已生成至空白 = 從今天開始（不回補歷史，避免一啟用就灌一堆舊記錄）
    let d;
    if (genUntil) {
      const p = genUntil.split('-').map(Number);
      d = new Date(p[0], p[1] - 1, p[2] + 1);
    } else {
      const p = todayStr.split('-').map(Number);
      d = new Date(p[0], p[1] - 1, p[2]);
    }

    for (let guard = 0; guard < 400; guard++) {
      const ds = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
      if (ds > todayStr) break;
      if (recurDue(freq, spec, d)) {
        seq++;
        appendRecord(rec, [ds, type, cat || '', sub || '', amount, currency || 'TWD', from || '', to || '',
          tags || '', note || '',
          Utilities.formatDate(new Date(Date.now() + seq * 1000), TZ, 'yyyy-MM-dd HH:mm:ss'), '']);
      }
      d.setDate(d.getDate() + 1);
    }
    sh.getRange(i + 2, 13).setValue(todayStr);
  });
}

function recurDue(freq, spec, d) {
  if (freq === '每月') {
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return d.getDate() === Math.min(Number(spec), lastDay);
  }
  if (freq === '每週') return ((d.getDay() + 6) % 7) + 1 === Number(spec);
  if (freq === '每年') {
    return spec === String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  return false;
}

// 在編輯器跑一次，建「餘額」分頁：公式即時計算各帳戶餘額（含入帳金額 fallback 與 TWD 折算），開表即看、零維護
function initBalanceSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('餘額') || ss.insertSheet('餘額');
  sh.clear();
  sh.getRange(1, 1, 1, 4).setValues([['帳戶', '幣別', '餘額', '餘額(TWD)']]).setFontWeight('bold');
  sh.getRange('A2').setFormula('=FILTER(設定!A2:A, 設定!A2:A<>"")');
  sh.getRange('B2').setFormula('=FILTER(IF(設定!C2:C="", "TWD", 設定!C2:C), 設定!A2:A<>"")');
  sh.getRange('C2').setFormula(
    '=MAP(A2:A, LAMBDA(a, IF(a="",, ' +
    'SUMIFS(記錄!$E$2:$E, 記錄!$H$2:$H, a, 記錄!$L$2:$L, "=") ' +
    '+ SUMIFS(記錄!$L$2:$L, 記錄!$H$2:$H, a, 記錄!$L$2:$L, "<>") ' +
    '- SUMIF(記錄!$G$2:$G, a, 記錄!$E$2:$E))))');
  sh.getRange('D2').setFormula(
    '=MAP(B2:B, C2:C, LAMBDA(cur, bal, IF(cur="",, bal * IFERROR(VLOOKUP(cur, 設定!$L:$M, 2, FALSE), 1))))');
  sh.getRange('F1').setValue('結餘(TWD)').setFontWeight('bold');
  sh.getRange('F2').setFormula('=SUM(D2:D)');
  sh.setFrozenRows(1);
}

// 已有的試算表只要在編輯器跑一次這個函式，L:M 欄就會有自動更新的匯率
function initRates() {
  const cfg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
  cfg.getRange(1, 12, 1, 2).setValues([['幣別', '匯率(對TWD)']]).setFontWeight('bold');
  ['USD', 'JPY', 'HKD', 'CNY'].forEach((c, i) => {
    cfg.getRange(2 + i, 12).setValue(c);
    cfg.getRange(2 + i, 13).setFormula('=GOOGLEFINANCE("CURRENCY:' + c + 'TWD")');
  });
}

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  if (d.token !== TOKEN) return json({ ok: false, error: 'unauthorized' });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('記錄');

  if (d.action === 'delete') {
    const row = findRowByTs(sheet, d.ts);
    if (!row) return json({ ok: false, error: 'record not found' });
    sheet.deleteRow(row);
    return json({ ok: true });
  }

  // 帳戶維護只動「設定」A:C（名稱/顯示/幣別）；改名/排序仍留 Sheet
  if (d.action === 'addAccount') {
    const cfg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
    const name = String(d.name || '').trim();
    if (!name) return json({ ok: false, error: 'name required' });
    if (accountRowByName(cfg, name)) return json({ ok: false, error: 'account exists' });
    const row = lastAccountRow(cfg) + 1;
    if (cfg.getMaxRows() < row) cfg.insertRowsAfter(cfg.getMaxRows(), 1);
    cfg.getRange(row, 1).setNumberFormat('@'); // 擋 = 開頭的公式注入
    cfg.getRange(row, 1, 1, 3).setValues([[name, 1, String(d.currency || 'TWD').trim() || 'TWD']]);
    return json({ ok: true });
  }

  if (d.action === 'setAccountShow') {
    const cfg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
    const row = accountRowByName(cfg, String(d.name || '').trim());
    if (!row) return json({ ok: false, error: 'account not found' });
    cfg.getRange(row, 2).setValue(Number(d.show) ? 1 : 0);
    return json({ ok: true });
  }

  const now = new Date();
  const values = [
    d.date || Utilities.formatDate(now, TZ, 'yyyy-MM-dd'),
    d.type,
    d.category || '',
    d.sub || '',
    Number(d.amount),
    d.currency || 'TWD',
    d.from || '',
    d.to || '',
    (d.tags || []).join(','),
    d.note || '',
    Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm:ss'),
    d.toAmount ? Number(d.toAmount) : '',
  ];

  if (d.action === 'update') {
    const row = findRowByTs(sheet, d.ts);
    if (!row) return json({ ok: false, error: 'record not found' });
    values[10] = d.ts;
    setRowTextFormats(sheet, row);
    sheet.getRange(row, 1, 1, values.length).setValues([values]);
    return json({ ok: true, ts: d.ts });
  }

  // 新記錄不帶 action；未知 action 若 fall through 會塞一筆垃圾記錄（前端已更新但 GAS 未重新部署時）
  if (d.action) return json({ ok: false, error: 'unknown action' });

  appendRecord(sheet, values);
  // 回傳記錄時間（app 的唯一鍵），前端拿它就地修補快取，不用整月重撈
  return json({ ok: true, ts: values[10] });
}

// importOldData 的純文字格式只涵蓋當時的列數，之後 append 的列落在範圍外會被自動解析：
// 記錄時間字串一變成 Date，讀回就吃美國時區偏移，和 doPost 回給前端的 ts 對不上
// （剛新增就編輯/刪除會 record not found）。寫入前先設純文字，順帶擋 = 開頭的公式注入
function appendRecord(sheet, values) {
  const row = sheet.getLastRow() + 1;
  if (sheet.getMaxRows() < row) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
  setRowTextFormats(sheet, row);
  sheet.getRange(row, 1, 1, values.length).setValues([values]);
}

function setRowTextFormats(sheet, row) {
  sheet.getRange(row, 1).setNumberFormat('@');       // 日期
  sheet.getRange(row, 9, 1, 3).setNumberFormat('@'); // 標籤、備註、記錄時間
}

function findRowByTs(sheet, ts) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || !ts) return 0;
  const col = sheet.getRange(2, 11, lastRow - 1, 1).getValues();
  const fmt = v => v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss') : String(v);
  for (let i = 0; i < col.length; i++) {
    if (fmt(col[i][0]) === ts) return i + 2;
  }
  return 0;
}

// 設定 A 欄的帳戶列（1-based），找不到回 0。名稱以純字串比對（去頭尾空白）
function accountRowByName(cfg, name) {
  const last = cfg.getLastRow();
  if (last < 2 || !name) return 0;
  const col = cfg.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < col.length; i++) {
    if (String(col[i][0]).trim() === name) return i + 2;
  }
  return 0;
}

// A 欄最後一個非空列（設定其他欄如分類可能更長，不能用 getLastRow 決定 append 位置）
function lastAccountRow(cfg) {
  const last = cfg.getLastRow();
  if (last < 2) return 1;
  const col = cfg.getRange(2, 1, last - 1, 1).getValues();
  for (let i = col.length - 1; i >= 0; i--) {
    if (String(col[i][0]).trim() !== '') return i + 2;
  }
  return 1;
}

function doGet(e) {
  if (e.parameter.token !== TOKEN) return json({ ok: false, error: 'unauthorized' });
  const action = e.parameter.action || 'config';
  if (action === 'records') return json({ ok: true, records: getRecords(e.parameter.from, e.parameter.to) });
  if (action === 'balances') return json({ ok: true, balances: getBalances() });
  return json(Object.assign({ ok: true }, getConfig()));
}

function getConfig() {
  const cfg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
  const last = cfg.getLastRow();
  const accounts = cfg.getRange(2, 1, last - 1, 3).getValues()
    .filter(r => r[0] !== '')
    .map(r => ({ name: r[0], show: r[1] == 1, currency: r[2] || 'TWD' }));
  const categories = cfg.getRange(2, 5, last - 1, 4).getValues()
    .filter(r => r[0] !== '')
    .map(r => ({ type: r[0], category: r[1], sub: r[2], defaultAccount: r[3] }));
  const tags = cfg.getRange(2, 10, last - 1, 1).getValues().flat().filter(t => t !== '');
  const rates = {};
  cfg.getRange(2, 12, last - 1, 2).getValues().forEach(r => {
    const rate = Number(r[1]);
    if (r[0] && isFinite(rate) && rate > 0) rates[String(r[0])] = rate;
  });
  // emoji 對照：O:P 分類/帳戶、R:S 子分類（名稱是個資，不放前端 code；直接在分頁增刪列即可）
  const readMap = col => {
    const map = {};
    cfg.getRange(2, col, last - 1, 2).getValues().forEach(r => {
      if (r[0] !== '' && r[1] !== '') map[String(r[0])] = String(r[1]);
    });
    return map;
  };
  // 常用快速記帳 U:X（類型/分類/子分類/金額），app 新增頁一點填入；列順序 = 顯示順序
  const quick = cfg.getRange(2, 21, last - 1, 4).getValues()
    .filter(r => r[0] !== '')
    .map(r => ({ type: r[0], category: r[1], sub: r[2], amount: Number(r[3]) || 0 }));
  // 信用卡帳單設定 Z:AC（信用卡/結帳日/繳費日/扣款帳戶），帳戶明細的「帳單」模式用
  const cards = cfg.getRange(2, 26, last - 1, 4).getValues()
    .filter(r => r[0] !== '' && Number(r[1]))
    .map(r => ({ name: r[0], closeDay: Number(r[1]), payDay: Number(r[2]) || Number(r[1]), payFrom: String(r[3] || '') }));
  return { accounts, categories, tags, rates, emoji: readMap(15), subEmoji: readMap(18), quick, cards,
    holdings: getHoldings() };
}

// 「持倉」分頁：股票/ETF 追蹤清單。app 端的現有股數 = 基準股數 +
// 基準日之後備註符合「標的 股數股」格式的記錄加總（賣出記負數，如 0050 -500股）
function getHoldings() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('持倉');
  if (!sh || sh.getLastRow() < 2) return [];
  const fmtD = v => v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || '');
  return sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues()
    .filter(r => r[0] !== '')
    .map(r => ({
      ticker: String(r[0]).trim().toUpperCase(),
      name: String(r[1] || ''),
      bucket: String(r[2] || ''),
      account: String(r[3] || '').trim(),
      baseDate: fmtD(r[4]),
      baseShares: Number(r[5]) || 0,
      price: Number(r[6]) || 0, // G 欄現價：GOOGLEFINANCE 公式或手動數字都行，讀的是值
    }));
}

// 在編輯器跑一次，替「持倉」G 欄現價填 GOOGLEFINANCE 公式（台股代號數字開頭→TPE:，美股用原代號）。
// 可重複執行：只補空格，已有公式或手動填的價格不覆蓋；新增標的列後重跑一次即可。
// GOOGLEFINANCE 抓不到的標的（#N/A，常見於特別股/部分債券 ETF）直接把該格改成手動數字
function initHoldingPrices() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('持倉');
  if (!sh) throw new Error('先跑 initHoldings()');
  sh.getRange(1, 7).setValue('現價').setFontWeight('bold');
  const last = sh.getLastRow();
  for (let r = 2; r <= last; r++) {
    const t = String(sh.getRange(r, 1).getValue()).trim().toUpperCase();
    if (!t) continue;
    const cell = sh.getRange(r, 7);
    if (cell.getFormula() || cell.getValue() !== '') continue;
    const sym = /^\d/.test(t) ? 'TPE:' + t : t;
    cell.setFormula('=GOOGLEFINANCE("' + sym + '")');
  }
}

// 在編輯器跑一次，建「持倉」分頁標題列；之後直接在分頁增刪列（列順序 = app 顯示順序）。
// 標的=代號（0050、00719B、VOO）、帳戶=該標的所在的券商帳戶（需與設定分頁 A 欄一致，
// app 靠它從轉帳方向判斷買賣：轉入=買、轉出=賣）、基準日=盤點日（yyyy-MM-dd，
// 當天以前的持股都算在基準股數裡，空白=從今天起算）、基準股數=盤點時券商 App 顯示的股數。
// 同一標的在多個券商 = 開多列（帳戶欄不同），app 依每筆轉帳碰到的帳戶自動歸戶
function initHoldings() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('持倉') || ss.insertSheet('持倉');
  sh.getRange(1, 1, 1, 7).setValues([['標的', '名稱', '桶別', '帳戶', '基準日', '基準股數', '現價']]).setFontWeight('bold');
  sh.getRange(1, 5, sh.getMaxRows(), 1).setNumberFormat('@'); // 基準日純文字，避開美國時區偏移
  sh.setFrozenRows(1);
}

// 在編輯器跑一次，建「設定」U:X 常用快速記帳的標題列；之後直接在分頁增刪列（只支援支出/收入）
function initQuick() {
  const cfg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
  cfg.getRange(1, 21, 1, 4).setValues([['類型', '分類', '子分類', '金額']]).setFontWeight('bold');
}

// 在編輯器跑一次，建「設定」Z:AC 信用卡帳單設定的標題列；之後直接在分頁增刪列。
// 信用卡=帳戶名（要和 A 欄完全一致）、結帳日/繳費日=每月幾號、扣款帳戶=一鍵繳費的轉出帳戶名
function initCards() {
  const cfg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
  cfg.getRange(1, 26, 1, 4).setValues([['信用卡', '結帳日', '繳費日', '扣款帳戶']]).setFontWeight('bold');
}

function getRecords(from, to) {
  const rows = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('記錄')
    .getDataRange().getValues().slice(1);
  const fmtDate = v => v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v);
  const records = [];
  rows.forEach(r => {
    const date = fmtDate(r[0]);
    if ((from && date < from) || (to && date > to)) return;
    records.push({
      date,
      type: r[1],
      category: r[2],
      sub: r[3],
      amount: Number(r[4]) || 0,
      currency: r[5] || 'TWD',
      from: r[6],
      to: r[7],
      tags: String(r[8] || ''),
      note: String(r[9] || ''),
      ts: r[10] instanceof Date ? Utilities.formatDate(r[10], TZ, 'yyyy-MM-dd HH:mm:ss') : String(r[10]),
      toAmount: Number(r[11]) || 0,
    });
  });
  return records.reverse();
}

function getBalances() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = ss.getSheetByName('記錄').getDataRange().getValues().slice(1);
  const delta = {};
  rows.forEach(r => {
    const amount = Number(r[4]) || 0;
    if (r[6]) delta[r[6]] = (delta[r[6]] || 0) - amount;
    if (r[7]) delta[r[7]] = (delta[r[7]] || 0) + (Number(r[11]) || amount);
  });
  const cfg = ss.getSheetByName('設定');
  const last = cfg.getLastRow();
  return cfg.getRange(2, 1, last - 1, 3).getValues()
    .filter(r => r[0] !== '')
    .map(r => ({ name: r[0], show: r[1] == 1, currency: r[2] || 'TWD', balance: delta[r[0]] || 0 }));
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- AndroMoney 匯入（Step 5）----------
// 使用方式：
// 1. 先備份試算表（檔案 → 建立副本）
// 2. AndroMoney 匯出的 CSV 用「檔案 → 匯入 → 插入新工作表」放進來，分頁改名「匯入」
// 3. 在編輯器執行 importOldData()——會清空「記錄」、以匯入資料重建「設定」的帳戶(A:C)/分類(E:H)，
//    匯率 L:M 與常用標籤 J 欄不動。不改 doGet/doPost，所以不需要重新部署
// 可重複執行（整批重建）：正式棄用 AndroMoney 那天，用當天最新匯出重跑一次即可

const IMPORT_SHEET = '匯入';

// 以下常數的實值是個人財務資料（帳戶清單、金額），不進 public repo——
// 貼 Apps Script 時用本機 gas/backfill.local.gs 的內容整段取代（同 TOKEN 模式；出處見本機 匯入對帳.md）：
// ACCOUNT_RENAMES   同一帳戶多名合併 + 改名（舊名 → 新名）
// ACCOUNT_CURRENCIES 真正以外幣計價的帳戶（其餘一律 TWD）
// TO_AMOUNT_BACKFILL 跨幣別轉帳的入帳金額回填（uid → 轉入幣別的真實金額）
// CALIBRATIONS      對帳確認的真實餘額（單位=帳戶幣別），回填後殘差匯入時自動補「餘額校正」拉平
// ACCOUNT_ORDER     帳戶顯示順序
const ACCOUNT_RENAMES = {};
const ACCOUNT_CURRENCIES = {};
const TO_AMOUNT_BACKFILL = {};
const CALIBRATIONS = {};
const ACCOUNT_ORDER = [];

function importOldData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const src = ss.getSheetByName(IMPORT_SHEET);
  if (!src) throw new Error('找不到「' + IMPORT_SHEET + '」分頁');
  const data = src.getDataRange().getValues();
  const headerAt = data.findIndex(r => String(r[0]).trim() === 'Id');
  if (headerAt < 0) throw new Error('找不到標題列（A 欄應有 Id）');
  const idx = {};
  data[headerAt].forEach((h, i) => (idx[String(h).trim()] = i));
  ['幣別', '金額', '分類', '子分類', '日期', '付款(轉出)', '收款(轉入)', '備註', '時間', 'status', 'uid'].forEach(h => {
    if (!(h in idx)) throw new Error('缺欄位：' + h);
  });

  const rename = v => {
    const n = String(v == null ? '' : v).trim();
    return ACCOUNT_RENAMES[n] || n;
  };

  const out = [];
  const tsSeen = {};      // 「日期 HH:mm」→ 已用筆數，秒數遞增避免記錄時間撞鍵（app 靠它定位列）
  const acctStat = {};    // 帳戶 → { n, last }
  const catCount = {};    // 類型|分類|子分類 → 筆數
  let skippedZeroInit = 0, skippedVoid = 0;

  for (let i = headerAt + 1; i < data.length; i++) {
    const r = data[i];
    const rawDate = String(r[idx['日期']]).trim();
    const from = rename(r[idx['付款(轉出)']]);
    const to = rename(r[idx['收款(轉入)']]);
    if (!from && !to) continue;
    // status 101 = 電子發票同步進來未確認的記錄（與手動記帳重複）、100 = 作廢，
    // 都不能入帳——2024-12 Robert 的對帳 script 排除這兩種後與實際餘額吻合
    const status = String(r[idx['status']] == null ? '' : r[idx['status']]).trim();
    if (status === '101' || status === '100') { skippedVoid++; continue; }
    const isInit = String(r[idx['分類']]).trim() === 'SYSTEM';
    const amount = Number(r[idx['金額']]) || 0;
    if (isInit && !amount) { skippedZeroInit++; continue; }
    // AndroMoney 預建的未來週期列也照匯（Robert 要求帳面與 AndroMoney 完全一致）

    let date, type, cat, sub;
    if (isInit) {
      date = '2012-01-01'; // 原始值是民國 sentinel（10100101），統一放在真實資料（2018-02 起）之前
      type = '收入'; cat = '期初餘額'; sub = '';
    } else {
      date = rawDate.slice(0, 4) + '-' + rawDate.slice(4, 6) + '-' + rawDate.slice(6, 8);
      type = from && to ? '轉帳' : from ? '支出' : '收入';
      cat = type === '轉帳' ? '' : String(r[idx['分類']]).trim();
      sub = type === '轉帳' ? '' : String(r[idx['子分類']]).trim();
    }

    let currency = String(r[idx['幣別']]).trim() || 'TWD';
    if (currency === 'JPY' && (from === '現金' || to === '現金')) currency = 'TWD'; // 幣別跑掉的那筆（棄用主因）

    let hhmm = String(r[idx['時間']] == null ? '' : r[idx['時間']]).replace(/\D/g, '');
    hhmm = hhmm ? ('0000' + hhmm).slice(-4) : '1200';
    const minuteKey = date + ' ' + hhmm.slice(0, 2) + ':' + hhmm.slice(2, 4);
    const sec = tsSeen[minuteKey] = (tsSeen[minuteKey] || 0) + 1;
    if (sec > 60) throw new Error('同一分鐘超過 60 筆，記錄時間會重複：' + minuteKey);
    const ts = minuteKey + ':' + ('0' + (sec - 1)).slice(-2);

    const toAmount = TO_AMOUNT_BACKFILL[String(r[idx['uid']]).trim()] || '';
    out.push([date, type, cat, sub, amount, currency, from, to, '',
      String(r[idx['備註']] == null ? '' : r[idx['備註']]), ts, toAmount]);

    [from, to].forEach(a => {
      if (!a) return;
      const s = acctStat[a] || (acctStat[a] = { n: 0, last: '' });
      s.n++;
      if (date > s.last) s.last = date;
    });
    if (type !== '轉帳') {
      const k = type + '|' + cat + '|' + sub;
      catCount[k] = (catCount[k] || 0) + 1;
    }
  }
  if (!out.length) throw new Error('沒有可匯入的資料');

  // 餘額校正：補記錄把帳戶拉到 CALIBRATIONS 的對帳值。日期放 2012-01-01（和期初同天），不污染近年統計
  const balance = {};
  out.forEach(r => {
    if (r[6]) balance[r[6]] = (balance[r[6]] || 0) - r[4];
    if (r[7]) balance[r[7]] = (balance[r[7]] || 0) + (r[11] || r[4]); // 入帳側吃回填的入帳金額，同 getBalances
  });
  Object.keys(CALIBRATIONS).forEach(name => {
    const diff = Math.round((CALIBRATIONS[name] - (balance[name] || 0)) * 100) / 100;
    if (!diff) return;
    const type = diff > 0 ? '收入' : '支出';
    const sec = tsSeen['2012-01-01 00:00'] = (tsSeen['2012-01-01 00:00'] || 0) + 1;
    out.push(['2012-01-01', type, '餘額校正', '', Math.abs(diff), ACCOUNT_CURRENCIES[name] || 'TWD',
      type === '支出' ? name : '', type === '收入' ? name : '', '',
      '對齊 AndroMoney 帳戶總覽 2026-07-06', '2012-01-01 00:00:' + ('0' + (sec - 1)).slice(-2), '']);
    catCount[type + '|餘額校正|'] = (catCount[type + '|餘額校正|'] || 0) + 1;
  });

  const rec = ss.getSheetByName('記錄');
  rec.clearContents();
  if (rec.getMaxRows() < out.length + 1) rec.insertRowsAfter(rec.getMaxRows(), out.length + 1 - rec.getMaxRows());
  // 日期(A)與記錄時間(K)存純文字：試算表時區是美國，一被解析成 Date 讀回就偏移；
  // 標籤(I)/備註(J)純文字：貼上 = 開頭的內容不會變成活公式（公式注入防護）
  rec.getRange(1, 1, rec.getMaxRows(), 1).setNumberFormat('@');
  rec.getRange(1, 9, rec.getMaxRows(), 3).setNumberFormat('@');
  rec.getRange(1, 1, 1, RECORD_HEADERS.length).setValues([RECORD_HEADERS]).setFontWeight('bold');
  rec.getRange(2, 1, out.length, RECORD_HEADERS.length).setValues(out);
  rec.setFrozenRows(1);

  rebuildConfig(acctStat, catCount);
  Logger.log('匯入 %s 筆（略過未確認/作廢 %s 筆、0 元期初 %s 筆）；帳戶 %s 個、分類 %s 組',
    out.length, skippedVoid, skippedZeroInit,
    Object.keys(acctStat).length, Object.keys(catCount).length);
}

// 以匯入資料重建「設定」帳戶與分類：2026 年起用過的帳戶才顯示，其餘隱藏；順序都照使用頻率
function rebuildConfig(acctStat, catCount) {
  const cfg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
  cfg.getRange('A2:C').clearContent();
  cfg.getRange('E2:H').clearContent();

  const accRows = Object.keys(acctStat)
    .map(name => [name, acctStat[name].last >= '2026-01-01' ? 1 : 0, ACCOUNT_CURRENCIES[name] || 'TWD'])
    .sort(ACCOUNT_ORDER.length ? byAccountOrder : (a, b) => (b[1] - a[1]) || (acctStat[b[0]].n - acctStat[a[0]].n));
  cfg.getRange(2, 1, accRows.length, 3).setValues(accRows);

  const catTotal = {};
  Object.keys(catCount).forEach(k => {
    const tc = k.split('|').slice(0, 2).join('|');
    catTotal[tc] = (catTotal[tc] || 0) + catCount[k];
  });
  const catRows = Object.keys(catCount)
    .map(k => k.split('|'))
    .sort((a, b) => {
      if (a[0] !== b[0]) return a[0] === '支出' ? -1 : 1;
      const ta = catTotal[a[0] + '|' + a[1]], tb = catTotal[b[0] + '|' + b[1]];
      if (ta !== tb) return tb - ta;
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      return catCount[b.join('|')] - catCount[a.join('|')];
    })
    .map(k => [k[0], k[1], k[2], '']);
  cfg.getRange(2, 5, catRows.length, 4).setValues(catRows);
}

// 在編輯器跑一次：把既有「記錄」的標籤/備註欄設純文字——
// doPost 寫入的備註若以 = 開頭會變成活公式（=IMPORTXML 這類可以外洩資料），純文字格式一勞永逸
function hardenRecordSheet() {
  const rec = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('記錄');
  rec.getRange(1, 9, rec.getMaxRows(), 2).setNumberFormat('@');
}

function byAccountOrder(a, b) {
  const p = n => { const i = ACCOUNT_ORDER.indexOf(n); return i < 0 ? ACCOUNT_ORDER.length : i; };
  return p(a[0]) - p(b[0]);
}

// 在編輯器跑一次（隨時可重跑）：「設定」帳戶列重排——同銀行相鄰＋按使用頻率排序。
// 分組：名稱前兩字相同視為同銀行（A銀行/A銀行信用卡；B銀行、現金這類自成一組）；
// 顯示中的在前、隱藏的在後；組間按組內最高頻率（常用卡把同銀行帳戶一起帶上來）、
// 組內按各自頻率。頻率 = 最近 365 天在記錄付款/收款欄出現的次數。
// 結果會印在執行記錄供過目，個別不滿意的列直接在分頁拖曳微調；跑完 app 要 ⚙️ 重新整理
function reorderAccountsByUsage() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cutoff = Utilities.formatDate(new Date(Date.now() - 365 * 86400 * 1000), TZ, 'yyyy-MM-dd');
  const fmtDate = v => v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v);
  const freq = {};
  ss.getSheetByName('記錄').getDataRange().getValues().slice(1).forEach(r => {
    if (fmtDate(r[0]) < cutoff) return;
    if (r[6]) freq[r[6]] = (freq[r[6]] || 0) + 1;
    if (r[7]) freq[r[7]] = (freq[r[7]] || 0) + 1;
  });

  const cfg = ss.getSheetByName('設定');
  const last = cfg.getLastRow();
  const rows = cfg.getRange(2, 1, last - 1, 3).getValues().filter(r => r[0] !== '');
  // 顯示/隱藏分開分組：隱藏的同銀行帳戶留在後段，不被顯示中的同名組拉上來
  const groupKey = r => (r[1] == 1 ? 'v' : 'h') + String(r[0]).slice(0, 2);
  const groupTop = {};
  rows.forEach(r => {
    const k = groupKey(r);
    groupTop[k] = Math.max(groupTop[k] || 0, freq[r[0]] || 0);
  });
  rows.sort((a, b) => {
    const va = a[1] == 1 ? 0 : 1, vb = b[1] == 1 ? 0 : 1;
    if (va !== vb) return va - vb;
    const ka = groupKey(a), kb = groupKey(b);
    if (ka !== kb) return (groupTop[kb] - groupTop[ka]) || (ka < kb ? -1 : 1);
    return (freq[b[0]] || 0) - (freq[a[0]] || 0);
  });
  cfg.getRange(2, 1, last - 1, 3).clearContent();
  cfg.getRange(2, 1, rows.length, 3).setValues(rows);
  Logger.log(rows.map(r => (r[1] == 1 ? '' : '（隱藏）') + r[0] + '：近一年 ' + (freq[r[0]] || 0) + ' 筆').join('\n'));
}

// 在編輯器跑一次：把「設定」的帳戶列依 ACCOUNT_ORDER 重排。
// app 的帳戶總覽/選單順序都跟著「設定」列順序走，之後微調直接在 Sheet 拖曳列即可；
// 不在 ACCOUNT_ORDER 裡的帳戶（未來新開的）保持原相對順序排在最後
function reorderAccounts() {
  const cfg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('設定');
  const last = cfg.getLastRow();
  const rows = cfg.getRange(2, 1, last - 1, 3).getValues().filter(r => r[0] !== '');
  rows.sort(byAccountOrder);
  cfg.getRange(2, 1, last - 1, 3).clearContent();
  cfg.getRange(2, 1, rows.length, 3).setValues(rows);
}
