/* 偏見マッチング — イナゲッサーの「質問モード」をベースにした対戦専用ゲーム。
   - 出題者がお題を自由に入力する（キャラ・有名人・身近な人など何でも）
   - 回答者は順番に「偏見（「　」そうですか？）」「自由質問（回数制限あり）」「回答」のどれか1つを行う
   - 回答はお題と同じ文字なら自動で正解、それ以外は出題者が「正解／惜しい／不正解」で判定する
   - 通信は PeerJS (WebRTC) でホスト権威型。ホストが進行を管理し、ゲストは操作を送るだけ */
window.GAME_START = () => {
  "use strict";

  const CFG = window.GAME_CONFIG;
  const $ = (id) => document.getElementById(id);
  const PEER_PREFIX = CFG.id + "-";
  const PLAYER_COLORS = ["#e0a800", "#1e88e5", "#e53976", "#2e9e4f"];
  const MAX_PLAYERS = CFG.maxPlayers || 4;
  // フレンド機能（social.js）。init で起動するまでの仮の中身
  let SOCIAL = { myCode: () => "", isFriend: () => false, isBlocked: () => false, hasPendingRequestTo: () => false, request() {}, block() {}, refresh() {} };
  const validCode = (c) => (/^[A-Z2-9]{10}$/.test(String(c || "")) ? String(c) : "");

  // 回答の自動一致判定用（カタカナ→ひらがな、全角英数→半角、空白・記号を除去）
  const textNorm = (s) =>
    String(s || "")
      .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[\s・･ｰー\-‐.,、。！!？?「」『』（）()]/g, "")
      .toLowerCase();

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
    $("rule-hint-example").textContent = CFG.hintExample || "";
    $("bias-input").placeholder = "例：" + (CFG.biasExample || "");
    $("free-input").placeholder = "例：" + (CFG.freeExample || "");
    $("guess-input").placeholder = "お題は誰（何）？";
    $("topic-input").placeholder = "お題（例：" + (CFG.topicExample || "") + "）";
    $("hint-input").placeholder = "ジャンル・任意（例：" + (CFG.hintExample || "") + "）※回答者に見えます";
    $("foot").textContent = "";
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
  ].map((a) => ({ ...a, cls: a.k }));
  // 自由質問への答え
  const FREE_ANSWERS = [
    { k: "yes", label: "はい" }, { k: "pyes", label: "部分的にはい" }, { k: "unknown", label: "わからない" },
    { k: "pno", label: "部分的にいいえ" }, { k: "no", label: "いいえ" },
  ].map((a) => ({ ...a, cls: a.k }));
  // 回答（お題そのものを答えた）への判定
  const JUDGES = [
    { k: "ok", cls: "yes", label: "正解！" }, { k: "close", cls: "pyes", label: "惜しい！" }, { k: "ng", cls: "no", label: "不正解" },
  ];
  const answersFor = (kind) => (kind === "b" ? BIAS_ANSWERS : FREE_ANSWERS);
  const answerLabel = (kind, k) => (answersFor(kind).find((a) => a.k === k) || {}).label || "";
  const biasText = (q) => `「${q}」そうですか？`;
  // 「〜そうですか？」まで書いてしまった場合は空欄部分だけにする
  const normBias = (q) => String(q || "").replace(/\s+/g, " ").trim()
    .replace(/^「|」$/g, "").replace(/[。．.！!？?\s]+$/, "").replace(/」?そう(です|だ)?か?$/, "").replace(/」$/, "").trim().slice(0, 60);
  const normFree = (q) => String(q || "").replace(/\s+/g, " ").trim().slice(0, 80);

  // ---------------------------------------------------------------- versus
  const vs = { peer: null, isHost: false, code: null, conn: null, host: null, pub: null, me: -1, deadlineLocal: null, name: "", myTopic: null };
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
    $("lobby-choice").hidden = false; $("lobby-room").hidden = true; $("lobby-match").hidden = false;
    matchReset();
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
  // ov: ランダム対戦用のフック { onOpen(H), onReady(code), onFail(e) }
  function tryHostCode(attempt, name, ov) {
    ov = ov || {};
    const code = String(100000 + randInt(900000));
    const peer = makePeer(PEER_PREFIX + code);
    let settled = false;
    peer.on("open", () => {
      settled = true;
      vs.peer = peer; vs.isHost = true; vs.code = code; vs.me = 0;
      vs.host = {
        players: [{ name, conn: null, connected: true, out: false, code: SOCIAL.myCode() }],
        chat: [],           // ルームチャット [{p, name, code, text, ts}]
        status: "lobby", setter: 0, topic: null,   // topic: { name, hint }（出題者だけが知っている。hint は回答者にも見える）
        opts: savedOpts(),
        log: [],            // [{k:"b"|"f", p, q, a} | {k:"g", p, q, r}] を時系列で（r: "ok"|"close"|"ng"|null=判定待ち）
        bLeft: 0, fLeft: 0, gLeft: 0, phase: "ask",   // phase: ask=回答者の手番 / answer=出題者が質問に返事 / judge=出題者が回答を判定
        turn: 0, turnNo: 1, deadline: null, winner: null, reason: null, events: [],
      };
      peer.on("connection", onHostConnection);
      peer.on("disconnected", () => { lobbyStatus("シグナリングサーバーから切断されました。再接続中…"); try { peer.reconnect(); } catch {} });
      peer.on("error", (e) => { console.warn(e); if (e.type !== "peer-unavailable") toast("通信エラー: " + e.type); });
      if (ov.onOpen) ov.onOpen(vs.host);
      $("btn-create-room").disabled = false;
      enterRoomView();
      hostBroadcast();
      if (ov.onReady) ov.onReady(code);
    });
    peer.on("error", (e) => {
      if (settled) return;
      settled = true;
      try { peer.destroy(); } catch {}
      if (e.type === "unavailable-id" && attempt < 5) { tryHostCode(attempt + 1, name, ov); return; }
      if (ov.onFail) { ov.onFail(e); return; }
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
      const code = validCode(msg.code);
      if (code && SOCIAL.isBlocked(code)) { hostSend(conn, { t: "error", msg: "このルームには参加できません" }); setTimeout(() => { try { conn.close(); } catch {} }, 300); return; }
      H.players.push({ name, conn, connected: true, out: false, code, chatTs: [] });
      hostSend(conn, { t: "welcome", you: H.players.length - 1 });
      hostEvent(`${name} が参加しました`);
      hostBroadcast();
      return;
    }
    if (pIdx < 0) return;
    if (msg.t === "ask") hostAsk(pIdx, msg.k, msg.q);
    else if (msg.t === "guess") hostGuess(pIdx, msg.q);
    else if (msg.t === "topic") { if (pIdx === H.setter) hostSetTopic(msg.topic); }
    else if (msg.t === "answer") { if (pIdx === H.setter) hostAnswer(msg.k); }
    else if (msg.t === "judge") { if (pIdx === H.setter) hostJudge(msg.r); }
    else if (msg.t === "surrender") hostSurrender(pIdx);
    else if (msg.t === "chat") hostChat(pIdx, msg.text);
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
      if (si < 0) { H.setter = 0; H.topic = null; } else H.setter = si;
      H.players.forEach((x, i) => { if (x.conn) hostSend(x.conn, { t: "welcome", you: i }); });
    } else if (H.status === "playing") {
      const i = H.players.indexOf(p);
      if (i === H.setter) { finish(null, "setter_left"); hostBroadcast(); return; }
      checkRemaining();
      if (H.status === "playing" && H.turn === i && H.phase === "ask") advanceTurn();
    }
    hostBroadcast();
  }
  function hostChat(pIdx, text) {
    const H = vs.host; const p = H && H.players[pIdx]; if (!p) return;
    text = String(text || "").replace(/\s+/g, " ").trim().slice(0, 100);
    if (!text) return;
    const now = Date.now(); p.chatTs = (p.chatTs || []).filter((t) => now - t < 5000);
    if (p.chatTs.length >= 5) { errTo(pIdx, "送信が早すぎます。少し待ってください"); return; }
    p.chatTs.push(now);
    H.chat.push({ p: pIdx, name: p.name, code: p.code || "", text, ts: now });
    while (H.chat.length > 40) H.chat.shift();
    hostBroadcast();
  }
  // ブロックした相手をルームから出す（ホストのみ）
  function hostKick(i) {
    const H = vs.host; const p = H && H.players[i]; if (!p || !p.conn || i === 0) return;
    hostSend(p.conn, { t: "error", msg: "ルームから退出しました" });
    setTimeout(() => { try { p.conn.close(); } catch {} hostOnLeave(p.conn); }, 300);
  }
  function hostEvent(text) { const H = vs.host; H.events.push(text); if (H.events.length > 20) H.events.shift(); }
  const setterName = (pub) => (pub.players[pub.setter] ? pub.players[pub.setter].name : "出題者");
  const eligible = (H, i) => { const p = H.players[i]; return !!p && p.connected && !p.out && i !== H.setter; };

  function hostStart() {
    const H = vs.host;
    if (H.players.filter((p) => p.connected).length < 2) { toast("回答者が1人以上必要です"); return; }
    if (!H.topic) { toast("お題が決まっていません"); return; }
    const setterP = H.players[H.setter];
    H.players = H.players.filter((p) => p.connected);
    H.setter = Math.max(0, H.players.indexOf(setterP));
    H.players.forEach((p, i) => { p.out = false; if (p.conn) hostSend(p.conn, { t: "welcome", you: i }); });
    H.log = []; H.winner = null; H.reason = null; H.events = [];
    H.bLeft = H.opts.bMax || Infinity; H.fLeft = H.opts.fMax; H.gLeft = H.opts.gMax; H.phase = "ask";
    H.status = "playing";
    H.turn = H.setter; H.turnNo = 1;
    advanceTurn(); H.turnNo = 1;
    hostEvent(`対戦開始！ ${H.players[H.setter].name} のお題を偏見で当てよう${H.topic.hint ? `（ジャンル：${H.topic.hint}）` : ""}`);
    hostBroadcast();
  }
  function hostBackToLobby(rotateSetter) {
    const H = vs.host; if (!H) return;
    const cur = H.players[H.setter];
    H.status = "lobby"; H.topic = null; H.log = []; H.winner = null; H.reason = null; H.events = []; H.phase = "ask"; H.deadline = null;
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
    if (H.setter !== i) { H.setter = i; H.topic = null; hostEvent(`出題者が ${H.players[i].name} に交代`); }
    hostBroadcast();
  }
  const cleanTopic = (t) => {
    if (!t || typeof t !== "object") return null;
    const name = String(t.name || "").replace(/s+/g, " ").trim().slice(0, 40);
    const hint = String(t.hint || "").replace(/s+/g, " ").trim().slice(0, 30);
    return name ? { name, hint } : null;
  };
  function hostSetTopic(t) {
    const H = vs.host; if (!H || H.status !== "lobby") return;
    H.topic = cleanTopic(t);
    hostBroadcast();
  }
  // 出題者（ホストでもゲストでも）がお題を決める／取り消す（null）
  function pickTopic(t) {
    t = cleanTopic(t);
    if (vs.isHost) { hostSetTopic(t); return; }
    vs.myTopic = t;
    if (vs.conn) vs.conn.send({ t: "topic", topic: t });
    renderTopicUI();
  }
  const myTopic = () => (vs.isHost ? (vs.host ? vs.host.topic : null) : vs.myTopic);
  function renderTopicUI() {
    const pub = vs.pub;
    const on = !!pub && vs.me === pub.setter && pub.status === "lobby";
    $("topic-field").hidden = !on;
    if (!on) return;
    const t = myTopic();
    $("topic-picker").hidden = !!t; $("topic-chosen").hidden = !t;
    if (t) { $("topic-name").textContent = t.name; $("topic-hint").textContent = t.hint ? `ジャンル：${t.hint}` : "ジャンルなし"; }
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
    if (H.bLeft <= 0 && H.fLeft <= 0) hostEvent(`質問はもう使い切りました。あとは回答だけです`);
    H.turnNo++;
    advanceTurn();
    hostBroadcast();
  }
  // 回答：お題と同じ文字なら自動で正解。それ以外は出題者の判定待ち
  function hostGuess(pIdx, q) {
    const H = vs.host;
    if (H.status !== "playing" || H.phase !== "ask" || H.turn !== pIdx || !eligible(H, pIdx)) return;
    q = normFree(q).slice(0, 40);
    if (!q) return;
    if (H.gLeft <= 0) { errTo(pIdx, "回答できる回数がもうありません"); return; }
    if (H.log.some((g) => g.k === "g" && textNorm(g.q) === textNorm(q))) { errTo(pIdx, "すでに同じ回答が出ています"); return; }
    H.log.push({ k: "g", p: pIdx, q, r: null });
    H.gLeft--;
    if (textNorm(q) === textNorm(H.topic.name)) { hostJudge("ok"); return; }
    H.phase = "judge";
    H.deadline = null;   // 判定には制限時間を付けない（時間切れで勝敗が決まらないように）
    hostBroadcast();
  }
  function hostJudge(r) {
    const H = vs.host;
    if (!H || H.status !== "playing" || !["ok", "close", "ng"].includes(r)) return;
    const last = H.log[H.log.length - 1]; if (!last || last.k !== "g" || last.r) return;
    last.r = r;
    H.phase = "ask";
    if (r === "ok") finish(last.p, "correct");
    else {
      hostEvent(`${H.players[last.p].name} の回答「${last.q}」は${r === "close" ? "惜しい！" : "不正解"}（回答 残り${H.gLeft}回）`);
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
      status: H.status, topicChosen: !!H.topic, setter: H.setter, hint: H.status !== "lobby" && H.topic ? H.topic.hint : "",
      players: H.players.map((p) => ({ name: p.name, connected: p.connected, out: p.out, code: p.code || "" })),
      chat: H.chat,
      opts: H.opts, log: H.log, bLeft: fin(H.bLeft), fLeft: H.fLeft, gLeft: H.gLeft, phase: H.phase,
      turn: H.turn, turnNo: H.turnNo, now: Date.now(), deadline: H.deadline,
      winner: H.winner, reason: H.reason, events: H.events,
      answer: H.status === "finished" && H.topic ? H.topic.name : "",
    };
  }
  function hostBroadcast() {
    const H = vs.host; if (!H) return;
    const pub = publicState();
    H.players.forEach((p) => { if (p.conn && p.connected) hostSend(p.conn, { t: "state", s: pub }); });
    applyState(pub);
  }

  // ---- ランダム対戦（サーバーなしの待ち合わせ）
  // 決まった ID（<ゲームID>-match）に接続を試み、誰かが待っていればその人がホストになって通常ルームへ移動。
  // 誰もいなければ自分がその ID で登録して待つ。マッチ後は待ち合わせ ID を解放して次の人が使えるようにする。
  const MATCH_ID = PEER_PREFIX + "match";
  const match = { peer: null, active: false, timer: null, started: 0, fails: 0 };
  const matchStatus = (msg) => { $("match-status").textContent = msg || ""; };
  function matchReset() {
    match.active = false; clearInterval(match.timer); match.timer = null;
    try { match.peer && match.peer.destroy(); } catch {}
    match.peer = null;
    $("btn-match").hidden = false; $("btn-match-cancel").hidden = true;
    matchStatus("");
  }
  function matchTick() {
    if (!match.active) return;
    const sec = Math.floor((Date.now() - match.started) / 1000);
    matchStatus(`相手を探しています… ${Math.floor(sec / 60)}:${pad2(sec % 60)}（画面を消さずにお待ちください。次に押した人と自動でマッチします）`);
  }
  function startMatch() {
    if (!peerAvailable()) { toast("通信ライブラリが読み込めていません"); return; }
    myNick();
    match.active = true; match.started = Date.now(); match.fails = 0;
    $("btn-match").hidden = true; $("btn-match-cancel").hidden = false;
    lobbyStatus("");
    matchStatus("相手を探しています…");
    clearInterval(match.timer); match.timer = setInterval(matchTick, 1000);
    matchSeek(0);
  }
  // 1) 待っている人がいるか、待ち合わせ ID に接続してみる
  function matchSeek(attempt) {
    if (!match.active) return;
    const peer = makePeer(undefined); match.peer = peer;
    let done = false;
    peer.on("open", () => {
      const conn = peer.connect(MATCH_ID, { reliable: true });
      // 相手は登録されているのに接続が開かない（ネットワーク制限など）→ 何度か試してから諦める
      const t = setTimeout(() => {
        if (done) return; done = true; try { peer.destroy(); } catch {}
        if (!match.active) return;
        match.fails++;
        if (match.fails >= 3) { matchReset(); lobbyStatus("相手はいるようですが、通信経路を確立できませんでした。Wi-Fi／モバイル回線を切り替えるか、時間をおいて再度お試しください。"); return; }
        matchStatus(`相手が見つかりましたが接続できません。再試行中…（${match.fails}/3）`);
        setTimeout(() => matchSeek(attempt + 1), 1500);
      }, 15000);
      conn.on("open", () => {
        clearTimeout(t); if (done) return;
        matchStatus("相手が見つかりました。ルームに移動中…");
        conn.send({ t: "hello", name: vs.name });
        conn.on("data", (msg) => {
          if (!msg || msg.t !== "room" || done) return;
          done = true;
          try { conn.close(); } catch {}
          setTimeout(() => { try { peer.destroy(); } catch {} }, 500);
          match.peer = null; match.active = false; clearInterval(match.timer);
          $("join-code").value = String(msg.code || "");
          joinRoom();
          matchReset();
        });
        conn.on("close", () => { if (!done) { done = true; try { peer.destroy(); } catch {} if (match.active) matchSeek(attempt + 1); } });
      });
    });
    peer.on("error", (e) => {
      if (done) return;
      done = true; try { peer.destroy(); } catch {}
      if (e.type === "peer-unavailable") matchWait(attempt);   // 誰も待っていない → 自分が待つ
      else if (match.active) { matchReset(); lobbyStatus("接続エラー: " + e.type); }
    });
  }
  // 2) 自分が待ち合わせ ID を取って待つ。取れなければ（同時に誰かが取った）もう一度探す
  function matchWait(attempt) {
    if (!match.active) return;
    const peer = makePeer(MATCH_ID); match.peer = peer;
    let settled = false;
    peer.on("open", () => {
      settled = true;
      matchTick();
      // スマホの画面オフ等でシグナリングサーバーとの接続が切れると ID が消えるので、復帰したら取り直す
      peer.on("disconnected", () => {
        if (!match.active) return;
        matchStatus("接続が切れました。再登録しています…");
        try { peer.reconnect(); } catch { try { peer.destroy(); } catch {} setTimeout(() => matchSeek(0), 1000); }
      });
      peer.on("close", () => { if (match.active && match.peer === peer) { match.peer = null; setTimeout(() => matchSeek(0), 1000); } });
      document.addEventListener("visibilitychange", function onVis() {
        if (!match.active || match.peer !== peer) { document.removeEventListener("visibilitychange", onVis); return; }
        if (document.visibilityState === "visible" && peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch {} }
      });
      peer.on("connection", (conn) => {
        conn.on("open", () => {
          conn.on("data", (msg) => {
            if (!msg || msg.t !== "hello" || !match.active || vs.host) return;
            matchStatus("相手が見つかりました。ルームを作成中…");
            const name = String(msg.name || "プレイヤー").slice(0, 12);
            tryHostCode(0, vs.name, {
              onOpen: (H) => { H.setter = randInt(2); },   // 最初の出題者はランダム（1 はこれから入る相手）
              onReady: (code) => {
                try { conn.send({ t: "room", code }); } catch {}
                hostEvent(`ランダム対戦：${name} とマッチしました`);
                // 待ち合わせ ID を解放（相手がコードを受け取れるように少し待ってから）
                setTimeout(() => { try { conn.close(); } catch {} try { peer.destroy(); } catch {} }, 1500);
                match.peer = null; match.active = false; clearInterval(match.timer);
                $("btn-match").hidden = false; $("btn-match-cancel").hidden = true; matchStatus("");
              },
              onFail: () => { matchReset(); lobbyStatus("ルームを作成できませんでした。もう一度お試しください。"); },
            });
          });
        });
      });
    });
    peer.on("error", (e) => {
      if (settled) { console.warn(e); return; }
      settled = true;
      try { peer.destroy(); } catch {}
      if (!match.active) return;
      if (e.type === "unavailable-id" && attempt < 6) setTimeout(() => matchSeek(attempt + 1), 800 + randInt(700));   // 取り合いに負けた → 相手に接続し直す
      else { matchReset(); lobbyStatus("相手を探せませんでした（" + e.type + "）。時間をおいて再度お試しください。"); }
    });
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
        conn.send({ t: "join", name, code: SOCIAL.myCode() });
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
    else if (msg.t === "error") { vs.lastErr = msg.msg || ""; vs.lastErrAt = Date.now(); toast(msg.msg || "エラー"); lobbyStatus(msg.msg || ""); }
  }
  function onHostLost() {
    if (!vs.peer) return;
    // 直前にホストから理由（参加できない等）が届いていれば、そちらを出す
    const why = Date.now() - (vs.lastErrAt || 0) < 3000 ? vs.lastErr : ""; vs.lastErr = "";
    toast(why || "ホストとの接続が切れました");
    if (vs.pub && vs.pub.status === "playing") {
      stopTimer(); $("act-panel").hidden = true; $("answer-panel").hidden = true;
      $("turn-who").textContent = "接続終了"; $("turn-timer").textContent = "";
      vs.pub = null; try { vs.peer.destroy(); } catch {} vs.peer = null; vs.conn = null;
    } else { leaveVersus(); openLobby(); lobbyStatus(why || "ホストとの接続が切れました。"); }
  }

  // ---- shared
  function enterRoomView() {
    $("lobby-choice").hidden = true; $("lobby-room").hidden = false; $("lobby-match").hidden = true;
    $("room-code-display").textContent = vs.code;
    $("btn-start").hidden = !vs.isHost;
    lobbyStatus("");
    $("topbar-status").textContent = "ルーム " + vs.code;
  }
  function leaveVersus() {
    stopTimer();
    if (match.active) matchReset();
    try { vs.conn && vs.conn.close(); } catch {}
    try { vs.peer && vs.peer.destroy(); } catch {}
    vs.peer = null; vs.conn = null; vs.host = null; vs.pub = null; vs.isHost = false; vs.code = null; vs.me = -1; vs.myTopic = null;
    lastStatus = null;
    $("topbar-status").textContent = "";
    $("room-chat").hidden = true; $("chat-list").innerHTML = ""; chatKey = "";
    SOCIAL.refresh();
  }
  function renderPlayers(ul, pub, withSocial) {
    ul.innerHTML = "";
    pub.players.forEach((p, i) => {
      const li = el("li", (i === vs.me ? "me " : "") + (pub.status === "playing" && pub.turn === i && pub.phase === "ask" ? "turn " : "") + (!p.connected || p.out ? "offline" : ""));
      const dot = el("span", "pdot"); dot.style.setProperty("--c", PLAYER_COLORS[i % PLAYER_COLORS.length]); li.appendChild(dot);
      li.appendChild(el("span", null, p.name + (i === 0 ? "（ホスト）" : "")));
      const setter = i === pub.setter;
      const tag = !p.connected ? "切断" : p.out ? "降参" : setter ? (i === vs.me ? "出題者（あなた）" : "出題者") : i === vs.me ? "あなた" : "";
      if (tag) li.appendChild(el("span", "ptag", tag));
      if (withSocial) { const a = socialActions(p); if (a) li.appendChild(a); }
      ul.appendChild(li);
    });
  }
  // 他のプレイヤーへのフレンド申請・ブロックのボタン
  function socialActions(p) {
    if (!p.code || p.code === SOCIAL.myCode() || !p.connected) return null;
    const box = el("span", "p-act");
    if (SOCIAL.isFriend(p.code)) box.appendChild(el("span", "p-friend", "フレンド"));
    else if (SOCIAL.hasPendingRequestTo(p.code)) box.appendChild(el("span", "p-friend", "申請中"));
    else { const b = el("button", "btn small", "＋フレンド"); b.type = "button"; b.addEventListener("click", () => SOCIAL.request(p.code, p.name)); box.appendChild(b); }
    const bl = el("button", "btn small danger", "ブロック"); bl.type = "button";
    bl.addEventListener("click", () => armConfirm(bl, "本当に？", () => SOCIAL.block(p.code, p.name)));
    box.appendChild(bl);
    return box;
  }
  const optsSummary = (o) => [
    o.bMax ? `偏見 ${o.bMax}回` : "偏見 無制限", `自由質問 ${o.fMax}回`, `回答 ${o.gMax}回`, o.turnSec ? `1手 ${o.turnSec}秒` : "制限時間なし",
  ].join("・");
  function renderLobby(pub) {
    renderPlayers($("lobby-players"), pub, true);
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
    if (!pub.topicChosen) vs.myTopic = null;
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

  // ルームチャット：ロビーとゲーム画面の置き場所へ移動して表示。ブロック中の相手の発言は出さない
  let chatKey = "";
  function renderChat(pub) {
    const box = $("room-chat");
    const slot = $(pub.status === "lobby" ? "lobby-chat-slot" : "game-chat-slot");
    if (box.parentNode !== slot) slot.appendChild(box);
    box.hidden = false;
    const chat = pub.chat || [];
    const key = chat.length + ":" + (chat.length ? chat[chat.length - 1].ts : 0) + ":" + chat.map((m) => (SOCIAL.isBlocked(m.code) ? "b" : "")).join("");
    if (key === chatKey) return;
    chatKey = key;
    const ol = $("chat-list"); const atBottom = ol.scrollTop + ol.clientHeight >= ol.scrollHeight - 20;
    ol.innerHTML = "";
    chat.filter((m) => !SOCIAL.isBlocked(m.code)).forEach((m) => {
      const li = el("li");
      const nm = el("span", "cn", m.name); nm.style.setProperty("--c", PLAYER_COLORS[m.p % PLAYER_COLORS.length]);
      li.append(nm, document.createTextNode(m.text));
      ol.appendChild(li);
    });
    $("chat-empty").hidden = ol.children.length > 0;
    if (atBottom || !ol.dataset.init) { ol.scrollTop = ol.scrollHeight; ol.dataset.init = "1"; }
  }
  function sendChat() {
    const input = $("chat-input");
    const text = input.value.replace(/\s+/g, " ").trim().slice(0, 100);
    if (!text || !vs.pub) return;
    input.value = "";
    send({ t: "chat", text }, () => hostChat(vs.me, text));
  }

  function applyState(pub) {
    vs.pub = pub;
    // ブロック中の相手がホストのルームには居続けない
    if (!vs.isHost && pub.players[0] && SOCIAL.isBlocked(pub.players[0].code)) { leaveVersus(); openLobby(); lobbyStatus("ブロック中の相手のルームだったため退出しました。"); return; }
    renderChat(pub);
    if (pub.status === "lobby") {
      if (lastStatus && lastStatus !== "lobby") { stopTimer(); showScreen("lobby"); enterRoomView(); }
      renderLobby(pub);
      SOCIAL.refresh();   // 招待ボタンの出し分け
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
      const waiting = pub.phase !== "ask";   // 出題者の返事・判定待ち
      const mine = pub.turn === vs.me && !waiting;
      const who = $("turn-who"); who.innerHTML = "";
      if (meSetter) {
        who.appendChild(document.createTextNode(pub.phase === "answer" ? "質問に答えてください" : pub.phase === "judge" ? "回答を判定してください" : `${pub.players[pub.turn].name} の番`));
        const t = myTopic();
        const tp = el("div", "turn-topic"); tp.append("お題：", el("b", null, t ? t.name : "")); who.appendChild(tp);
      } else who.textContent = waiting ? `${setterName(pub)} が考え中…` : mine ? "あなたの番！" : `${pub.players[pub.turn].name} の番`;
      who.className = "turn-who" + (mine || (meSetter && waiting) ? " me" : "");

      // 出題者：返事／判定パネル
      const showAns = meSetter && waiting;
      $("answer-panel").hidden = !showAns;
      if (showAns) {
        const last = pub.log[pub.log.length - 1];
        const kind = last.k === "g" ? "g" : last.k;
        $("answer-kind").textContent = kind === "b" ? "🗯️ 偏見が届きました（あなたのイメージで答えてOK）" : kind === "f" ? "❓ 質問が届きました" : "🎯 回答が届きました。お題と合っていますか？";
        $("answer-q").textContent = `${pub.players[last.p].name}：${kind === "b" ? biasText(last.q) : last.q}`;
        const box = $("answer-buttons");
        if (box.dataset.kind !== kind) {
          box.dataset.kind = kind; box.innerHTML = "";
          box.classList.toggle("judge", kind === "g");
          (kind === "g" ? JUDGES : answersFor(kind)).forEach((a) => {
            const b = el("button", "btn qa-btn " + a.cls, a.label); b.type = "button";
            b.addEventListener("click", () => (kind === "g" ? sendJudge(a.k) : sendAnswer(a.k)));
            box.appendChild(b);
          });
        }
      }
      // 回答者：手番パネル
      const g = $("genre"); g.hidden = !pub.hint; if (pub.hint) g.textContent = "ジャンル：" + pub.hint;
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
      head.appendChild(el("span", "qa-text", x.k === "b" ? biasText(x.q) : x.q));
      li.appendChild(head);
      if (x.k === "g") { const j = JUDGES.find((y) => y.k === x.r); li.appendChild(el("div", "qa-a " + (j ? j.cls : "pending"), j ? j.label : "判定中…")); }
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
    const card = $("answer-card"); card.innerHTML = "";
    card.appendChild(el("div", "result-verdict " + cls, verdict));
    if (pub.answer) {
      const info = el("div", "result-topic");
      info.appendChild(el("div", "muted", "お題は…"));
      info.appendChild(el("div", "result-name", pub.answer));
      if (pub.hint) info.appendChild(el("div", "result-kana", "ジャンル：" + pub.hint));
      card.appendChild(info);
    }
    const others = pub.players.filter((p, i) => i !== vs.me && p.code && p.code !== SOCIAL.myCode());
    if (others.length) {
      const box = el("div", "end-social");
      box.appendChild(el("div", "muted", "一緒に遊んだ人"));
      others.forEach((p) => { const r = el("div", "row"); r.appendChild(el("span", null, p.name)); const a = socialActions(p); if (a) r.appendChild(a); box.appendChild(r); });
      card.appendChild(box);
    }
    card.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    shareText = [`${CFG.title}`, verdict, pub.answer ? `お題：${pub.answer}` : "",
      ...pub.log.map((x) => (x.k === "b" ? `🗯️ ${biasText(x.q)} → ${answerLabel("b", x.a) || "-"}` : x.k === "f" ? `❓ ${x.q} → ${answerLabel("f", x.a) || "-"}` : `🎯 ${x.q} → ${(JUDGES.find((y) => y.k === x.r) || {}).label || "-"}`))].filter(Boolean).join("\n");
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
  function sendGuess() {
    const q = normFree($("guess-input").value).slice(0, 40);
    if (!q) { toast("回答を入力してください"); return; }
    if (!myTurn()) { toast("あなたの番ではありません"); return; }
    $("guess-input").value = "";
    send({ t: "guess", q }, () => hostGuess(vs.me, q));
  }
  const sendJudge = (r) => send({ t: "judge", r }, () => hostJudge(r));
  const sendAnswer = (a) => send({ t: "answer", k: a }, () => hostAnswer(a));
  const sendSurrender = () => send({ t: "surrender" }, () => hostSurrender(vs.me));

  // ---------------------------------------------------------------- events
  // 共有リンクは常に公開URL（config.siteUrl）。古いURLやキャッシュから開いていても最新のURLを教えられるように。ローカル確認中だけは今のURL
  const appLink = (extra) => `${CFG.siteUrl && !/^(localhost|127\.)/.test(location.hostname) ? CFG.siteUrl : location.origin + location.pathname}${extra || ""}`;
  $("brand-btn").addEventListener("click", () => {
    if (vs.pub && vs.pub.status === "playing") armConfirm($("btn-back-home"), "本当に退出？（もう一度押す）", goHome);
    else goHome();
  });
  $("btn-versus").addEventListener("click", () => openLobby());
  $("btn-create-room").addEventListener("click", createRoom);
  $("btn-join-room").addEventListener("click", joinRoom);
  $("btn-match").addEventListener("click", startMatch);
  $("btn-match-cancel").addEventListener("click", () => { matchReset(); lobbyStatus("ランダム対戦をキャンセルしました。"); });
  $("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  $("btn-copy-code").addEventListener("click", () => copyText(vs.code || ""));
  $("btn-copy-link").addEventListener("click", () => copyText(appLink(`?room=${vs.code}`)));
  $("btn-copy-app-link").addEventListener("click", () => copyText(appLink()));
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
  $("guess-send").addEventListener("click", sendGuess);
  $("guess-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendGuess(); } });
  const setTopicFromInputs = () => {
    const name = $("topic-input").value.trim();
    if (!name) { toast("お題を入力してください"); $("topic-input").focus(); return; }
    pickTopic({ name, hint: $("hint-input").value });
  };
  $("btn-topic-set").addEventListener("click", setTopicFromInputs);
  ["topic-input", "hint-input"].forEach((id) => $(id).addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); setTopicFromInputs(); } }));
  $("btn-topic-change").addEventListener("click", () => {
    const t = myTopic(); if (t) { $("topic-input").value = t.name; $("hint-input").value = t.hint; }
    pickTopic(null);
  });
  const readOpts = () => ({ bMax: $("room-bias").value, fMax: $("room-free").value, gMax: $("room-guess").value, turnSec: $("room-turn-seconds").value });
  ["room-bias", "room-free", "room-guess", "room-turn-seconds"].forEach((id) => $(id).addEventListener("change", () => { if (vs.isHost) hostSetOptions(readOpts()); }));
  $("chat-send").addEventListener("click", sendChat);
  $("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendChat(); } });
  $("setter-select").addEventListener("change", () => { if (vs.isHost) hostSetSetter(+$("setter-select").value); });
  window.addEventListener("beforeunload", () => { try { vs.peer && vs.peer.destroy(); } catch {} });

  // ------------------------------------------------------------------ init
  applyConfigText();
  SOCIAL = window.SOCIAL_START({
    el, toast, copyText,
    getName: () => vs.name || "プレイヤー",
    setName: (n) => { n = String(n || "").trim().slice(0, 12) || "プレイヤー"; vs.name = n; try { localStorage.setItem(NICK_KEY, n); } catch {} $("nickname").value = n; return n; },
    // 招待できるのはロビーにいるときだけ（対戦中は参加できないため）
    roomCode: () => (vs.code && vs.pub && vs.pub.status === "lobby" ? vs.code : ""),
    joinByCode: (code) => { leaveVersus(); openLobby(code); joinRoom(); },
    onBlock: (code) => {
      if (vs.isHost && vs.host) { const i = vs.host.players.findIndex((p, k) => k > 0 && p.code === code && p.connected); if (i > 0) hostKick(i); }
      else if (vs.pub && vs.pub.players[0] && vs.pub.players[0].code === code) { leaveVersus(); openLobby(); lobbyStatus("ブロックした相手のルームから退出しました。"); return; }
      if (vs.pub) { chatKey = ""; renderChat(vs.pub); }
    },
    // フレンド状態が変わったら参加者一覧のボタンを更新
    onChange: () => { if (vs.pub && vs.pub.status === "lobby") renderPlayers($("lobby-players"), vs.pub, true); },
  });
  const roomParam = new URLSearchParams(location.search).get("room");
  if (roomParam && /^\d{6}$/.test(roomParam)) openLobby(roomParam);
};
