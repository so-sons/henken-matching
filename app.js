/* 偏見ゲッサー — イナゲッサーの「質問モード」をベースにした対戦専用ゲーム。
   - 出題者がお題のキャラを1人決める
   - 回答者は順番に「偏見（「　」そうですか？）」「自由質問（回数制限あり）」「回答（キャラ名）」のどれか1つを行う
   - 通信は PeerJS (WebRTC) でホスト権威型。ホストが進行を管理し、ゲストは操作を送るだけ
   loader.js が data.bin を復号したあと GAME_START(data) で起動する */
window.GAME_START = (D) => {
  "use strict";

  const CFG = window.GAME_CONFIG;
  const C = D.chars;
  const LISTS = D.lists || D;
  const F = CFG.fields;
  const $ = (id) => document.getElementById(id);
  const PEER_PREFIX = CFG.id + "-";
  const PLAYER_COLORS = ["#e0a800", "#1e88e5", "#e53976", "#2e9e4f"];
  const MAX_PLAYERS = CFG.maxPlayers || 4;
  const ITEM = CFG.itemLabel || "キャラ";

  // ---------------------------------------------------------------- utils
  const kanaNorm = (s) =>
    String(s || "")
      .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[\s・･ｰー\-‐]/g, "")
      .toLowerCase();
  const nameOf = (c) => c[F.name];
  const kanaOf = (c) => (F.kana && c[F.kana]) || "";
  const aliasOf = (c) => (F.alias && c[F.alias]) || "";
  const isMain = (c) => !!(F.main && c[F.main]);
  const imgUrl = (c) => (CFG.imageBase && F.image && c[F.image] ? CFG.imageBase + c[F.image] + (CFG.imageExt || "") : "");
  const SEARCH = C.map((c) => ({ n: kanaNorm(nameOf(c)), k: kanaNorm(kanaOf(c)), a: kanaNorm(aliasOf(c)) }));
  const NAME_TO_IDX = new Map(C.map((c, i) => [nameOf(c), i]));
  const MAIN_IDX = C.map((c, i) => (isMain(c) ? i : -1)).filter((i) => i >= 0);

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtClock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
  const randInt = (n) => Math.floor(Math.random() * n);

  let toastTimer = null;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 1800);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("コピーしました"); }
    catch {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("コピーしました"); } catch { toast("コピーできませんでした"); }
      ta.remove();
    }
  }

  // ------------------------------------------------------- 題材ごとの文言
  function applyConfigText() {
    document.title = CFG.title;
    $("brand-text").textContent = CFG.title;
    $("hero-kicker").textContent = CFG.kicker || "";
    const h1 = $("hero-title"); h1.innerHTML = "";
    String(CFG.heroTitle || CFG.title).split("\n").forEach((line, i) => { if (i) h1.appendChild(el("br")); h1.appendChild(document.createTextNode(line)); });
    $("hero-example").textContent = CFG.biasExample || "〇〇";
    $("rule-free-example").textContent = CFG.freeExample || "";
    document.querySelectorAll(".item-label").forEach((e) => (e.textContent = ITEM));
    $("bias-input").placeholder = "例：" + (CFG.biasExample || "");
    $("free-input").placeholder = "例：" + (CFG.freeExample || "");
    $("guess-input").placeholder = `${ITEM}名を入力（ひらがなOK）`;
    const foot = $("foot"); foot.innerHTML = "";
    foot.appendChild(document.createTextNode(CFG.credit || ""));
    if (CFG.creditLink) { const a = el("a", null, CFG.creditLink.label); a.href = CFG.creditLink.url; a.target = "_blank"; a.rel = "noopener"; foot.append(" ", a, " "); }
    foot.appendChild(document.createTextNode(CFG.creditTail || ""));
  }
  function displayFull(at, c) {
    const v = c[at.key];
    if (at.type === "set") return (v && v.length) ? v.join(" / ") : (at.empty || "なし");
    if (at.labels) return LISTS[at.labels][v] ?? String(v);
    return v == null ? "-" : String(v);
  }

  // -------------------------------------------------------------- suggest
  function searchChars(q, ex) {
    const nq = kanaNorm(q);
    if (!nq) return [];
    const starts = [], contains = [];
    for (let i = 0; i < C.length; i++) {
      if (ex && ex.has(i)) continue;
      const s = SEARCH[i];
      if (s.n.startsWith(nq) || s.k.startsWith(nq) || s.a.startsWith(nq)) starts.push(i);
      else if (s.n.includes(nq) || s.k.includes(nq) || s.a.includes(nq)) contains.push(i);
    }
    const byMain = (a, b) => (isMain(C[b]) - isMain(C[a])) || a - b;
    starts.sort(byMain); contains.sort(byMain);
    return starts.concat(contains).slice(0, 40);
  }
  // 名前入力＋候補リスト。Enter／クリックで onPick(idx)。exclude() で除外する候補を返す
  function attachSuggest(input, ul, onPick, exclude) {
    let items = [], active = -1;
    const render = () => {
      const q = input.value; items = searchChars(q, exclude ? exclude() : null); ul.innerHTML = "";
      if (!q.trim()) { ul.hidden = true; return; }
      if (!items.length) ul.appendChild(el("li", "s-empty", `該当する${ITEM}がいません`));
      else items.forEach((i, k) => {
        const c = C[i]; const li = el("li", k === active ? "active" : "");
        li.appendChild(el("span", "s-name", nameOf(c)));
        if (kanaOf(c)) li.appendChild(el("span", "s-kana", kanaOf(c)));
        if (CFG.suggestSub) li.appendChild(el("span", "s-team", CFG.suggestSub(c)));
        li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(i); });
        ul.appendChild(li);
      });
      ul.hidden = false;
    };
    const hide = () => { ul.hidden = true; active = -1; };
    const pick = (i) => { input.value = ""; hide(); onPick(i); };
    const resolve = () => {
      const q = input.value.trim(); if (!q) return -1;
      if (active >= 0 && items[active] != null) return items[active];
      if (NAME_TO_IDX.has(q)) return NAME_TO_IDX.get(q);
      const nq = kanaNorm(q);
      const exact = items.filter((i) => SEARCH[i].n === nq || SEARCH[i].k === nq || SEARCH[i].a === nq);
      if (exact.length === 1) return exact[0];
      return items.length === 1 ? items[0] : -1;
    };
    input.addEventListener("input", () => { active = -1; render(); });
    input.addEventListener("focus", render);
    input.addEventListener("blur", () => setTimeout(hide, 120));
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "ArrowDown") { e.preventDefault(); if (items.length) { active = (active + 1) % items.length; render(); } }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (items.length) { active = (active - 1 + items.length) % items.length; render(); } }
      else if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") hide();
    });
    const submit = () => { const i = resolve(); if (i >= 0) pick(i); else toast(`候補から${ITEM}を選んでください`); };
    return { submit };
  }

  // --------------------------------------------------------------- screens
  function showScreen(name) {
    ["home", "lobby", "game"].forEach((s) => ($("screen-" + s).hidden = s !== name));
    window.scrollTo(0, 0);
  }
  function goHome() {
    leaveVersus();
    stopTimer();
    $("topbar-status").textContent = "";
    showScreen("home");
  }

  // ----------------------------------------------------------- 回答の種類
  // 偏見への答え（出題者のイメージで答える）
  const BIAS_ANSWERS = [
    { k: "yes", label: "めっちゃそう" }, { k: "pyes", label: "ちょっとそう" }, { k: "unknown", label: "どっちとも" },
    { k: "pno", label: "あんまり" }, { k: "no", label: "ぜんぜん" },
  ];
  // 自由質問への答え
  const FREE_ANSWERS = [
    { k: "yes", label: "はい" }, { k: "pyes", label: "部分的にはい" }, { k: "unknown", label: "わからない" },
    { k: "pno", label: "部分的にいいえ" }, { k: "no", label: "いいえ" },
  ];
  const answersFor = (kind) => (kind === "b" ? BIAS_ANSWERS : FREE_ANSWERS);
  const answerLabel = (kind, k) => (answersFor(kind).find((a) => a.k === k) || {}).label || "";
  const biasText = (q) => `「${q}」そうですか？`;
  // 「〜そうですか？」まで書いてしまった場合は空欄部分だけにする
  const normBias = (q) => String(q || "").replace(/\s+/g, " ").trim()
    .replace(/^「|」$/g, "").replace(/[。．.！!？?\s]+$/, "").replace(/」?そう(です|だ)?か?$/, "").replace(/」$/, "").trim().slice(0, 60);
  const normFree = (q) => String(q || "").replace(/\s+/g, " ").trim().slice(0, 80);

  // ---------------------------------------------------------------- versus
  const vs = { peer: null, isHost: false, code: null, conn: null, host: null, pub: null, me: -1, deadlineLocal: null, name: "", myTopic: -1 };
  const NICK_KEY = CFG.id + ".nick";
  const OPTS_KEY = CFG.id + ".opts";
  try { vs.name = localStorage.getItem(NICK_KEY) || ""; } catch {}
  const DEFAULT_OPTS = { bMax: 0, fMax: 3, gMax: 3, turnSec: 90 };
  function savedOpts() {
    try { const o = JSON.parse(localStorage.getItem(OPTS_KEY) || "null"); if (o) return sanitizeOpts(o); } catch {}
    return { ...DEFAULT_OPTS };
  }
  const clampSel = (v, allowed, def) => (allowed.includes(+v) ? +v : def);
  const sanitizeOpts = (o) => ({
    bMax: clampSel(o.bMax, [0, 10, 15, 20, 30], DEFAULT_OPTS.bMax),
    fMax: clampSel(o.fMax, [2, 3, 4, 5], DEFAULT_OPTS.fMax),
    gMax: clampSel(o.gMax, [1, 2, 3, 4, 5], DEFAULT_OPTS.gMax),
    turnSec: clampSel(o.turnSec, [0, 30, 60, 90, 120], DEFAULT_OPTS.turnSec),
  });

  function myNick() {
    const n = $("nickname").value.trim() || "プレイヤー";
    vs.name = n; try { localStorage.setItem(NICK_KEY, n); } catch {}
    return n;
  }
  const peerAvailable = () => typeof window.Peer === "function";
  const lobbyStatus = (msg) => { $("lobby-status").textContent = msg || ""; };

  function openLobby(prefillCode) {
    showScreen("lobby");
    $("nickname").value = vs.name;
    $("lobby-choice").hidden = false; $("lobby-room").hidden = true;
    $("join-code").value = prefillCode || "";
    lobbyStatus(peerAvailable() ? "" : "通信ライブラリを読み込めませんでした。ネットワーク環境を確認してください。");
  }
  const makePeer = (id) => new Peer(id, { debug: 1 });

  // ---- host
  function createRoom() {
    if (!peerAvailable()) { toast("通信ライブラリが読み込めていません"); return; }
    const name = myNick();
    lobbyStatus("ルームを作成中…");
    $("btn-create-room").disabled = true;
    tryHostCode(0, name);
  }
  function tryHostCode(attempt, name) {
    const code = String(100000 + randInt(900000));
    const peer = makePeer(PEER_PREFIX + code);
    let settled = false;
    peer.on("open", () => {
      settled = true;
      vs.peer = peer; vs.isHost = true; vs.code = code; vs.me = 0;
      vs.host = {
        players: [{ name, conn: null, connected: true, out: false }],
        status: "lobby", setter: 0, answer: -1,
        opts: savedOpts(),
        log: [],            // [{k:"b"|"f", p, q, a} | {k:"g", p, idx, ok}] を時系列で
        bLeft: 0, fLeft: 0, gLeft: 0, phase: "ask",
        turn: 0, turnNo: 1, deadline: null, winner: null, reason: null, events: [],
      };
      peer.on("connection", onHostConnection);
      peer.on("disconnected", () => { lobbyStatus("シグナリングサーバーから切断されました。再接続中…"); try { peer.reconnect(); } catch {} });
      peer.on("error", (e) => { console.warn(e); if (e.type !== "peer-unavailable") toast("通信エラー: " + e.type); });
      $("btn-create-room").disabled = false;
      enterRoomView();
      hostBroadcast();
    });
    peer.on("error", (e) => {
      if (settled) return;
      settled = true;
      try { peer.destroy(); } catch {}
      if (e.type === "unavailable-id" && attempt < 5) { tryHostCode(attempt + 1, name); return; }
      $("btn-create-room").disabled = false;
      lobbyStatus("ルームを作成できませんでした（" + e.type + "）。時間をおいて再度お試しください。");
    });
  }
  function onHostConnection(conn) {
    conn.on("open", () => {
      conn.on("data", (msg) => hostOnMessage(conn, msg));
      conn.on("close", () => hostOnLeave(conn));
      conn.on("error", () => hostOnLeave(conn));
    });
  }
  const hostSend = (conn, msg) => { try { conn.send(msg); } catch {} };
  function errTo(pIdx, msg) { const p = vs.host.players[pIdx]; if (p && p.conn) hostSend(p.conn, { t: "error", msg }); else toast(msg); }
  function hostOnMessage(conn, msg) {
    const H = vs.host; if (!H || !msg || typeof msg !== "object") return;
    const pIdx = H.players.findIndex((p) => p.conn === conn);
    if (msg.t === "join") {
      if (pIdx >= 0) return;
      if (H.status !== "lobby") { hostSend(conn, { t: "error", msg: "対戦中のため参加できません。次のゲームまでお待ちください。" }); return; }
      if (H.players.filter((p) => p.connected).length >= MAX_PLAYERS) { hostSend(conn, { t: "error", msg: "満員です（最大" + MAX_PLAYERS + "人）" }); return; }
      const name = String(msg.name || "プレイヤー").slice(0, 12);
      H.players.push({ name, conn, connected: true, out: false });
      hostSend(conn, { t: "welcome", you: H.players.length - 1 });
      hostEvent(`${name} が参加しました`);
      hostBroadcast();
      return;
    }
    if (pIdx < 0) return;
    if (msg.t === "ask") hostAsk(pIdx, msg.k, msg.q);
    else if (msg.t === "guess") hostGuess(pIdx, msg.idx | 0);
    else if (msg.t === "topic") { if (pIdx === H.setter) hostSetTopic(msg.idx | 0); }
    else if (msg.t === "answer") { if (pIdx === H.setter) hostAnswer(msg.k); }
    else if (msg.t === "surrender") hostSurrender(pIdx);
  }
  function hostOnLeave(conn) {
    const H = vs.host; if (!H) return;
    const p = H.players.find((x) => x.conn === conn);
    if (!p || !p.connected) return;
    p.connected = false;
    hostEvent(`${p.name} が切断しました`);
    if (H.status === "lobby") {
      const setterP = H.players[H.setter];
      H.players = H.players.filter((x) => x.connected);
      const si = H.players.indexOf(setterP);
      if (si < 0) { H.setter = 0; H.answer = -1; } else H.setter = si;
      H.players.forEach((x, i) => { if (x.conn) hostSend(x.conn, { t: "welcome", you: i }); });
    } else if (H.status === "playing") {
      const i = H.players.indexOf(p);
      if (i === H.setter) { finish(null, "setter_left"); hostBroadcast(); return; }
      checkRemaining();
      if (H.status === "playing" && H.turn === i && H.phase === "ask") advanceTurn();
    }
    hostBroadcast();
  }
  function hostEvent(text) { const H = vs.host; H.events.push(text); if (H.events.length > 20) H.events.shift(); }
  const setterName = (pub) => (pub.players[pub.setter] ? pub.players[pub.setter].name : "出題者");
  const eligible = (H, i) => { const p = H.players[i]; return !!p && p.connected && !p.out && i !== H.setter; };

  function hostStart() {
    const H = vs.host;
    if (H.players.filter((p) => p.connected).length < 2) { toast("回答者が1人以上必要です"); return; }
    if (!(H.answer >= 0)) { toast("お題が決まっていません"); return; }
    const setterP = H.players[H.setter];
    H.players = H.players.filter((p) => p.connected);
    H.setter = Math.max(0, H.players.indexOf(setterP));
    H.players.forEach((p, i) => { p.out = false; if (p.conn) hostSend(p.conn, { t: "welcome", you: i }); });
    H.log = []; H.winner = null; H.reason = null; H.events = [];
    H.bLeft = H.opts.bMax || Infinity; H.fLeft = H.opts.fMax; H.gLeft = H.opts.gMax; H.phase = "ask";
    H.status = "playing";
    H.turn = H.setter; H.turnNo = 1;
    advanceTurn(); H.turnNo = 1;
    hostEvent(`対戦開始！ ${H.players[H.setter].name} のお題を偏見で当てよう`);
    hostBroadcast();
  }
  function hostBackToLobby(rotateSetter) {
    const H = vs.host; if (!H) return;
    const cur = H.players[H.setter];
    H.status = "lobby"; H.answer = -1; H.log = []; H.winner = null; H.reason = null; H.events = []; H.phase = "ask"; H.deadline = null;
    H.players = H.players.filter((p) => p.connected);
    H.players.forEach((p, i) => { p.out = false; if (p.conn) hostSend(p.conn, { t: "welcome", you: i }); });
    let si = Math.max(0, H.players.indexOf(cur));
    if (rotateSetter && H.players.length > 1) si = (si + 1) % H.players.length;
    H.setter = si;
    hostBroadcast();
  }
  function hostSetOptions(o) {
    const H = vs.host; if (!H || H.status !== "lobby") return;
    H.opts = sanitizeOpts(o);
    try { localStorage.setItem(OPTS_KEY, JSON.stringify(H.opts)); } catch {}
    hostBroadcast();
  }
  function hostSetSetter(i) {
    const H = vs.host; if (!H || H.status !== "lobby") return;
    if (!(i >= 0 && i < H.players.length)) return;
    if (H.setter !== i) { H.setter = i; H.answer = -1; hostEvent(`出題者が ${H.players[i].name} に交代`); }
    hostBroadcast();
  }
  function hostSetTopic(idx) {
    const H = vs.host; if (!H || H.status !== "lobby") return;
    H.answer = idx >= 0 && idx < C.length ? idx : -1;
    hostBroadcast();
  }
  // 出題者（ホストでもゲストでも）がお題を選ぶ／取り消す
  function pickTopic(idx) {
    if (vs.isHost) { hostSetTopic(idx); return; }
    vs.myTopic = idx >= 0 ? idx : -1;
    if (vs.conn) vs.conn.send({ t: "topic", idx: vs.myTopic });
    renderTopicUI();
  }
  const randomTopic = () => pickTopic((MAIN_IDX.length ? MAIN_IDX : C.map((_, i) => i))[randInt(MAIN_IDX.length || C.length)]);
  const myTopicIdx = () => (vs.isHost ? (vs.host ? vs.host.answer : -1) : vs.myTopic);
  function renderTopicUI() {
    const pub = vs.pub;
    const on = !!pub && vs.me === pub.setter && pub.status === "lobby";
    $("topic-field").hidden = !on;
    if (!on) return;
    const idx = myTopicIdx(); const chosen = idx >= 0;
    $("topic-picker").hidden = chosen; $("topic-chosen").hidden = !chosen; $("btn-topic-random-2").hidden = chosen;
    if (chosen) $("topic-name").textContent = nameOf(C[idx]);
  }

  // 回答者の質問（k: "b"=偏見, "f"=自由質問）
  function hostAsk(pIdx, k, q) {
    const H = vs.host;
    if (H.status !== "playing" || H.phase !== "ask" || H.turn !== pIdx || !eligible(H, pIdx)) return;
    if (k !== "b" && k !== "f") return;
    q = k === "b" ? normBias(q) : normFree(q);
    if (!q) return;
    if (k === "b" && H.bLeft <= 0) { errTo(pIdx, "偏見の回数がもうありません"); return; }
    if (k === "f" && H.fLeft <= 0) { errTo(pIdx, "自由質問の回数がもうありません"); return; }
    H.log.push({ k, p: pIdx, q, a: null });
    if (k === "b") H.bLeft--; else H.fLeft--;
    H.phase = "answer";
    H.deadline = H.opts.turnSec ? Date.now() + H.opts.turnSec * 1000 : null;
    hostBroadcast();
  }
  // 出題者の返事
  function hostAnswer(a) {
    const H = vs.host;
    if (!H || H.status !== "playing" || H.phase !== "answer") return;
    const last = H.log[H.log.length - 1]; if (!last || (last.k !== "b" && last.k !== "f") || last.a) return;
    if (!answersFor(last.k).some((x) => x.k === a)) return;
    last.a = a;
    H.phase = "ask";
    if (H.bLeft <= 0 && H.fLeft <= 0) hostEvent(`質問はもう使い切りました。あとは回答（${ITEM}名）だけです`);
    H.turnNo++;
    advanceTurn();
    hostBroadcast();
  }
  function hostGuess(pIdx, idx) {
    const H = vs.host;
    if (H.status !== "playing" || H.phase !== "ask" || H.turn !== pIdx || !eligible(H, pIdx)) return;
    if (!(idx >= 0 && idx < C.length)) return;
    if (H.gLeft <= 0) { errTo(pIdx, "回答できる回数がもうありません"); return; }
    if (H.log.some((g) => g.k === "g" && g.idx === idx)) { errTo(pIdx, `すでに回答された${ITEM}です`); return; }
    const ok = idx === H.answer;
    H.log.push({ k: "g", p: pIdx, idx, ok });
    H.gLeft--;
    if (ok) finish(pIdx, "correct");
    else {
      hostEvent(`${H.players[pIdx].name} の回答「${nameOf(C[idx])}」は不正解（回答 残り${H.gLeft}回）`);
      if (H.gLeft <= 0) finish(null, "no_guesses");
      else { H.turnNo++; advanceTurn(); }
    }
    hostBroadcast();
  }
  function hostSurrender(pIdx) {
    const H = vs.host;
    if (H.status !== "playing") return;
    const p = H.players[pIdx]; if (!p || p.out || pIdx === H.setter) return;
    p.out = true; hostEvent(`${p.name} が降参しました`);
    checkRemaining();
    if (H.status === "playing" && H.turn === pIdx && H.phase === "ask") advanceTurn();
    hostBroadcast();
  }
  function checkRemaining() {
    const H = vs.host;
    if (!H.players.some((p, i) => eligible(H, i))) finish(null, "all_out");
  }
  function advanceTurn() {
    const H = vs.host;
    const n = H.players.length;
    for (let k = 1; k <= n; k++) {
      const cand = (H.turn + k) % n;
      if (eligible(H, cand)) { H.turn = cand; break; }
    }
    H.deadline = H.opts.turnSec ? Date.now() + H.opts.turnSec * 1000 : null;
  }
  function finish(winner, reason) { const H = vs.host; H.status = "finished"; H.winner = winner; H.reason = reason; H.deadline = null; }
  function hostTick() {
    const H = vs.host;
    if (!H || H.status !== "playing" || !H.deadline || Date.now() < H.deadline) return;
    if (H.phase === "answer") { hostEvent(`${H.players[H.setter].name} が時間内に答えなかったので「${answerLabel(H.log[H.log.length - 1].k, "unknown")}」扱い`); hostAnswer("unknown"); return; }
    hostEvent(`${H.players[H.turn].name} は時間切れ`); H.turnNo++; advanceTurn(); hostBroadcast();
  }
  function publicState() {
    const H = vs.host;
    const fin = (x) => (x === Infinity ? -1 : x);   // -1 = 無制限
    return {
      status: H.status, topicChosen: H.answer >= 0, setter: H.setter,
      players: H.players.map((p) => ({ name: p.name, connected: p.connected, out: p.out })),
      opts: H.opts, log: H.log, bLeft: fin(H.bLeft), fLeft: H.fLeft, gLeft: H.gLeft, phase: H.phase,
      turn: H.turn, turnNo: H.turnNo, now: Date.now(), deadline: H.deadline,
      winner: H.winner, reason: H.reason, events: H.events,
      answer: H.status === "finished" ? H.answer : -1,
    };
  }
  function hostBroadcast() {
    const H = vs.host; if (!H) return;
    const pub = publicState();
    H.players.forEach((p) => { if (p.conn && p.connected) hostSend(p.conn, { t: "state", s: pub }); });
    applyState(pub);
  }

  // ---- guest
  function joinRoom() {
    if (!peerAvailable()) { toast("通信ライブラリが読み込めていません"); return; }
    const code = $("join-code").value.replace(/\D/g, "");
    if (code.length !== 6) { toast("6桁のコードを入力してください"); return; }
    const name = myNick();
    lobbyStatus("ルームに接続中…");
    $("btn-join-room").disabled = true;
    const peer = makePeer(undefined);
    let joined = false;
    const fail = (msg) => { if (joined) return; joined = true; $("btn-join-room").disabled = false; lobbyStatus(msg); try { peer.destroy(); } catch {} };
    const timeout = setTimeout(() => fail("ホストに接続できませんでした。コードを確認してください。"), 15000);
    peer.on("open", () => {
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      conn.on("open", () => {
        clearTimeout(timeout); joined = true;
        vs.peer = peer; vs.conn = conn; vs.isHost = false; vs.code = code;
        $("btn-join-room").disabled = false;
        conn.send({ t: "join", name });
        conn.on("data", guestOnMessage);
        conn.on("close", onHostLost);
        conn.on("error", onHostLost);
        enterRoomView();
      });
    });
    peer.on("error", (e) => {
      clearTimeout(timeout);
      fail(e.type === "peer-unavailable" ? "そのコードのルームが見つかりません。" : "接続エラー: " + e.type);
    });
  }
  function guestOnMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "welcome") vs.me = msg.you | 0;
    else if (msg.t === "state") applyState(msg.s);
    else if (msg.t === "error") { toast(msg.msg || "エラー"); lobbyStatus(msg.msg || ""); }
  }
  function onHostLost() {
    if (!vs.peer) return;
    toast("ホストとの接続が切れました");
    if (vs.pub && vs.pub.status === "playing") {
      stopTimer(); $("act-panel").hidden = true; $("answer-panel").hidden = true;
      $("turn-who").textContent = "接続終了"; $("turn-timer").textContent = "";
      vs.pub = null; try { vs.peer.destroy(); } catch {} vs.peer = null; vs.conn = null;
    } else { leaveVersus(); openLobby(); lobbyStatus("ホストとの接続が切れました。"); }
  }

  // ---- shared
  function enterRoomView() {
    $("lobby-choice").hidden = true; $("lobby-room").hidden = false;
    $("room-code-display").textContent = vs.code;
    $("btn-start").hidden = !vs.isHost;
    lobbyStatus("");
    $("topbar-status").textContent = "ルーム " + vs.code;
  }
  function leaveVersus() {
    stopTimer();
    try { vs.conn && vs.conn.close(); } catch {}
    try { vs.peer && vs.peer.destroy(); } catch {}
    vs.peer = null; vs.conn = null; vs.host = null; vs.pub = null; vs.isHost = false; vs.code = null; vs.me = -1; vs.myTopic = -1;
    lastStatus = null;
    $("topbar-status").textContent = "";
  }
  function renderPlayers(ul, pub) {
    ul.innerHTML = "";
    pub.players.forEach((p, i) => {
      const li = el("li", (i === vs.me ? "me " : "") + (pub.status === "playing" && pub.turn === i && pub.phase === "ask" ? "turn " : "") + (!p.connected || p.out ? "offline" : ""));
      const dot = el("span", "pdot"); dot.style.setProperty("--c", PLAYER_COLORS[i % PLAYER_COLORS.length]); li.appendChild(dot);
      li.appendChild(el("span", null, p.name + (i === 0 ? "（ホスト）" : "")));
      const setter = i === pub.setter;
      const tag = !p.connected ? "切断" : p.out ? "降参" : setter ? (i === vs.me ? "出題者（あなた）" : "出題者") : i === vs.me ? "あなた" : "";
      if (tag) li.appendChild(el("span", "ptag", tag));
      ul.appendChild(li);
    });
  }
  const optsSummary = (o) => [
    o.bMax ? `偏見 ${o.bMax}回` : "偏見 無制限", `自由質問 ${o.fMax}回`, `回答 ${o.gMax}回`, o.turnSec ? `1手 ${o.turnSec}秒` : "制限時間なし",
  ].join("・");
  function renderLobby(pub) {
    renderPlayers($("lobby-players"), pub);
    // 設定
    $("room-options").hidden = false;
    $("room-options-host").hidden = !vs.isHost;
    $("room-options-summary").textContent = optsSummary(pub.opts);
    if (vs.isHost) {
      const set = (id, v) => { const e = $(id); if (e.value !== String(v)) e.value = String(v); };
      set("room-bias", pub.opts.bMax); set("room-free", pub.opts.fMax); set("room-guess", pub.opts.gMax); set("room-turn-seconds", pub.opts.turnSec);
      // 出題者の選択
      $("setter-field").hidden = false;
      const sel = $("setter-select"); sel.innerHTML = "";
      pub.players.forEach((p, i) => { const o = el("option", null, p.name + (i === 0 ? "（ホスト）" : "")); o.value = String(i); sel.appendChild(o); });
      sel.value = String(pub.setter);
      $("btn-start").disabled = pub.players.filter((p) => p.connected).length < 2 || !pub.topicChosen;
    } else $("setter-field").hidden = true;
    if (!pub.topicChosen) vs.myTopic = -1;
    renderTopicUI();
    const meSet = vs.me === pub.setter;
    const n = pub.players.filter((p) => p.connected).length;
    $("lobby-hint").textContent = vs.isHost
      ? (n < 2 ? "友達にコードを伝えて、参加を待ちましょう。" : meSet ? (pub.topicChosen ? "お題が決まりました。「対戦開始」で始めましょう。" : "お題を選んでください。") : (pub.topicChosen ? `${setterName(pub)} がお題を決めました。「対戦開始」で始められます。` : `${setterName(pub)} がお題を選んでいます…`))
      : (meSet ? (pub.topicChosen ? "お題を決めました。ホストが開始するまでお待ちください。" : "あなたが出題者です。お題を選んでください。") : (pub.topicChosen ? "お題は決まりました。ホストが開始するまでお待ちください。" : `${setterName(pub)} がお題を選んでいます…`));
  }

  let lastStatus = null;
  let actTab = "bias";
  let timerHandle = null;
  function stopTimer() { if (timerHandle) { clearInterval(timerHandle); timerHandle = null; } }
  const leftText = (n, max) => (n < 0 ? "∞" : `${n}/${max}`);

  function applyState(pub) {
    vs.pub = pub;
    if (pub.status === "lobby") {
      if (lastStatus && lastStatus !== "lobby") { stopTimer(); showScreen("lobby"); enterRoomView(); }
      renderLobby(pub);
      lastStatus = "lobby";
      return;
    }
    if (lastStatus === "lobby" || lastStatus == null) {
      showScreen("game");
      clearEndUI();
      $("bias-input").value = ""; $("free-input").value = ""; $("guess-input").value = "";
      actTab = "bias";
      if (!timerHandle) timerHandle = setInterval(tick, 250);
    }
    const meSetter = vs.me === pub.setter;
    const me = pub.players[vs.me];
    const meOut = !!(me && me.out);
    // 残り回数
    const ct = $("counters"); ct.innerHTML = "";
    [["偏見", leftText(pub.bLeft, pub.opts.bMax)], ["自由質問", leftText(pub.fLeft, pub.opts.fMax)], ["回答", leftText(pub.gLeft, pub.opts.gMax)]]
      .forEach(([k, v]) => { const s = el("span", "counter"); s.append(k + " ", el("b", null, v)); ct.appendChild(s); });
    renderPlayers($("game-players"), pub);
    renderLog(pub);
    const lg = $("game-log"); lg.innerHTML = "";
    pub.events.forEach((e) => lg.prepend(el("div", null, e)));
    vs.deadlineLocal = pub.deadline ? Date.now() + (pub.deadline - pub.now) : null;
    $("btn-surrender").hidden = pub.status !== "playing" || meOut || meSetter;

    if (pub.status === "playing") {
      const answering = pub.phase === "answer";
      const mine = pub.turn === vs.me && !answering;
      const who = $("turn-who"); who.innerHTML = "";
      if (meSetter) {
        who.appendChild(document.createTextNode(answering ? "質問に答えてください" : `${pub.players[pub.turn].name} の番`));
        const tp = el("div", "turn-topic"); tp.append("お題：", el("b", null, myTopicIdx() >= 0 ? nameOf(C[myTopicIdx()]) : "")); who.appendChild(tp);
      } else who.textContent = answering ? `${setterName(pub)} が考え中…` : mine ? "あなたの番！" : `${pub.players[pub.turn].name} の番`;
      who.className = "turn-who" + (mine || (meSetter && answering) ? " me" : "");

      // 出題者：返事パネル
      const showAns = meSetter && answering;
      $("answer-panel").hidden = !showAns;
      if (showAns) {
        const last = pub.log[pub.log.length - 1];
        $("answer-kind").textContent = last.k === "b" ? "🗯️ 偏見が届きました（あなたのイメージで答えてOK）" : "❓ 質問が届きました";
        $("answer-q").textContent = `${pub.players[last.p].name}：${last.k === "b" ? biasText(last.q) : last.q}`;
        const box = $("answer-buttons");
        if (box.dataset.kind !== last.k) {
          box.dataset.kind = last.k; box.innerHTML = "";
          answersFor(last.k).forEach((a) => {
            const b = el("button", "btn qa-btn " + a.k, a.label); b.type = "button";
            b.addEventListener("click", () => sendAnswer(a.k));
            box.appendChild(b);
          });
        }
      }
      // 回答者：手番パネル
      const canAct = mine && !meOut && !meSetter;
      $("act-panel").hidden = !canAct;
      if (canAct) {
        const avail = { bias: pub.bLeft !== 0, free: pub.fLeft > 0, guess: pub.gLeft > 0 };
        if (!avail[actTab]) actTab = ["bias", "free", "guess"].find((k) => avail[k]) || "guess";
        $("tab-bias-left").textContent = pub.bLeft < 0 ? "" : `残り${pub.bLeft}`;
        $("tab-free-left").textContent = `残り${pub.fLeft}`;
        $("tab-guess-left").textContent = `残り${pub.gLeft}`;
        document.querySelectorAll(".act-tab").forEach((b) => { b.disabled = !avail[b.dataset.act]; });
        setActTab(actTab, lastStatus !== "playing:" + pub.turnNo + ":" + pub.phase);
        $("act-note").textContent = "偏見・自由質問・回答のどれか1つで手番が終わります。";
      }
      lastStatus = "playing:" + pub.turnNo + ":" + pub.phase;
      tick();
    } else if (pub.status === "finished") {
      $("act-panel").hidden = true; $("answer-panel").hidden = true;
      $("turn-who").textContent = "対戦終了"; $("turn-who").className = "turn-who"; $("turn-timer").textContent = "";
      if (lastStatus !== "finished") showEnd(pub, meSetter);
      lastStatus = "finished";
    }
  }
  function setActTab(k, focus) {
    actTab = k;
    document.querySelectorAll(".act-tab").forEach((b) => b.classList.toggle("active", b.dataset.act === k));
    ["bias", "free", "guess"].forEach((x) => ($("act-" + x).hidden = x !== k));
    if (focus) $(k === "bias" ? "bias-input" : k === "free" ? "free-input" : "guess-input").focus();
  }
  function renderLog(pub) {
    const ol = $("qa-log"); ol.innerHTML = "";
    let bn = 0, fn = 0;
    pub.log.forEach((x) => {
      const by = pub.players[x.p] ? pub.players[x.p].name : "?";
      const li = el("li", "qa-item " + (x.k === "b" ? "bias" : x.k === "f" ? "free" : "guess"));
      const head = el("div", "qa-q");
      const dot = el("span", "pdot"); dot.style.setProperty("--c", PLAYER_COLORS[x.p % PLAYER_COLORS.length]); head.appendChild(dot);
      head.appendChild(el("span", "qa-no", x.k === "b" ? `偏見${++bn}` : x.k === "f" ? `質問${++fn}` : "回答"));
      head.appendChild(el("span", "qa-by", by));
      head.appendChild(el("span", "qa-text", x.k === "b" ? biasText(x.q) : x.k === "f" ? x.q : nameOf(C[x.idx])));
      li.appendChild(head);
      if (x.k === "g") li.appendChild(el("div", "qa-a " + (x.ok ? "yes" : "no"), x.ok ? "正解！" : "不正解"));
      else li.appendChild(el("div", "qa-a " + (x.a || "pending"), x.a ? answerLabel(x.k, x.a) : "考え中…"));
      ol.prepend(li);
    });
    $("qa-empty").hidden = pub.log.length > 0;
  }

  // ---- 終了
  let shareText = "";
  function showEnd(pub, meSetter) {
    const w = pub.winner;
    let verdict, cls;
    if (pub.reason === "correct") { verdict = meSetter ? `${pub.players[w].name} に当てられた！` : w === vs.me ? "正解！あなたの勝ち！" : `${pub.players[w].name} が正解`; cls = meSetter || w !== vs.me ? "lose" : "win"; }
    else if (pub.reason === "no_guesses") { verdict = meSetter ? "逃げ切り！出題者の勝ち" : "回答回数を使い切って当てられず…"; cls = meSetter ? "win" : "lose"; }
    else if (pub.reason === "setter_left") { verdict = "出題者が退出したため終了"; cls = ""; }
    else { verdict = meSetter ? "全員降参！出題者の勝ち" : "全員降参…"; cls = meSetter ? "win" : "lose"; }
    const c = C[pub.answer];
    const card = $("answer-card"); card.innerHTML = "";
    card.appendChild(el("div", "result-verdict " + cls, verdict));
    if (c) {
      const ch = el("div", "result-char");
      const url = imgUrl(c);
      if (url) { const im = el("img"); im.src = url; im.alt = nameOf(c); im.width = 120; im.height = 120; im.onerror = () => { im.className = "none"; }; ch.appendChild(im); }
      const info = el("div");
      info.appendChild(el("div", "muted", "お題は…"));
      info.appendChild(el("div", "result-name", nameOf(c))); info.appendChild(el("div", "result-kana", kanaOf(c)));
      const dl = el("dl", "result-attrs"); (CFG.attrs || []).forEach((at) => { dl.appendChild(el("dt", null, at.label)); dl.appendChild(el("dd", null, displayFull(at, c))); });
      info.appendChild(dl); ch.appendChild(info); card.appendChild(ch);
    }
    card.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    shareText = [`${CFG.title}`, verdict, c ? `お題：${nameOf(c)}` : "",
      ...pub.log.map((x) => (x.k === "b" ? `🗯️ ${biasText(x.q)} → ${answerLabel("b", x.a) || "-"}` : x.k === "f" ? `❓ ${x.q} → ${answerLabel("f", x.a) || "-"}` : `🎯 ${nameOf(C[x.idx])} → ${x.ok ? "正解" : "不正解"}`))].filter(Boolean).join("\n");
    $("btn-copy-result").hidden = false;
    $("btn-again").hidden = !vs.isHost; $("btn-again-same").hidden = !vs.isHost;
  }
  function clearEndUI() {
    $("answer-card").hidden = true; $("answer-card").innerHTML = "";
    ["btn-copy-result", "btn-again", "btn-again-same"].forEach((id) => ($(id).hidden = true));
  }

  function tick() {
    if (vs.isHost) hostTick();
    const pub = vs.pub;
    const t = $("turn-timer");
    if (!pub || pub.status !== "playing" || !vs.deadlineLocal) { t.textContent = pub && pub.status === "playing" ? "制限なし" : ""; t.className = "turn-timer"; return; }
    const left = vs.deadlineLocal - Date.now();
    t.textContent = fmtClock(left);
    t.className = "turn-timer" + (left < 10000 ? " low" : "");
  }

  // ---- 操作の送信
  const send = (msg, hostFn) => { if (vs.isHost) hostFn(); else if (vs.conn) vs.conn.send(msg); };
  const myTurn = () => { const p = vs.pub; return !!p && p.status === "playing" && p.phase === "ask" && p.turn === vs.me; };
  function sendAsk(k) {
    const input = $(k === "b" ? "bias-input" : "free-input");
    const q = k === "b" ? normBias(input.value) : normFree(input.value);
    if (!q) { toast(k === "b" ? "「　」の中を入力してください" : "質問を入力してください"); return; }
    if (!myTurn()) { toast("あなたの番ではありません"); return; }
    input.value = "";
    send({ t: "ask", k, q }, () => hostAsk(vs.me, k, q));
  }
  function sendGuess(idx) {
    if (!myTurn()) { toast("あなたの番ではありません"); return; }
    send({ t: "guess", idx }, () => hostGuess(vs.me, idx));
  }
  const sendAnswer = (a) => send({ t: "answer", k: a }, () => hostAnswer(a));
  const sendSurrender = () => send({ t: "surrender" }, () => hostSurrender(vs.me));

  // ---------------------------------------------------------------- events
  const keyedLink = (extra) => `${location.origin}${location.pathname}${extra || ""}${window.GAME_KEY ? "#k=" + window.GAME_KEY : ""}`;
  $("brand-btn").addEventListener("click", () => {
    if (vs.pub && vs.pub.status === "playing") armConfirm($("btn-back-home"), "本当に退出？（もう一度押す）", goHome);
    else goHome();
  });
  $("btn-versus").addEventListener("click", () => openLobby());
  $("btn-create-room").addEventListener("click", createRoom);
  $("btn-join-room").addEventListener("click", joinRoom);
  $("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  $("btn-copy-code").addEventListener("click", () => copyText(vs.code || ""));
  $("btn-copy-link").addEventListener("click", () => copyText(keyedLink(`?room=${vs.code}`)));
  $("btn-copy-app-link").addEventListener("click", () => copyText(keyedLink()));
  $("btn-start").addEventListener("click", hostStart);
  $("btn-leave-lobby").addEventListener("click", () => { leaveVersus(); openLobby(); });
  // 2回押しで確定（confirm ダイアログは環境によって出ないため使わない）
  function armConfirm(btn, label, fn) {
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.orig; clearTimeout(btn._t); fn(); return; }
    btn.dataset.armed = "1"; btn.dataset.orig = btn.textContent; btn.textContent = label;
    btn._t = setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn.dataset.orig; }, 3000);
  }
  $("btn-back-home").addEventListener("click", () => {
    if (vs.pub && vs.pub.status === "playing") armConfirm($("btn-back-home"), "本当に退出？（もう一度押す）", goHome);
    else goHome();
  });
  $("btn-surrender").addEventListener("click", () => armConfirm($("btn-surrender"), "本当に降参？（もう一度押す）", sendSurrender));
  $("btn-copy-result").addEventListener("click", () => shareText && copyText(shareText));
  $("btn-again").addEventListener("click", () => hostBackToLobby(true));
  $("btn-again-same").addEventListener("click", () => hostBackToLobby(false));
  document.querySelectorAll(".act-tab").forEach((b) => b.addEventListener("click", () => setActTab(b.dataset.act, true)));
  $("bias-send").addEventListener("click", () => sendAsk("b"));
  $("bias-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendAsk("b"); } });
  $("free-send").addEventListener("click", () => sendAsk("f"));
  $("free-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendAsk("f"); } });
  const guessedSet = () => new Set(vs.pub ? vs.pub.log.filter((x) => x.k === "g").map((x) => x.idx) : []);
  const guessBox = attachSuggest($("guess-input"), $("guess-suggest"), sendGuess, guessedSet);
  $("guess-send").addEventListener("click", () => guessBox.submit());
  attachSuggest($("topic-input"), $("topic-suggest"), (i) => pickTopic(i));
  $("btn-topic-change").addEventListener("click", () => pickTopic(-1));
  $("btn-topic-random").addEventListener("click", randomTopic);
  $("btn-topic-random-2").addEventListener("click", randomTopic);
  const readOpts = () => ({ bMax: $("room-bias").value, fMax: $("room-free").value, gMax: $("room-guess").value, turnSec: $("room-turn-seconds").value });
  ["room-bias", "room-free", "room-guess", "room-turn-seconds"].forEach((id) => $(id).addEventListener("change", () => { if (vs.isHost) hostSetOptions(readOpts()); }));
  $("setter-select").addEventListener("change", () => { if (vs.isHost) hostSetSetter(+$("setter-select").value); });
  window.addEventListener("beforeunload", () => { try { vs.peer && vs.peer.destroy(); } catch {} });

  // ------------------------------------------------------------------ init
  applyConfigText();
  const roomParam = new URLSearchParams(location.search).get("room");
  if (roomParam && /^\d{6}$/.test(roomParam)) openLobby(roomParam);
};
