// 院内在庫ボード — GitHub Pages + Firebase (Firestore) 版
// データは stores/<秘密のキー>/items と stores/<秘密のキー>/logs に保存されます。
// 秘密のキーは URL の # 以降（#k=...）だけに入り、このファイルにも GitHub にも書かれません。
import FIREBASE_CONFIG from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, setDoc,
  onSnapshot, query, where, orderBy, limit, writeBatch, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const DAY = 86400000;
const S = { items: new Map(), logs: [], loaded: false, view: "order", dept: "all", cat: "all", filter: "all", q: "", busy: new Set(), sheet: null, delArm: false, gotItems: false };
let fs = null, KEY = null;
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => { n = Number(n) || 0; return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ""); };
const num = (v) => { if (v === "" || v == null) return null; const n = Number(String(v).replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))); return Number.isFinite(n) ? n : null; };
const WD = "日月火水木金土";
const md = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
const hm = (t) => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const myName = () => store.get("zaiko-name") || "";

function toast(msg) {
  const el = document.createElement("div"); el.className = "toast"; el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 2600);
}

/* ---------- key / paths ---------- */
// 合言葉から在庫ボードのキーを作る（同じ合言葉なら、どの端末でも同じキーになる）
async function keyFromPass(p) {
  const text = "zaiko-board:v1:" + String(p).normalize("NFKC").trim();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
const PASS_MIN = 6;
async function boardHasItems(k) {
  const snap = await getDocs(query(collection(fs, "stores", k, "items"), limit(1)));
  return !snap.empty;
}
function readKey() {
  const m = location.hash.match(/k=([A-Za-z0-9]{20,64})/);
  if (m) { store.set("zaiko-key", m[1]); return m[1]; }
  // #k= のないアドレスで開いたときは、この端末で前回開いたボードを使う
  const saved = store.get("zaiko-key");
  if (saved && /^[A-Za-z0-9]{20,64}$/.test(saved)) { history.replaceState(null, "", "#k=" + saved); return saved; }
  return null;
}
function newKey() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const a = new Uint32Array(24); crypto.getRandomValues(a);
  return [...a].map(x => abc[x % abc.length]).join("");
}
const itemsCol = () => collection(fs, "stores", KEY, "items");
const logsCol = () => collection(fs, "stores", KEY, "logs");
const itemDoc = (id) => doc(fs, "stores", KEY, "items", id);
const boardLink = () => location.origin + location.pathname + "#k=" + KEY;

/* ---------- calculation ---------- */
function calc(it) {
  const stock = Number(it.stock) || 0;
  const m = num(it.monthlyUse), lead = num(it.leadDays), safety = num(it.safetyDays) ?? 7;
  const daily = m != null && m > 0 ? m / 30 : null;
  let rp = null;
  if (num(it.reorderPoint) != null) rp = num(it.reorderPoint);
  else if (daily != null && lead != null) rp = Math.max(1, Math.ceil(daily * (lead + safety)));
  const oq = num(it.orderQty) ?? (m ? Math.max(1, Math.ceil(m)) : null);
  let st;
  if (it.orderedAt) st = "ordered";
  else if (stock <= 0) st = "out";
  else if (rp == null) st = "unset";
  else if (stock <= rp) st = "reorder";
  else if (daily != null && stock <= rp + daily * 7) st = "soon";
  else st = "ok";
  const eta = it.orderedAt && lead != null ? it.orderedAt + lead * DAY : null;
  return { stock, m, lead, safety, daily, rp, oq, st, eta };
}
const ST_LABEL = { out: "在庫切れ", reorder: "要発注", soon: "そろそろ", ordered: "入荷待ち", unset: "未設定", ok: "十分" };
const needsOrder = (c) => c.st === "out" || c.st === "reorder";

function usageEstimate(id) {
  if (!S.logs.length) return null;
  const now = Date.now();
  const first = Math.min(...S.logs.map(l => l.t));
  const span = Math.min(60, (now - first) / DAY);
  if (span < 1) return null;
  let used = 0;
  for (const l of S.logs) {
    if (l.item !== id || l.t < now - 60 * DAY) continue;
    if (l.type === "use") used += Number(l.qty) || 0;
    if (l.type === "count" && l.delta < 0) used += -l.delta;
  }
  return { perMonth: Math.round(used / span * 30 * 10) / 10, days: Math.round(span) };
}

/* ---------- data helpers ---------- */
const items = () => [...S.items.values()].sort((a, b) => (a.dept || "").localeCompare(b.dept || "", "ja") || (a.sort ?? 0) - (b.sort ?? 0) || (a.name || "").localeCompare(b.name || "", "ja"));
const depts = () => [...new Set([...S.items.values()].map(i => i.dept || "未分類"))].sort((a, b) => a.localeCompare(b, "ja"));
const inDept = (it) => S.dept === "all" || (it.dept || "未分類") === S.dept;

async function write(id, fn) {
  if (S.busy.has(id)) return false;
  S.busy.add(id); render();
  try { await fn(); return true; }
  catch (e) {
    console.error(e);
    if (e && e.code === "permission-denied") toast("保存が許可されませんでした。リンクが正しいか、Firebaseのルール設定を確認してください");
    else toast("保存できませんでした。通信状態を確認してもう一度お試しください");
    return false;
  } finally { S.busy.delete(id); render(); }
}
async function addLog(it, type, qty, delta, after) {
  try { await addDoc(logsCol(), { t: Date.now(), item: it.id, name: it.name, dept: it.dept || "", type, qty, delta, after, by: myName() }); }
  catch (e) { console.error(e); }
}
function changeStock(id, delta, type, qty) {
  const it = S.items.get(id); if (!it) return;
  const before = Number(it.stock) || 0;
  const after = Math.max(0, Math.round((before + delta) * 10) / 10);
  const real = Math.round((after - before) * 10) / 10;
  if (real === 0 && type !== "receive") return;
  const patch = { stock: after };
  if (type === "receive") { patch.orderedAt = null; patch.orderedQty = null; }
  return write(id, async () => { await updateDoc(itemDoc(id), patch); await addLog(it, type, qty ?? Math.abs(real), real, after); });
}
function setOrdered(id, q) {
  const it = S.items.get(id); if (!it) return;
  return write(id, async () => { await updateDoc(itemDoc(id), { orderedAt: Date.now(), orderedQty: q }); await addLog(it, "order", q, 0, Number(it.stock) || 0); });
}
const cancelOrder = (id) => write(id, () => updateDoc(itemDoc(id), { orderedAt: null, orderedQty: null }));

/* ---------- render ---------- */
function render() {
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-current", t.dataset.view === S.view ? "page" : "false"));
  const all = items();
  const need = all.filter(i => needsOrder(calc(i))).length;
  const bo = $("#b-order"); bo.hidden = !need; bo.textContent = need;
  $("#fab-add").hidden = !(S.loaded && S.view !== "settings");
  if (!S.loaded) return;
  const app = $("#app");
  if (S.view === "order") app.innerHTML = viewOrder(all);
  else if (S.view === "stock") app.innerHTML = viewStock(all);
  else if (S.view === "log") app.innerHTML = viewLog();
  else if (S.rendered !== "settings") app.innerHTML = viewSettings(); // 入力中の内容を消さないよう、設定画面は開いたときだけ描く
  S.rendered = S.view;
  if (S.sheet) renderSheet();
}

function deptBar() {
  const ds = depts(); if (ds.length < 2) return "";
  return `<div class="bar" role="group" aria-label="部門">${["all", ...ds].map(d => `<button class="chip" data-act="dept" data-v="${esc(d)}" aria-pressed="${S.dept === d}">${d === "all" ? "すべての部門" : esc(d)}</button>`).join("")}</div>`;
}

function rowSub(it, c) {
  const pill = `<span class="pill s-${c.st}">${ST_LABEL[c.st]}</span>`;
  let t;
  if (c.st === "ordered") t = `${fmt(it.orderedQty)}${esc(it.unit)} 注文済み・${md(it.orderedAt)}${c.eta ? `／${md(c.eta)}ごろ届く予定` : ""}`;
  else if (c.rp != null) t = `発注点 ${fmt(c.rp)}${esc(it.unit)}${c.oq ? `・注文 ${fmt(c.oq)}${esc(it.unit)}` : ""}`;
  else t = "発注点が未設定";
  return pill + t;
}

function stockRow(it) {
  const c = calc(it), dis = S.busy.has(it.id) ? "disabled" : "";
  return `<div class="row">
    <button class="main" data-act="open" data-id="${it.id}"><span class="name">${esc(it.name)}</span><span class="sub">${rowSub(it, c)}</span></button>
    <div class="stepper">
      <button data-act="use" data-id="${it.id}" aria-label="${esc(it.name)}を1つ使った" ${dis || (c.stock <= 0 ? "disabled" : "")}>−</button>
      <span class="qty num ${c.stock <= 0 ? "zero" : ""}">${fmt(c.stock)}</span>
      <button data-act="plus" data-id="${it.id}" aria-label="${esc(it.name)}を1つ増やす" ${dis}>＋</button>
    </div></div>`;
}

const emptyItems = () => `<div class="list"><div class="empty"><b>まだ品目がありません</b>右下の「＋ 品目を追加」から登録するか、「設定」タブで移行用データを読み込んでください。</div></div>`;

function viewStock(all) {
  const q = S.q.trim().toLowerCase();
  const scoped = all.filter(inDept);
  const counts = { all: scoped.length, need: 0, ordered: 0, unset: 0 };
  scoped.forEach(i => { const c = calc(i); if (needsOrder(c)) counts.need++; if (c.st === "ordered") counts.ordered++; if (c.rp == null) counts.unset++; });
  const list = scoped.filter(i => {
    const c = calc(i);
    if (S.filter === "need" && !needsOrder(c)) return false;
    if (S.filter === "ordered" && c.st !== "ordered") return false;
    if (S.filter === "unset" && c.rp != null) return false;
    return !q || ((i.name || "") + " " + (i.cat || "") + " " + (i.supplier || "")).toLowerCase().includes(q);
  });
  const multiDept = S.dept === "all" && depts().length > 1;
  const catKey = (i) => (multiDept ? (i.dept || "未分類") + "／" : "") + (i.cat || "その他");
  const catInfo = new Map();
  scoped.forEach(i => { const k = catKey(i); if (!catInfo.has(k)) catInfo.set(k, { n: 0, need: 0 }); const ci = catInfo.get(k); ci.n++; if (needsOrder(calc(i))) ci.need++; });
  if (S.cat !== "all" && !catInfo.has(S.cat)) S.cat = "all";
  const shown = list.filter(i => S.cat === "all" || catKey(i) === S.cat);
  const groups = new Map();
  shown.forEach(i => { const k = catKey(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  const chips = [["all", "すべて", counts.all], ["need", "要発注", counts.need], ["ordered", "入荷待ち", counts.ordered], ["unset", "未設定", counts.unset]]
    .map(([k, l, n]) => `<button class="chip" data-act="filter" data-v="${k}" aria-pressed="${S.filter === k}">${l} <span class="num">${n}</span></button>`).join("");
  const catChips = `<div class="catbar" role="group" aria-label="分類"><button class="chip" data-act="cat" data-v="all" aria-pressed="${S.cat === "all"}">すべての分類</button>${[...catInfo].map(([k, ci]) =>
    `<button class="chip" data-act="cat" data-v="${esc(k)}" aria-pressed="${S.cat === k}">${ci.need ? `<span class="dot" aria-label="要発注あり"></span>` : ""}${esc(k)} <span class="num">${ci.n}</span></button>`).join("")}</div>`;
  return `${deptBar()}
    <div class="bar"><input id="q" class="search" type="search" placeholder="品目名・注文先で探す" value="${esc(S.q)}" aria-label="品目を検索"></div>
    ${all.length ? catChips : ""}
    <div class="bar" role="group" aria-label="絞り込み">${chips}</div>
    ${!all.length ? emptyItems() : !shown.length ? `<div class="list"><div class="empty"><b>該当する品目がありません</b>分類・絞り込み・検索語を変えてみてください。</div></div>` :
      [...groups].map(([k, arr]) => { const need = arr.filter(i => needsOrder(calc(i))).length;
        return `<section class="cat"><div class="cat-head"><h2>${esc(k)}<small>${arr.length}品目</small></h2>${need ? `<span class="warn">要発注 ${need}</span>` : ""}</div><div class="list">${arr.map(stockRow).join("")}</div></section>`; }).join("")}`;
}

function viewOrder(all) {
  const scoped = all.filter(inDept);
  if (!scoped.length) return deptBar() + emptyItems();
  const need = [], ordered = [], soon = [];
  let unset = 0;
  scoped.forEach(i => { const c = calc(i); if (needsOrder(c)) need.push(i); else if (c.st === "ordered") ordered.push(i); else if (c.st === "soon") soon.push(i); if (c.rp == null) unset++; });
  const bySup = new Map();
  need.forEach(i => { const k = i.supplier || "注文先未設定"; if (!bySup.has(k)) bySup.set(k, []); bySup.get(k).push(i); });
  const needRow = (i) => { const c = calc(i), b = S.busy.has(i.id) ? "disabled" : "";
    return `<div class="row"><button class="main" data-act="open" data-id="${i.id}"><span class="name">${esc(i.name)}</span>
      <span class="sub"><span class="tag">${esc(i.cat || "その他")}</span><span class="pill s-${c.st}">${ST_LABEL[c.st]}</span>残り <b class="num">${fmt(c.stock)}</b>${esc(i.unit)}${c.rp != null ? `／発注点 ${fmt(c.rp)}` : ""}</span></button>
      <div class="inline"><input id="oq-${i.id}" type="text" inputmode="decimal" value="${c.oq != null ? fmt(c.oq) : ""}" placeholder="数" aria-label="${esc(i.name)}の注文数">
      <button class="btn small primary" data-act="ordered" data-id="${i.id}" ${b}>注文した</button></div></div>`; };
  const ordRow = (i) => { const c = calc(i), late = c.eta && c.eta < Date.now() - DAY / 2, b = S.busy.has(i.id) ? "disabled" : "";
    return `<div class="row"><button class="main" data-act="open" data-id="${i.id}"><span class="name">${esc(i.name)}</span>
      <span class="sub"><span class="tag">${esc(i.cat || "その他")}</span><span class="pill ${late ? "s-reorder" : "s-ordered"}">${late ? "予定日を過ぎています" : "入荷待ち"}</span>${md(i.orderedAt)}に${fmt(i.orderedQty)}${esc(i.unit)}注文${c.eta ? `・${md(c.eta)}ごろ` : ""}</span></button>
      <div class="inline"><input id="rq-${i.id}" type="text" inputmode="decimal" value="${fmt(i.orderedQty)}" aria-label="${esc(i.name)}の入荷数">
      <button class="btn small" data-act="received" data-id="${i.id}" ${b}>届いた</button></div></div>`; };
  return `${deptBar()}
    ${!myName() ? `<div class="note"><div class="grow"><b>この端末の名前が未設定です。</b>設定すると、履歴に「誰が動かしたか」が残ります。</div><button class="btn small" data-act="goSettings">名前を設定</button></div>` : ""}
    ${unset ? `<div class="note"><div class="grow"><b>${unset}品目の発注点がまだ未設定です。</b>月の使用量と納期を入れると、残りいくつで注文すればいいかを自動で計算します。</div><button class="btn small" data-act="goUnset">未設定を見る</button></div>` : ""}
    <section class="group"><h2>今注文するもの<span>${need.length}品目</span>${need.length ? `<button class="btn small" data-act="copy" style="margin-left:auto">リストをコピー</button>` : ""}</h2>
      ${need.length ? [...bySup].map(([s, arr]) => `<div style="display:grid;gap:6px;margin-bottom:12px"><div style="font-size:12.5px;color:var(--muted)">注文先：${esc(s)}</div><div class="list">${arr.map(needRow).join("")}</div></div>`).join("")
        : `<div class="list"><div class="empty"><b>今注文が必要なものはありません</b>在庫が発注点まで減るとここに出ます。</div></div>`}
    </section>
    <section class="group"><h2>入荷待ち<span>${ordered.length}品目</span></h2>
      ${ordered.length ? `<div class="list">${ordered.map(ordRow).join("")}</div>` : `<div class="list"><div class="empty">注文中のものはありません。「注文した」を押すとここに移ります。</div></div>`}
    </section>
    ${soon.length ? `<section class="group"><h2>そろそろ発注点<span>1週間以内に発注点に届きそうなもの</span></h2><div class="list">${soon.map(stockRow).join("")}</div></section>` : ""}`;
}

const TYPE = { use: "使った", count: "数を修正", receive: "入荷", order: "注文" };
function viewLog() {
  if (!S.logs.length) return `<div class="list"><div class="empty"><b>まだ記録がありません</b>在庫を減らしたり、注文・入荷を登録したりすると、ここに日付順で残ります。</div></div>`;
  const byDay = new Map();
  S.logs.slice(0, 300).forEach(l => { const k = md(l.t); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(l); });
  return [...byDay].map(([d, arr]) => `<section class="group"><h2>${d}<span>${arr.length}件</span></h2><div class="list">${arr.map(l => {
    const cls = l.type === "order" ? "order" : l.delta < 0 ? "minus" : "plus";
    const amt = l.type === "order" ? `${fmt(l.qty)}注文` : `${l.delta > 0 ? "+" : "−"}${fmt(Math.abs(l.delta))}`;
    return `<div class="log"><span class="t num">${hm(l.t)}</span><span class="what">${esc(l.name)}<br><span class="who">${TYPE[l.type] || esc(l.type)}・${esc(l.by || "名前未設定")}</span></span>
      <span class="d num ${cls}">${amt}${l.type !== "order" ? `<span class="who"> → ${fmt(l.after)}</span>` : ""}</span></div>`; }).join("")}</div></section>`).join("");
}

function viewSettings() {
  return `<div class="settings">
    <div class="box"><h4>この端末の名前</h4>
      <p>履歴に表示される名前です。端末（スマホ・PC）ごとに設定します。</p>
      <div class="copyline"><input id="set-name" value="${esc(myName())}" placeholder="例：安藤" style="background:var(--surface)"><button class="btn primary" data-act="saveName">保存</button></div></div>
    <div class="box"><h4>合言葉</h4>
      <p>合言葉を決めておくと、スタッフは <b>${esc(location.origin + location.pathname)}</b> を開いて、最初の1回だけ合言葉を入れれば使えるようになります。${PASS_MIN}文字以上で、院外の人が思いつかない言葉にしてください。</p>
      <p>合言葉を変えると、新しい合言葉のボードに今のデータを移します。以前の合言葉やリンクで開いている端末では、新しい合言葉を入れ直してもらってください。</p>
      <div class="copyline"><input id="set-pass" autocomplete="off" placeholder="新しい合言葉" style="background:var(--surface)"><button class="btn primary" data-act="setPass" id="pass-btn">合言葉を設定</button></div>
      <p id="pass-msg"></p></div>
    <div class="box"><h4>この在庫ボードのリンク</h4>
      <p>スタッフにはこのリンクを共有してください。<b style="color:var(--danger)">このリンクを知っている人は誰でも在庫を変更できます。</b>院内のスタッフだけに共有し、外部に出さないでください。</p>
      <div class="copyline"><input id="set-link" readonly value="${esc(boardLink())}" aria-label="在庫ボードのリンク"><button class="btn" data-act="copyLink">コピー</button></div></div>
    <div class="box"><h4>バックアップ</h4>
      <p>品目と履歴をファイルに保存します。月に1回くらい保存しておくと安心です。</p>
      <div class="acts"><button class="btn" data-act="export">バックアップを保存</button></div></div>
    <div class="box"><h4>データの読み込み</h4>
      <p>バックアップや移行用のファイル（.json）を読み込みます。同じ品目は、ファイルの内容で上書きされます。</p>
      <div class="acts"><input type="file" id="imp-file" accept=".json,application/json"><button class="btn" data-act="import" id="imp-btn">読み込む</button></div>
      <p id="imp-msg"></p></div>
  </div>`;
}

/* ---------- item sheet ---------- */
function openSheet(id) { S.sheet = { id }; S.delArm = false; renderSheet(true); }
function closeSheet() { S.sheet = null; $("#layer").innerHTML = ""; }

function renderSheet(fresh) {
  const layer = $("#layer");
  const isNew = S.sheet.id === "new";
  const it = isNew ? { id: "new", name: "", dept: S.dept !== "all" ? S.dept : (depts()[0] || "文房具"), cat: S.cat !== "all" && !S.cat.includes("／") ? S.cat : "", unit: "", stock: 0, safetyDays: 7 } : S.items.get(S.sheet.id);
  if (!it) { closeSheet(); return; }
  if (!fresh && layer.firstChild) { const live = $("#sheet-live"); if (live) live.innerHTML = sheetLive(it); return; }
  const v = (k) => esc(it[k] ?? "");
  const dl = (id, arr) => `<datalist id="${id}">${arr.map(x => `<option value="${esc(x)}"></option>`).join("")}</datalist>`;
  const cats = [...new Set([...S.items.values()].map(i => i.cat).filter(Boolean))];
  const sups = [...new Set([...S.items.values()].map(i => i.supplier).filter(Boolean))];
  layer.innerHTML = `<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-title">
    <div class="sheet-head"><h3 id="sh-title">${isNew ? "品目を追加" : esc(it.name)}<span class="sub">${isNew ? "新しい品目の情報を入れてください" : esc((it.dept || "") + "／" + (it.cat || "その他"))}</span></h3><button class="x" data-act="close" aria-label="閉じる">×</button></div>
    ${isNew ? "" : `<div id="sheet-live">${sheetLive(it)}</div>`}
    <form class="box" id="item-form" autocomplete="off">
      <h4>品目の設定</h4>
      <div class="grid2">
        <label class="f" style="grid-column:1/-1">品目名<input id="f-name" required value="${v("name")}"></label>
        <label class="f">部門<input id="f-dept" list="dl-dept" value="${v("dept")}" placeholder="例：文房具、歯科材料"></label>
        <label class="f">分類<input id="f-cat" list="dl-cat" value="${v("cat")}" placeholder="例：用紙、ペン"></label>
        <label class="f">単位<input id="f-unit" value="${v("unit")}" placeholder="例：冊、本、箱"></label>
        ${isNew ? `<label class="f">今の在庫数<input id="f-stock" inputmode="decimal" value="0"></label>` : ""}
      </div>
      <div class="grid2">
        <label class="f">月の使用量<input id="f-monthly" inputmode="decimal" value="${v("monthlyUse")}" placeholder="例：8"><span class="hint">1か月にだいたい使う数</span></label>
        <label class="f">納期（日）<input id="f-lead" inputmode="decimal" value="${v("leadDays")}" placeholder="例：3"><span class="hint">注文してから届くまで</span></label>
        <label class="f">予備（日分）<input id="f-safety" inputmode="decimal" value="${it.safetyDays ?? 7}"><span class="hint">念のため多めに持つ日数</span></label>
        <label class="f">発注点（手入力）<input id="f-rp" inputmode="decimal" value="${v("reorderPoint")}" placeholder="空欄なら自動"><span class="hint">決めた数があれば入力</span></label>
        <label class="f">1回の注文数<input id="f-oq" inputmode="decimal" value="${v("orderQty")}" placeholder="空欄なら1か月分"></label>
        <label class="f">注文先<input id="f-sup" list="dl-sup" value="${v("supplier")}" placeholder="例：アスクル"></label>
        <label class="f" style="grid-column:1/-1">メモ<textarea id="f-note" rows="2" placeholder="品番、注文のしかたなど">${v("note")}</textarea></label>
      </div>
      <div class="formula" id="f-preview"></div>
      <div class="acts"><button class="btn primary" type="submit">${isNew ? "追加する" : "設定を保存"}</button>
        ${isNew ? "" : `<button class="btn danger" type="button" data-act="del" data-id="${it.id}" id="del-btn">この品目を削除</button>`}</div>
    </form>
    ${dl("dl-dept", depts())}${dl("dl-cat", cats)}${dl("dl-sup", sups)}
  </div></div>`;
  updatePreview();
  setTimeout(() => (isNew ? $("#f-name") : $(".x"))?.focus(), 30);
}

function sheetLive(it) {
  const c = calc(it), b = S.busy.has(it.id) ? "disabled" : "";
  const est = usageEstimate(it.id);
  return `<div style="display:grid;gap:12px">
    <div class="big"><span class="n num" style="${c.stock <= 0 ? "color:var(--danger)" : ""}">${fmt(c.stock)}</span><span class="u">${esc(it.unit) || "個"}</span><span class="pill s-${c.st}">${ST_LABEL[c.st]}</span></div>
    <div class="box"><h4>在庫を動かす</h4>
      <div class="acts"><button class="btn" data-act="use" data-id="${it.id}" ${b || (c.stock <= 0 ? "disabled" : "")}>使った −1</button>
        <span class="inline"><input id="s-count" inputmode="decimal" placeholder="${fmt(c.stock)}" aria-label="数え直した在庫数"><button class="btn small" data-act="count" data-id="${it.id}" ${b}>数を直す</button></span></div>
      <div class="acts">${it.orderedAt
        ? `<span style="flex:1 1 200px;font-size:13px;color:var(--muted)">${md(it.orderedAt)}に${fmt(it.orderedQty)}${esc(it.unit)}注文済み${c.eta ? `・${md(c.eta)}ごろ届く予定` : ""}</span>
           <span class="inline"><input id="s-recv" inputmode="decimal" value="${fmt(it.orderedQty)}" aria-label="入荷数"><button class="btn small primary" data-act="recvSheet" data-id="${it.id}" ${b}>届いた</button></span>
           <button class="btn small" data-act="cancelOrder" data-id="${it.id}" ${b}>注文を取り消す</button>`
        : `<span class="inline"><input id="s-order" inputmode="decimal" value="${c.oq != null ? fmt(c.oq) : ""}" placeholder="数" aria-label="注文数"><button class="btn small primary" data-act="orderSheet" data-id="${it.id}" ${b}>注文した</button></span>
           <span class="inline"><input id="s-add" inputmode="decimal" placeholder="数" aria-label="注文せずに入荷した数"><button class="btn small" data-act="addSheet" data-id="${it.id}" ${b}>入荷を登録</button></span>`}</div>
      <span style="font-size:12px;color:var(--muted)">開封済みのものは 0.5 と入力できます。</span>
    </div>
    ${est ? `<div class="note"><div class="grow">記録から見た使用量：<b>月あたり約 ${fmt(est.perMonth)}${esc(it.unit)}</b>（直近${est.days}日の記録）${est.days < 14 ? "　※記録がまだ少ないので参考値です" : ""}</div>${est.perMonth > 0 ? `<button class="btn small" data-act="useEst" data-v="${est.perMonth}" type="button">この値を使う</button>` : ""}</div>` : ""}
  </div>`;
}

function updatePreview() {
  const p = $("#f-preview"); if (!p) return;
  const m = num($("#f-monthly").value), lead = num($("#f-lead").value), safety = num($("#f-safety").value) ?? 7, rp = num($("#f-rp").value);
  const unit = $("#f-unit").value || "個";
  if (rp != null) { p.innerHTML = `発注点は手入力の <b class="num">${fmt(rp)}${esc(unit)}</b>。残りがこの数以下になったら「要発注」になります。`; return; }
  if (m == null || lead == null || !(m > 0)) { p.innerHTML = `月の使用量と納期を入れると、発注点をここで計算します。<br><span style="color:var(--muted)">発注点 ＝ 1日の使用量 ×（納期 ＋ 予備の日数）</span>`; return; }
  const daily = m / 30, v = Math.max(1, Math.ceil(daily * (lead + safety)));
  p.innerHTML = `1日あたり ${daily.toFixed(2)} × （納期 ${fmt(lead)}日 ＋ 予備 ${fmt(safety)}日）＝ ${(daily * (lead + safety)).toFixed(1)}<br>→ 残り <b class="num">${v}${esc(unit)}</b> になったら注文`;
}

async function saveForm() {
  const isNew = S.sheet.id === "new";
  const name = $("#f-name").value.trim(); if (!name) { $("#f-name").focus(); return; }
  const data = { name, dept: $("#f-dept").value.trim() || "未分類", cat: $("#f-cat").value.trim(), unit: $("#f-unit").value.trim(),
    monthlyUse: num($("#f-monthly").value), leadDays: num($("#f-lead").value), safetyDays: num($("#f-safety").value) ?? 7,
    reorderPoint: num($("#f-rp").value), orderQty: num($("#f-oq").value), supplier: $("#f-sup").value.trim(), note: $("#f-note").value.trim() };
  if (isNew) {
    const maxSort = Math.max(0, ...[...S.items.values()].map(i => i.sort || 0));
    Object.assign(data, { stock: Math.max(0, num($("#f-stock").value) ?? 0), orderedAt: null, orderedQty: null, sort: maxSort + 10 });
    if (await write("new", () => addDoc(itemsCol(), data))) { toast(`${name}を追加しました`); closeSheet(); }
  } else {
    const id = S.sheet.id;
    if (await write(id, () => updateDoc(itemDoc(id), data))) { toast("設定を保存しました"); closeSheet(); }
  }
}

/* ---------- backup / import ---------- */
const ITEM_FIELDS = ["name", "dept", "cat", "unit", "stock", "monthlyUse", "leadDays", "safetyDays", "reorderPoint", "orderQty", "supplier", "note", "orderedAt", "orderedQty", "sort"];
function exportData() {
  const data = { app: "zaiko-board", version: 1, exportedAt: Date.now(),
    items: items().map(({ id, ...rest }) => ({ id, ...rest })), logs: S.logs.map(({ id, ...rest }) => ({ id, ...rest })) };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `在庫バックアップ_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("バックアップを保存しました");
}
async function importData() {
  const f = $("#imp-file").files[0], msg = $("#imp-msg");
  if (!f) { toast("読み込むファイルを選んでください"); return; }
  let data;
  try { data = JSON.parse(await f.text()); } catch { msg.textContent = "ファイルを読めませんでした。バックアップ用の .json ファイルか確認してください。"; return; }
  if (!Array.isArray(data.items)) { msg.textContent = "このファイルには品目のデータが入っていません。"; return; }
  const btn = $("#imp-btn"); btn.disabled = true; msg.textContent = "読み込み中…";
  try {
    const okId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(s);
    const its = data.items.filter(i => okId(i.id) && typeof i.name === "string");
    for (let i = 0; i < its.length; i += 400) {
      const b = writeBatch(fs);
      its.slice(i, i + 400).forEach(it => { const o = {}; ITEM_FIELDS.forEach(k => { o[k] = it[k] ?? null; }); o.stock = Number(o.stock) || 0; b.set(itemDoc(it.id), o); });
      await b.commit();
    }
    let logN = 0;
    const known = new Set(S.logs.map(l => l.id));
    const lgs = (Array.isArray(data.logs) ? data.logs : []).filter(l => okId(l.id) && !known.has(l.id) && typeof l.t === "number");
    for (const l of lgs) {
      try { await setDoc(doc(fs, "stores", KEY, "logs", l.id), { t: l.t, item: String(l.item || ""), name: String(l.name || ""), dept: String(l.dept || ""), type: String(l.type || ""), qty: Number(l.qty) || 0, delta: Number(l.delta) || 0, after: Number(l.after) || 0, by: String(l.by || "") }); logN++; }
      catch (e) { console.warn(e); }
    }
    msg.textContent = `品目 ${its.length}件、履歴 ${logN}件を読み込みました。`;
    toast("読み込みが終わりました");
  } catch (e) {
    console.error(e);
    msg.textContent = "途中で保存できなくなりました。通信状態とFirebaseのルール設定を確認して、もう一度読み込んでください。";
  } finally { btn.disabled = false; }
}

async function openWithPass() {
  const inp = $("#pass-in"), msg = $("#pass-msg"), btn = $("#pass-open");
  const p = inp.value.normalize("NFKC").trim();
  if (!p) { inp.focus(); return; }
  btn.disabled = true; msg.textContent = "確認中…";
  try {
    const k = await keyFromPass(p);
    if (!(await boardHasItems(k))) { msg.textContent = "合言葉が違います。もう一度確かめて入力してください。"; return; }
    store.set("zaiko-key", k); location.hash = "k=" + k; location.reload();
  } catch (e) { console.error(e); msg.textContent = "確認できませんでした。通信状態を確認してください。"; }
  finally { btn.disabled = false; }
}
async function setPass() {
  const inp = $("#set-pass"), msg = $("#pass-msg"), btn = $("#pass-btn");
  const p = inp.value.normalize("NFKC").trim();
  if (p.length < PASS_MIN) { msg.textContent = `合言葉は${PASS_MIN}文字以上にしてください。`; inp.focus(); return; }
  btn.disabled = true; msg.textContent = "設定中…（データを移しています）";
  try {
    const k = await keyFromPass(p);
    if (k === KEY) { msg.textContent = "今と同じ合言葉です。"; return; }
    if (await boardHasItems(k)) { msg.textContent = "この合言葉は使えません。別の合言葉にしてください。"; return; }
    const its = [...S.items.values()];
    for (let i = 0; i < its.length; i += 400) {
      const b = writeBatch(fs);
      its.slice(i, i + 400).forEach(it => { const o = {}; ITEM_FIELDS.forEach(f => { o[f] = it[f] ?? null; }); o.stock = Number(o.stock) || 0; b.set(doc(fs, "stores", k, "items", it.id), o); });
      await b.commit();
    }
    const logs = (await getDocs(logsCol())).docs;
    for (let i = 0; i < logs.length; i += 400) {
      const b = writeBatch(fs);
      logs.slice(i, i + 400).forEach(d => b.set(doc(fs, "stores", k, "logs", d.id), d.data()));
      await b.commit();
    }
    store.set("zaiko-key", k); store.set("zaiko-flash", "合言葉を設定しました。スタッフには合言葉を伝えてください");
    location.hash = "k=" + k; location.reload();
  } catch (e) { console.error(e); msg.textContent = "途中で設定できませんでした。通信状態を確認して、もう一度押してください。"; }
  finally { btn.disabled = false; }
}

/* ---------- events ---------- */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act], .tab"); if (!el) return;
  if (el.classList.contains("tab")) { S.view = el.dataset.view; store.set("zaiko-view", S.view); render(); window.scrollTo(0, 0); return; }
  const act = el.dataset.act, id = el.dataset.id;
  if (act === "scrim" && e.target !== el) return;
  switch (act) {
    case "create": { KEY = newKey(); location.hash = "k=" + KEY; location.reload(); break; }
    case "dept": S.dept = el.dataset.v; render(); break;
    case "cat": S.cat = el.dataset.v; render(); break;
    case "filter": S.filter = el.dataset.v; render(); break;
    case "goUnset": S.view = "stock"; S.filter = "unset"; render(); break;
    case "goSettings": S.view = "settings"; render(); break;
    case "open": openSheet(id); break;
    case "close": case "scrim": closeSheet(); break;
    case "use": await changeStock(id, -1, "use", 1); break;
    case "plus": await changeStock(id, 1, "count"); break;
    case "count": { const v = num($("#s-count").value); if (v == null || v < 0) { $("#s-count").focus(); break; }
      const it = S.items.get(id); if (await changeStock(id, v - (Number(it.stock) || 0), "count")) toast(`${it.name}を${fmt(v)}に直しました`); break; }
    case "ordered": case "orderSheet": { const inp = act === "ordered" ? $("#oq-" + id) : $("#s-order"); const q = num(inp.value);
      if (!(q > 0)) { inp.focus(); toast("注文した数を入れてください"); break; }
      if (await setOrdered(id, q)) toast(`${S.items.get(id).name}を入荷待ちにしました`); break; }
    case "received": case "recvSheet": { const inp = act === "received" ? $("#rq-" + id) : $("#s-recv"); const q = num(inp.value);
      if (!(q >= 0)) { inp.focus(); break; }
      if (await changeStock(id, q, "receive", q)) toast(`${S.items.get(id).name}の入荷を登録しました`); break; }
    case "addSheet": { const q = num($("#s-add").value); if (!(q > 0)) { $("#s-add").focus(); break; }
      if (await changeStock(id, q, "receive", q)) toast("入荷を登録しました"); break; }
    case "cancelOrder": if (await cancelOrder(id)) toast("注文を取り消しました"); break;
    case "useEst": $("#f-monthly").value = el.dataset.v; updatePreview(); toast("月の使用量に入れました。保存を押すと反映されます"); break;
    case "del": {
      if (!S.delArm) { S.delArm = true; el.textContent = "もう一度押すと削除します"; setTimeout(() => { S.delArm = false; const b = $("#del-btn"); if (b) b.textContent = "この品目を削除"; }, 4000); break; }
      const name = S.items.get(id)?.name; if (await write(id, () => deleteDoc(itemDoc(id)))) { toast(`${name}を削除しました`); closeSheet(); } break; }
    case "setPass": setPass(); break;
    case "saveName": { store.set("zaiko-name", $("#set-name").value.trim()); toast("名前を保存しました"); break; }
    case "copyLink": copyText(boardLink(), $("#set-link"), "リンクをコピーしました"); break;
    case "export": exportData(); break;
    case "import": importData(); break;
    case "copy": {
      const need = items().filter(inDept).filter(i => needsOrder(calc(i)));
      const by = new Map(); need.forEach(i => { const k = i.supplier || "注文先未設定"; if (!by.has(k)) by.set(k, []); by.get(k).push(i); });
      const text = `【注文リスト ${md(Date.now())}】\n` + [...by].map(([s, arr]) => `■ ${s}\n` + arr.map(i => { const q = num($("#oq-" + i.id)?.value) ?? calc(i).oq; return `・${i.name} × ${q != null ? fmt(q) : "?"}${i.unit || ""}`; }).join("\n")).join("\n");
      copyText(text, null, "注文リストをコピーしました", el.closest(".group"));
      break; }
  }
});
async function copyText(text, inputEl, okMsg, holder) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch {
    if (inputEl) { inputEl.select(); toast("選択した文字をコピーしてください"); return; }
    const ta = document.createElement("textarea"); ta.value = text; ta.readOnly = true; ta.style.cssText = "width:100%;height:160px";
    (holder || $("#app")).appendChild(ta); ta.select(); toast("表示した文字を選択してコピーしてください");
  }
}
document.addEventListener("input", (e) => {
  if (e.target.id === "q") { S.q = e.target.value; const pos = e.target.selectionStart; render(); const q = $("#q"); if (q) { q.focus(); q.setSelectionRange(pos, pos); } }
  if (e.target.closest && e.target.closest("#item-form")) updatePreview();
});
document.addEventListener("submit", (e) => {
  if (e.target.id === "item-form") { e.preventDefault(); saveForm(); }
  if (e.target.id === "pass-form") { e.preventDefault(); openWithPass(); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.sheet) closeSheet(); });
$("#fab-add").addEventListener("click", () => openSheet("new"));
window.addEventListener("hashchange", () => { if (readKey() !== KEY) location.reload(); });

/* ---------- boot ---------- */
function showMessage(title, body, extra = "") {
  $("#app").innerHTML = `<div class="setup"><h2>${title}</h2>${body}${extra}</div>`;
}
function boot() {
  const sync = $("#sync");
  if (!FIREBASE_CONFIG || !FIREBASE_CONFIG.projectId || String(FIREBASE_CONFIG.apiKey).includes("ここに")) {
    sync.textContent = "準備中";
    showMessage("Firebaseの設定がまだです", `<p>firebase-config.js に、Firebaseの画面でコピーした設定を貼り付けてください。手順は README.md にあります。</p>`);
    return;
  }
  try { fs = getFirestore(initializeApp(FIREBASE_CONFIG)); }
  catch (e) { console.error(e); showMessage("Firebaseに接続できませんでした", `<p>firebase-config.js の内容が正しいか確認してください。</p>`); return; }
  KEY = readKey();
  if (!KEY) {
    // 「新しい在庫ボードを作る」は、アドレスの最後に #new を付けたときだけ出す（間違えて作らないように）
    const allowCreate = /(^#|&)new/.test(location.hash);
    sync.textContent = "合言葉が必要です";
    showMessage("合言葉を入れてください",
      `<p>院内で決めた合言葉を入れてください。この端末では、次からは入れなくても開けます。</p>
      <form id="pass-form" class="copyline" autocomplete="off"><input id="pass-in" aria-label="合言葉" placeholder="合言葉" style="background:var(--surface)"><button class="btn primary" id="pass-open" type="submit">開く</button></form>
      <p id="pass-msg"></p><p>合言葉が分からないときは、管理している人に聞いてください。</p>`,
      !allowCreate ? "" : `<div class="box"><h4>はじめて使う場合</h4><p>新しい在庫ボードを作ると、専用のリンクが発行されます。作ったあとは「設定」タブでリンクをコピーして、スタッフに共有してください。</p><div class="acts"><button class="btn primary" data-act="create">新しい在庫ボードを作る</button></div></div>`);
    return;
  }
  $("#tabs").hidden = false;
  const flash = store.get("zaiko-flash"); if (flash) { store.set("zaiko-flash", ""); try { localStorage.removeItem("zaiko-flash"); } catch {} toast(flash); }
  const v = store.get("zaiko-view"); if (["order", "stock", "log", "settings"].includes(v)) S.view = v;
  const timer = setTimeout(() => { if (!S.gotItems) sync.textContent = "データにまだつながりません。通信を確認してください"; }, 10000);
  onSnapshot(itemsCol(), { includeMetadataChanges: false }, (snap) => {
    S.items = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    if (!snap.metadata.fromCache) { S.gotItems = true; clearTimeout(timer); }
    S.loaded = true;
    sync.textContent = S.gotItems ? "最新の状態" : "保存済みのデータを表示中";
    render();
  }, (e) => {
    console.error(e); clearTimeout(timer); S.loaded = true;
    sync.textContent = "データを読み込めませんでした";
    showMessage("データを読み込めませんでした", `<p>${e && e.code === "permission-denied" ? "Firebaseのルール設定（firestore.rules）が反映されているか確認してください。" : "通信状態を確認して、ページを開き直してください。"}</p>`);
  });
  onSnapshot(query(logsCol(), where("t", ">=", Date.now() - 90 * DAY), orderBy("t", "desc"), limit(1000)), (snap) => {
    S.logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (S.view === "log" || S.sheet) render();
  }, (e) => console.error(e));
}
boot();
