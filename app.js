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
  const MAX_PLAYERS = CFG.maxPlayers || 8;      // 複数人モードの最大人数
  const RANDOM_MULTI_MAX = 5;
  const TIMEOUT_OUT = 3;                        // 回答者が連続でこの回数だけ時間切れになったら降参扱い                   // ランダム対戦（複数人）の最大人数
  const MODE_LABEL = { duel: "1対1", multi: "複数人" };
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
    $("hero-example").textContent = CFG.heroExample || "〇〇";
    $("bias-input").placeholder = "例：" + (CFG.biasExample || "");
    $("free-input").placeholder = "例：" + (CFG.freeExample || "");
    $("guess-input").placeholder = "お題は誰（何）？";
    $("topic-input").placeholder = "お題（例：" + (CFG.topicExample || "") + "）";
    $("hint-input").placeholder = "ジャンル・任意（例：" + (CFG.hintExample || "") + "）※回答者に見えます";
    const foot = $("foot"); foot.textContent = "";
    if (CFG.support && CFG.support.url) {
      const p = el("p", "support");
      const a = el("a", "btn small", CFG.support.label || "開発者を応援する"); a.href = CFG.support.url; a.target = "_blank"; a.rel = "noopener";
      p.appendChild(a);
      if (CFG.support.note) p.appendChild(el("span", "muted", CFG.support.note));
      foot.appendChild(p);
    }
  }
  // --------------------------------------------------------------- screens
  function showScreen(name) {
    ["home", "lobby", "game"].forEach((s) => ($("screen-" + s).hidden = s !== name));
    window.scrollTo(0, 0);
  }
  // ホームへ：ルーム・対戦からは「一時的に抜ける」扱い（相手からは通信切れに見え、ホームの「前の対戦に戻る」で戻れる）
  function goHome() {
    leaveVersus(true);
    stopTimer();
    $("topbar-status").textContent = "";
    showScreen("home");
    renderResumeCard();
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
  const DEFAULT_OPTS = { bMax: 0, fMax: 3, gMax: 3, turnSec: 90, per: "each" };
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
    per: o.per === "total" ? "total" : "each",   // 複数人モードの回数：each=1人ずつ / total=全員合計
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
  const makePeer = (id) => new Peer(id, { debug: 0 });   // 相手が見つからない等の想定内のエラーをコンソールに出さない

  // ---- host
  function createRoom() {
    if (!peerAvailable()) { toast("通信ライブラリが読み込めていません"); return; }
    const name = myNick();
    lobbyStatus("ルームを作成中…");
    $("btn-create-room").disabled = true;
    tryHostCode(0, name, { mode: selectedRadio("roommode", "duel") });
  }
  const selectedRadio = (name, def) => { const r = document.querySelector(`input[name="${name}"]:checked`); return r ? r.value : def; };
  // ov: ランダム対戦用のフック { onOpen(H), onReady(code), onFail(e) }
  function tryHostCode(attempt, name, ov) {
    ov = ov || {};
    const code = ov.code || String(100000 + randInt(900000));
    const peer = makePeer(PEER_PREFIX + code);
    let settled = false;
    peer.on("open", () => {
      if (settled) { vs.hostOffline = false; renderConnBanner(); return; }   // サーバーへの再接続：ルームはそのまま
      settled = true;
      vs.peer = peer; vs.isHost = true; vs.code = code; vs.me = 0;
      vs.host = ov.restore ? restoreHostState(ov.restore, ov.restoreAt) : {
        mode: ov.mode === "multi" ? "multi" : "duel",   // duel=1対1 / multi=複数人（ルーム作成時に決める）
        randomMulti: !!ov.randomMulti,                  // ランダム対戦（複数人）のルーム：自動で出題者決定・開始・次の試合
        players: [newPlayer(name, null, SOCIAL.myCode())],
        chat: [],           // ルームチャット [{p, name, code, text, ts}]
        status: "lobby", setter: 0, topic: null,   // topic: { name, hint }（出題者だけが知っている。hint は回答者にも見える）
        opts: savedOpts(),
        log: [],            // [{k:"b"|"f", p, q, a} | {k:"g", p, q, r}] を時系列で（r: "ok"|"close"|"ng"|null=判定待ち）
        shared: null, phase: "ask",   // shared: 全員合計の残り回数 {b,f,g}（1人ずつのときは各プレイヤーの left）   // phase: ask=回答者の手番 / answer=出題者が質問に返事 / judge=出題者が回答を判定
        turn: 0, turnNo: 1, deadline: null, winner: null, reason: null, events: [],
      };
      peer.on("connection", onHostConnection);
      peer.on("disconnected", () => { if (peer.destroyed || vs.peer !== peer) return; vs.hostOffline = true; renderConnBanner(); try { peer.reconnect(); } catch {} });
      peer.on("error", (e) => { console.warn(e); if (e.type !== "peer-unavailable") toast("通信エラー: " + e.type); });
      if (ov.onOpen) ov.onOpen(vs.host);
      if (ov.restore) hostEvent("ホストが戻りました。ほかの参加者の復帰を待っています");
      $("btn-create-room").disabled = false;
      enterRoomView();
      hostBroadcast();
      if (ov.onReady) ov.onReady(code);
    });
    peer.on("error", (e) => {
      if (settled) return;
      settled = true;
      try { peer.destroy(); } catch {}
      if (e.type === "unavailable-id" && ov.code && attempt < 20) {   // 前のルーム番号がまだ解放されていない → 少し待って取り直す
        lobbyStatus(`前のルーム番号を取り戻しています…（${attempt + 1}）`);
        setTimeout(() => tryHostCode(attempt + 1, name, ov), 3000); return;
      }
      if (e.type === "unavailable-id" && !ov.code && attempt < 5) { tryHostCode(attempt + 1, name, ov); return; }
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
      if (H.status !== "lobby") { hostSend(conn, { t: "error", msg: "対戦中のため参加できません。次のゲームまでお待ちください。", fatal: true }); return; }
      const cap = roomCap(H);
      if (H.players.filter((p) => p.connected).length >= cap) { hostSend(conn, { t: "error", msg: "満員です（最大" + cap + "人）", fatal: true }); return; }
      const name = String(msg.name || "プレイヤー").slice(0, 12);
      const code = validCode(msg.code);
      if (code && SOCIAL.isBlocked(code)) { hostSend(conn, { t: "error", msg: "このルームには参加できません", fatal: true }); setTimeout(() => { try { conn.close(); } catch {} }, 300); return; }
      H.players.push(newPlayer(name, conn, code));
      sendWelcome(H.players[H.players.length - 1], H.players.length - 1);
      hostEvent(`${name} が参加しました`);
      randomMultiFlow();
      hostBroadcast();
      return;
    }
    if (msg.t === "rejoin") {   // 通信が切れた人が戻ってきた
      if (pIdx >= 0) return;
      const tok = String(msg.token || "");
      const i = tok ? H.players.findIndex((p) => p.token === tok) : -1;
      if (i >= 0) { hostReattach(i, conn); return; }
      if (H.status === "lobby") { hostOnMessage(conn, { t: "join", name: msg.name, code: msg.code }); return; }
      hostSend(conn, { t: "error", msg: "この対戦には戻れませんでした（すでに終わったか、ルームが変わりました）", fatal: true });
      setTimeout(() => { try { conn.close(); } catch {} }, 300);
      return;
    }
    if (pIdx < 0) return;
    if (msg.t === "leave") { hostOnLeave(conn, true); return; }
    if (msg.t === "ask") hostAsk(pIdx, msg.k, msg.q);
    else if (msg.t === "guess") hostGuess(pIdx, msg.q);
    else if (msg.t === "topic") { if (pIdx === H.setter) hostSetTopic(msg.topic); }
    else if (msg.t === "answer") { if (pIdx === H.setter) hostAnswer(msg.k); }
    else if (msg.t === "judge") { if (pIdx === H.setter) hostJudge(msg.r); }
    else if (msg.t === "surrender") hostSurrender(pIdx);
    else if (msg.t === "chat") hostChat(pIdx, msg.text);
    else if (msg.t === "stamp") hostStamp(pIdx, msg.k);
    else if (msg.t === "topicimg") { if (pIdx === H.setter) hostSetTopicImg(msg.data); }
  }
  // intent: 自分で退出した（ホームへ・退出ボタン・キック）。false は通信が途切れた
  function hostOnLeave(conn, intent) {
    const H = vs.host; if (!H) return;
    const p = H.players.find((x) => x.conn === conn);
    if (!p || !p.connected) return;
    p.connected = false;
    if (H.status === "playing" && !intent) {
      // 通信が途切れた：タイマーを止めて、ホストに「相手を待つ／待たずに続ける」を選んでもらう
      p.dropped = true;
      hostEvent(`${p.name} の通信が切れました`);
      hostPause();
      if (H.waitChoice !== "wait") H.waitChoice = "ask";
      hostBroadcast();
      return;
    }
    p.dropped = false;
    hostEvent(intent ? `${p.name} が退出しました` : `${p.name} が切断しました`);
    if (H.status === "lobby") {
      const setterP = H.players[H.setter];
      H.players = H.players.filter((x) => x.connected);
      const si = H.players.indexOf(setterP);
      if (si < 0) { H.setter = 0; H.topic = null; H.topicImg = null; } else H.setter = si;
      H.players.forEach((x, i) => sendWelcome(x, i));
      if (si < 0) H.setterPicked = false;
      randomMultiFlow();
    } else if (H.status === "playing") {
      const i = H.players.indexOf(p);
      if (i === H.setter) { finish(null, "setter_left"); hostBroadcast(); return; }
      checkRemaining();
      if (H.status === "playing" && H.turn === i && H.phase === "ask") advanceTurn();
    }
    hostBroadcast();
  }
  // 参加者ごとの復帰用の合言葉（token）も送る。出題者には自分のお題も（ページを開き直したときに表示できるように）
  function sendWelcome(p, i) {
    const H = vs.host; if (!p || !p.conn) return;
    const mine = H && i === H.setter;
    hostSend(p.conn, { t: "welcome", you: i, token: p.token, room: vs.code, topic: mine ? H.topic : null, img: mine ? H.topicImg || null : null });
  }
  // 通信が切れた人が戻ってきた
  function hostReattach(i, conn) {
    const H = vs.host; const p = H.players[i];
    const old = p.conn; p.conn = conn;   // 先に差し替えるので、古いつながりの close は無視される
    if (old && old !== conn) { try { old.close(); } catch {} }
    p.connected = true; p.dropped = false;
    sendWelcome(p, i);
    hostEvent(`${p.name} が復帰しました`);
    if (H.status === "playing" && !H.players.some((x) => x.dropped)) hostResume();
    hostBroadcast();
    if (H.status === "finished" && H.topicImg) hostSend(conn, { t: "img", data: H.topicImg });
  }
  // 一時停止（通信が切れた人を待つ間はタイマーを止める）
  function hostPause() {
    const H = vs.host; if (H.paused) return;
    H.paused = true;
    H.pausedLeft = H.deadline ? Math.max(1000, H.deadline - Date.now()) : null;
    H.deadline = null;
  }
  function hostResume() {
    const H = vs.host; if (!H.paused) return;
    H.paused = false; H.waitChoice = "";
    H.deadline = H.pausedLeft != null ? Date.now() + H.pausedLeft : null;
    H.pausedLeft = null;
  }
  // ホストが「相手を待つ」を選んだ
  function hostWait() {
    const H = vs.host; if (!H || H.status !== "playing" || !H.paused) return;
    H.waitChoice = "wait";
    hostEvent("通信が切れた人の復帰を待ちます（タイマー停止中）");
    hostBroadcast();
  }
  // ホストが「待たずに続ける」を選んだ：切れた人はその試合から抜ける（出題者なら試合終了）
  function hostNoWait() {
    const H = vs.host; if (!H || H.status !== "playing" || !H.paused) return;
    const gone = H.players.filter((p) => p.dropped);
    gone.forEach((p) => { p.dropped = false; });
    hostEvent(`${gone.map((p) => p.name).join("・") || "切断した人"} を待たずに続けます`);
    if (gone.includes(H.players[H.setter])) { H.paused = false; finish(null, "setter_left"); hostBroadcast(); return; }
    gone.forEach((p) => { p.out = true; p.outWhy = "d"; });
    hostResume();
    checkRemaining();
    if (H.status === "playing" && H.phase === "ask" && !eligible(H, H.turn)) advanceTurn();
    hostBroadcast();
  }

  // ---- ページを閉じても戻れるように、ルームの状態をこの端末に保存する
  const SNAP_KEY = CFG.id + ".hostSnap", REJOIN_KEY = CFG.id + ".rejoin";
  const RESUME_TTL = 3 * 60 * 60 * 1000;   // 3時間以内なら戻れる
  const jsonInf = (k, v) => (v === Infinity ? "__inf" : v);
  const unInf = (k, v) => (v === "__inf" ? Infinity : v);
  function saveHostSnap() {
    const H = vs.host; if (!H) return;
    try {
      const copy = { ...H, autoTimer: null, players: H.players.map((p) => ({ ...p, conn: null, chatTs: [] })) };
      localStorage.setItem(SNAP_KEY, JSON.stringify({ at: Date.now(), code: vs.code, name: H.players[0].name, H: copy }, jsonInf));
    } catch {}
  }
  const loadResume = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || "null", unInf); return v && Date.now() - v.at < RESUME_TTL ? v : null; } catch { return null; } };
  const clearResume = () => { try { localStorage.removeItem(SNAP_KEY); localStorage.removeItem(REJOIN_KEY); } catch {} };
  // 保存しておいた状態からルームを作り直す（参加者はまだ戻っていないので、対戦中なら一時停止して待つ）
  // at: 保存した時刻。ホストがいなかった間はタイマーを進めない
  function restoreHostState(R, at) {
    const H = R;
    H.autoTimer = null; H.autoStartPending = false;
    H.players.forEach((p, i) => {
      p.conn = null; p.chatTs = [];
      if (i === 0) { p.connected = true; p.dropped = false; return; }
      if (p.connected || p.dropped) p.dropped = H.status === "playing";
      p.connected = false;
    });
    if (H.status === "lobby") {
      if (H.setter !== 0) { H.topic = null; H.setterPicked = false; }
      H.players = [H.players[0]]; H.setter = 0;
    }
    if (H.status === "playing" && H.players.some((p) => p.dropped)) {
      H.pausedLeft = H.paused ? H.pausedLeft : (H.deadline ? Math.max(5000, H.deadline - (at || Date.now())) : null);
      H.paused = true; H.deadline = null; H.waitChoice = "wait";
    }
    return H;
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
    hostSend(p.conn, { t: "error", msg: "ルームから退出しました", fatal: true });
    setTimeout(() => { try { p.conn.close(); } catch {} hostOnLeave(p.conn, true); }, 300);
  }
  function hostEvent(text) { const H = vs.host; H.events.push(text); if (H.events.length > 20) H.events.shift(); }
  const setterName = (pub) => (pub.players[pub.setter] ? pub.players[pub.setter].name : "出題者");
  const eligible = (H, i) => { const p = H.players[i]; return !!p && p.connected && !p.out && i !== H.setter; };
  const randToken = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  const newPlayer = (name, conn, code) => ({ name, conn, connected: true, dropped: false, out: false, outWhy: "", code: code || "", token: randToken(), chatTs: [], stats: { hit: 0, esc: 0 }, left: null });
  const roomCap = (H) => (H.mode === "duel" ? 2 : H.randomMulti ? RANDOM_MULTI_MAX : MAX_PLAYERS);
  // 回数を1人ずつ数えるか（複数人モードで「1人ずつ」のとき。1対1は回答者が1人なのでどちらでも同じ）
  const perEach = (H) => H.mode === "multi" && H.opts.per !== "total";
  const freshLeft = (H) => ({ b: H.opts.bMax || Infinity, f: H.opts.fMax, g: H.opts.gMax });
  const pool = (H, i) => (perEach(H) ? H.players[i].left : H.shared);
  const finLeft = (L) => (L ? { b: L.b === Infinity ? -1 : L.b, f: L.f, g: L.g } : null);   // -1 = 無制限
  // ランダム対戦（複数人）の自動進行：3人そろったら出題者をランダムに決め、お題が決まったら5秒後に開始
  function randomMultiFlow() {
    const H = vs.host; if (!H || !H.randomMulti || H.status !== "lobby") return;
    const n = H.players.filter((p) => p.connected).length;
    if (n >= RANDOM_MULTI_MAX) releaseMatchHold(); else holdMatch();
    if (n >= 3 && !H.setterPicked) {
      H.setterPicked = true; H.setter = randInt(H.players.length); H.topic = null;
      hostEvent(`出題者は ${H.players[H.setter].name} に決まりました`);
    }
    if (H.topic && H.setterPicked && n >= 2) {
      if (!H.autoStartPending) {
        H.autoStartPending = true;
        hostEvent("お題が決まりました。5秒後に開始します");
        clearTimeout(H.autoTimer);
        H.autoTimer = setTimeout(() => { H.autoStartPending = false; if (vs.host === H && H.status === "lobby" && H.topic) hostStart(); }, 5000);
      }
    } else if (H.autoStartPending) { H.autoStartPending = false; clearTimeout(H.autoTimer); }
  }


  function hostStart() {
    const H = vs.host;
    if (H.players.filter((p) => p.connected).length < 2) { toast("回答者が1人以上必要です"); return; }
    if (!H.topic) { toast("お題が決まっていません"); return; }
    const setterP = H.players[H.setter];
    H.players = H.players.filter((p) => p.connected);
    H.setter = Math.max(0, H.players.indexOf(setterP));
    H.players.forEach((p, i) => { p.out = false; p.outWhy = ""; p.timeouts = 0; p.left = freshLeft(H); sendWelcome(p, i); });
    H.log = []; H.winner = null; H.reason = null; H.events = [];
    H.shared = freshLeft(H); H.phase = "ask";
    clearTimeout(H.autoTimer); H.autoStartPending = false; releaseMatchHold();
    H.imgSent = false;
    H.status = "playing";
    H.turn = H.setter; H.turnNo = 1;
    advanceTurn(); H.turnNo = 1;
    hostEvent(`対戦開始！ ${H.players[H.setter].name} のお題を偏見で当てよう${H.topic.hint ? `（ジャンル：${H.topic.hint}）` : ""}`);
    hostBroadcast();
  }
  function hostBackToLobby(rotateSetter) {
    const H = vs.host; if (!H) return;
    const cur = H.players[H.setter];
    H.status = "lobby"; H.paused = false; H.waitChoice = ""; H.pausedLeft = null; H.topic = null; H.topicImg = null; H.imgSent = false; H.log = []; H.winner = null; H.reason = null; H.events = []; H.phase = "ask"; H.deadline = null;
    H.players = H.players.filter((p) => p.connected);
    H.players.forEach((p, i) => { p.out = false; p.outWhy = ""; sendWelcome(p, i); });
    let si = Math.max(0, H.players.indexOf(cur));
    if (rotateSetter && H.players.length > 1) si = (si + 1) % H.players.length;
    H.setter = si;
    clearTimeout(H.autoTimer); H.autoStartPending = false;
    if (H.randomMulti) { if (H.players.length < 3) H.setterPicked = false; holdMatch(); randomMultiFlow(); }
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
    if (H.setter !== i) { H.setter = i; H.topic = null; H.topicImg = null; hostEvent(`出題者が ${H.players[i].name} に交代`); }
    hostBroadcast();
  }
  const cleanTopic = (t) => {
    if (!t || typeof t !== "object") return null;
    const name = String(t.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const hint = String(t.hint || "").replace(/\s+/g, " ").trim().slice(0, 30);
    return name ? { name, hint } : null;
  };
  function hostSetTopic(t) {
    const H = vs.host; if (!H || H.status !== "lobby") return;
    H.topic = cleanTopic(t);
    randomMultiFlow();
    hostBroadcast();
  }

  // ---- お題の画像（出題者の端末で縮めて持っておき、正解発表のときに参加者へ直接送る。サーバーには保存しない）
  const IMG_MAX_LEN = 400000;   // 受け取る画像の上限（data URL の文字数）
  const validImg = (d) => typeof d === "string" && d.length < IMG_MAX_LEN && /^data:image\/(jpeg|png|webp);base64,/.test(d);
  async function shrinkImage(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error("画像ファイルを選んでください");
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("画像を読み込めませんでした")); i.src = url; });
      const r = Math.min(1, 480 / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(img.width * r)); c.height = Math.max(1, Math.round(img.height * r));
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      let q = 0.82, data = c.toDataURL("image/jpeg", q);
      while (data.length > 200000 && q > 0.35) { q -= 0.12; data = c.toDataURL("image/jpeg", q); }
      return data;
    } finally { URL.revokeObjectURL(url); }
  }
  const SHOW_IMG_KEY = CFG.id + ".showImages";
  let showImages = true;
  try { showImages = localStorage.getItem(SHOW_IMG_KEY) !== "0"; } catch {}
  const myTopicImg = () => (vs.isHost ? (vs.host ? vs.host.topicImg || null : null) : vs.myTopicImg || null);
  function setTopicImg(data) {
    if (vs.isHost) { if (vs.host && vs.host.status === "lobby") { vs.host.topicImg = data; saveHostSnap(); } }
    else { vs.myTopicImg = data; if (vs.conn) vs.conn.send({ t: "topicimg", data }); }
    renderTopicUI();
  }
  function hostSetTopicImg(data) {
    const H = vs.host; if (!H || H.status !== "lobby") return;
    H.topicImg = data && validImg(data) ? data : null;
    saveHostSnap();
  }
  // 正解発表の画像（結果カードの中の枠に入れる。届くのが状態より後になることもある）
  function renderAnswerImg() {
    const box = $("answer-img-box"); if (!box) return;
    const pub = vs.pub; const data = vs.answerImg;
    const key = (data ? data.length : 0) + ":" + showImages;   // 同じなら作り直さない（タップで見せた状態を保つ）
    if (box.dataset.key === key) return;
    box.dataset.key = key; box.innerHTML = "";
    if (!pub || !data) { box.hidden = true; return; }
    const setterP = pub.players[pub.setter];
    if (setterP && setterP.code && SOCIAL.isBlocked(setterP.code)) { box.hidden = true; return; }
    box.hidden = false;
    if (!showImages) {
      const b = el("button", "btn small", "🖼️ お題の画像を表示する"); b.type = "button";
      b.addEventListener("click", () => { box.innerHTML = ""; box.appendChild(imgEl(data, false)); });
      box.appendChild(b); return;
    }
    // ランダム対戦（知らない人）の画像は、ぼかして表示してタップで見せる
    box.appendChild(imgEl(data, !!pub.fromRandom && vs.me !== pub.setter));
  }
  function imgEl(data, blur) {
    const wrap = el("div", "answer-img-wrap" + (blur ? " blur" : ""));
    const im = el("img", "answer-img"); im.src = data; im.alt = "お題の画像"; wrap.appendChild(im);
    if (blur) {
      wrap.appendChild(el("span", "blur-note", "タップして画像を表示"));
      wrap.addEventListener("click", () => wrap.classList.remove("blur"), { once: true });
    }
    return wrap;
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
    const on = !!pub && vs.me === pub.setter && pub.status === "lobby" && pub.setterPicked !== false;
    if (pub && vs.me !== pub.setter) vs.myTopicImg = null;   // 出題者でなくなったら持っている画像も捨てる
    $("topic-field").hidden = !on;
    if (!on) return;
    const t = myTopic();
    $("topic-picker").hidden = !!t; $("topic-chosen").hidden = !t;
    const img = myTopicImg();
    $("topic-img-preview").hidden = !img; if (img) $("topic-img-preview").src = img;
    $("btn-topic-img-clear").hidden = !img;
    $("topic-img-label").textContent = img ? "🖼️ 画像を変える" : "🖼️ 画像を添付（任意）";
    if (t) { $("topic-name").textContent = t.name; $("topic-hint").textContent = t.hint ? `ジャンル：${t.hint}` : "ジャンルなし"; }
  }

  // 回答者の質問（k: "b"=偏見, "f"=自由質問）
  function hostAsk(pIdx, k, q) {
    const H = vs.host;
    if (H.status !== "playing" || H.paused || H.phase !== "ask" || H.turn !== pIdx || !eligible(H, pIdx)) return;
    if (k !== "b" && k !== "f") return;
    q = k === "b" ? normBias(q) : normFree(q);
    if (!q) return;
    const L = pool(H, pIdx);
    if (k === "b" && L.b <= 0) { errTo(pIdx, "偏見の回数がもうありません"); return; }
    if (k === "f" && L.f <= 0) { errTo(pIdx, "自由質問の回数がもうありません"); return; }
    H.log.push({ k, p: pIdx, q, a: null });
    H.players[pIdx].timeouts = 0;
    if (k === "b") L.b--; else L.f--;
    H.phase = "answer";
    H.deadline = H.opts.turnSec ? Date.now() + H.opts.turnSec * 1000 : null;
    hostBroadcast();
  }
  // 出題者の返事
  function hostAnswer(a) {
    const H = vs.host;
    if (!H || H.status !== "playing" || H.paused || H.phase !== "answer") return;
    const last = H.log[H.log.length - 1]; if (!last || (last.k !== "b" && last.k !== "f") || last.a) return;
    if (!answersFor(last.k).some((x) => x.k === a)) return;
    last.a = a;
    H.phase = "ask";
    const L = pool(H, last.p);
    if (L.b <= 0 && L.f <= 0) hostEvent(perEach(H) ? `${H.players[last.p].name} は質問を使い切りました。あとは回答だけです` : `質問はもう使い切りました。あとは回答だけです`);
    H.turnNo++;
    advanceTurn();
    hostBroadcast();
  }
  // 回答：お題と同じ文字なら自動で正解。それ以外は出題者の判定待ち
  function hostGuess(pIdx, q) {
    const H = vs.host;
    if (H.status !== "playing" || H.paused || H.phase !== "ask" || H.turn !== pIdx || !eligible(H, pIdx)) return;
    q = normFree(q).slice(0, 40);
    if (!q) return;
    const L = pool(H, pIdx);
    if (L.g <= 0) { errTo(pIdx, "回答できる回数がもうありません"); return; }
    if (H.log.some((g) => g.k === "g" && textNorm(g.q) === textNorm(q))) { errTo(pIdx, "すでに同じ回答が出ています"); return; }
    H.log.push({ k: "g", p: pIdx, q, r: null });
    H.players[pIdx].timeouts = 0;
    L.g--;
    if (textNorm(q) === textNorm(H.topic.name)) { hostJudge("ok"); return; }
    H.phase = "judge";
    H.deadline = null;   // 判定には制限時間を付けない（時間切れで勝敗が決まらないように）
    hostBroadcast();
  }
  function hostJudge(r) {
    const H = vs.host;
    if (!H || H.status !== "playing" || H.paused || !["ok", "close", "ng"].includes(r)) return;
    const last = H.log[H.log.length - 1]; if (!last || last.k !== "g" || last.r) return;
    last.r = r;
    H.phase = "ask";
    if (r === "ok") finish(last.p, "correct");
    else {
      const p = H.players[last.p], L = pool(H, last.p);
      hostEvent(`${p.name} の回答「${last.q}」は${r === "close" ? "惜しい！" : "不正解"}（${perEach(H) ? p.name + " の" : ""}回答 残り${L.g}回）`);
      if (L.g <= 0 && !perEach(H)) finish(null, "no_guesses");
      else {
        // 1人ずつのとき：回答を使い切った人はこの試合から抜ける
        if (L.g <= 0) { p.out = true; p.outWhy = "g"; hostEvent(`${p.name} は回答を使い切りました`); checkRemaining(); }
        if (H.status === "playing") { H.turnNo++; advanceTurn(); }
      }
    }
    hostBroadcast();
  }
  function hostSurrender(pIdx) {
    const H = vs.host;
    if (H.status !== "playing") return;
    const p = H.players[pIdx]; if (!p || p.out || pIdx === H.setter) return;
    p.out = true; p.outWhy = "s"; hostEvent(`${p.name} が降参しました`);
    checkRemaining();
    if (H.status === "playing" && H.turn === pIdx && H.phase === "ask") advanceTurn();
    hostBroadcast();
  }
  function checkRemaining() {
    const H = vs.host;
    if (!H.players.some((p, i) => eligible(H, i))) finish(null, H.players.some((p) => p.outWhy === "g") ? "no_guesses" : "all_out");
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
  function finish(winner, reason) {
    const H = vs.host; H.status = "finished"; H.winner = winner; H.reason = reason; H.deadline = null;
    H.paused = false; H.waitChoice = ""; H.pausedLeft = null;
    // 成績：当てた人は 🎯、誰にも当てられなければ出題者に 🛡️
    if (reason === "correct" && H.players[winner]) H.players[winner].stats.hit++;
    else if ((reason === "no_guesses" || reason === "all_out") && H.players[H.setter]) H.players[H.setter].stats.esc++;
    if (H.randomMulti) {
      hostEvent("12秒後に次の試合へ（出題者を交代）");
      clearTimeout(H.autoTimer);
      H.autoTimer = setTimeout(() => { if (vs.host === H && H.status === "finished") hostBackToLobby(true); }, 12000);
    }
  }
  function hostTick() {
    const H = vs.host;
    if (!H || H.status !== "playing" || H.paused || !H.deadline || Date.now() < H.deadline) return;
    if (H.phase === "answer") { hostEvent(`${H.players[H.setter].name} が時間内に答えなかったので「${answerLabel(H.log[H.log.length - 1].k, "unknown")}」扱い`); hostAnswer("unknown"); return; }
    // 回答者の時間切れ：偏見を1回分消費してログに残し、手番を回す（偏見が無制限・残り0のときは消費なし）。
    // 連続で TIMEOUT_OUT 回時間切れになったら降参扱い
    const p = H.players[H.turn], L = pool(H, H.turn);
    const used = L && L.b > 0 && L.b !== Infinity;
    if (used) L.b--;
    p.timeouts = (p.timeouts || 0) + 1;
    const out = p.timeouts >= TIMEOUT_OUT;
    H.log.push({ k: "t", p: H.turn, used, n: p.timeouts, out });
    hostEvent(`${p.name} は時間切れ${used ? `（偏見を1回消費・残り${L.b}回）` : ""}` + (out ? `。${TIMEOUT_OUT}回連続のため降参扱い` : `（連続${p.timeouts}回目。あと${TIMEOUT_OUT - p.timeouts}回で降参扱い）`));
    if (out) { p.out = true; p.outWhy = "t"; checkRemaining(); }
    if (H.status === "playing") { H.turnNo++; advanceTurn(); }
    hostBroadcast();
  }
  function publicState() {
    const H = vs.host;
    return {
      status: H.status, topicChosen: !!H.topic, setter: H.setter, hint: H.status !== "lobby" && H.topic ? H.topic.hint : "",
      mode: H.mode, randomMulti: H.randomMulti, setterPicked: !H.randomMulti || !!H.setterPicked, per: perEach(H), cap: roomCap(H),
      paused: !!H.paused, waitChoice: H.waitChoice || "", fromRandom: !!(H.fromRandom || H.randomMulti),
      players: H.players.map((p) => ({ name: p.name, connected: p.connected, dropped: !!p.dropped, out: p.out, outWhy: p.outWhy || "", code: p.code || "", stats: p.stats, left: finLeft(p.left) })),
      chat: H.chat,
      opts: H.opts, log: H.log, shared: finLeft(H.shared), phase: H.phase,
      turn: H.turn, turnNo: H.turnNo, now: Date.now(), deadline: H.deadline,
      winner: H.winner, reason: H.reason, events: H.events,
      answer: H.status === "finished" && H.topic ? H.topic.name : "",
    };
  }
  function hostBroadcast() {
    const H = vs.host; if (!H) return;
    const pub = publicState();
    H.players.forEach((p) => { if (p.conn && p.connected) hostSend(p.conn, { t: "state", s: pub }); });
    if (H.status === "finished" && H.topicImg && !H.imgSent) {
      H.imgSent = true;
      H.players.forEach((p) => { if (p.conn && p.connected) hostSend(p.conn, { t: "img", data: H.topicImg }); });
      vs.answerImg = H.topicImg;
    }
    applyState(pub);
    renderAnswerImg();
    saveHostSnap();
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
    document.querySelectorAll('input[name="matchmode"]').forEach((r) => (r.disabled = false));
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
    if (selectedRadio("matchmode", "duel") === "multi") { startMultiMatch(); return; }
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
              mode: "duel",
              onOpen: (H) => { H.setter = randInt(2); H.fromRandom = true; },   // 最初の出題者はランダム（1 はこれから入る相手）
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

  // ---- ランダム対戦（複数人）
  // 待ち合わせ ID（<ゲームID>-match-multi）を持っている人がルームのホスト。あとから来た人はその ID に接続してルームコードをもらう。
  // 誰も持っていなければ自分が ID を取ってルームを作る。満員か試合開始で ID を手放し、ロビーに戻って空きがあれば取り直す。
  const MATCH_MULTI_ID = PEER_PREFIX + "match-multi";
  let matchHold = null, holdPending = false;   // ホストが持っている待ち合わせ用の Peer
  function startMultiMatch() {
    match.active = true; match.started = Date.now(); match.fails = 0;
    $("btn-match").hidden = true; $("btn-match-cancel").hidden = false;
    document.querySelectorAll('input[name="matchmode"]').forEach((r) => (r.disabled = true));
    lobbyStatus(""); matchStatus("ルームを探しています…");
    clearInterval(match.timer); match.timer = setInterval(matchTick, 1000);
    multiSeek(0);
  }
  // 1) 待ち合わせ ID を持っているホストに接続して、ルームコードをもらう
  function multiSeek(attempt) {
    if (!match.active) return;
    const peer = makePeer(undefined); match.peer = peer;
    let done = false;
    const end = () => { done = true; setTimeout(() => { try { peer.destroy(); } catch {} }, 300); };
    peer.on("open", () => {
      const conn = peer.connect(MATCH_MULTI_ID, { reliable: true });
      const t = setTimeout(() => {
        if (done) return; end();
        if (!match.active) return;
        if (++match.fails >= 3) { matchReset(); lobbyStatus("ルームに接続できませんでした。Wi-Fi／モバイル回線を切り替えるか、時間をおいて再度お試しください。"); }
        else setTimeout(() => multiSeek(attempt + 1), 1500);
      }, 15000);
      conn.on("open", () => {
        clearTimeout(t);
        conn.send({ t: "hello", name: vs.name });
        conn.on("data", (msg) => {
          if (done || !msg) return;
          if (msg.t === "room") {
            end(); match.peer = null; match.active = false; clearInterval(match.timer);
            $("join-code").value = String(msg.code || "");
            joinRoom();
            matchReset();
          } else if (msg.t === "full") { end(); setTimeout(() => multiSeek(attempt + 1), 1500 + randInt(1000)); }
        });
      });
    });
    peer.on("error", (e) => {
      if (done) return; end();
      if (!match.active) return;
      if (e.type === "peer-unavailable") multiClaim(attempt);   // 誰もいない → 自分がルームを作って待つ
      else { matchReset(); lobbyStatus("接続エラー: " + e.type); }
    });
  }
  // 2) 待ち合わせ ID を取り、取れたらルームを作る（取れなければ誰かが先に取ったので、そちらに入りに行く）
  function multiClaim(attempt) {
    if (!match.active) return;
    const hold = makePeer(MATCH_MULTI_ID);
    let settled = false;
    hold.on("open", () => {
      settled = true;
      if (!match.active) { try { hold.destroy(); } catch {} return; }
      matchStatus("ルームを作成中…");
      tryHostCode(0, vs.name, {
        mode: "multi", randomMulti: true,
        onReady: () => {
          match.active = false; clearInterval(match.timer); match.peer = null;
          matchReset();
          attachHold(hold);
          hostEvent("ランダム対戦（複数人）のルームを作りました。参加者を待っています");
          hostBroadcast();
        },
        onFail: () => { try { hold.destroy(); } catch {} matchReset(); lobbyStatus("ルームを作成できませんでした。もう一度お試しください。"); },
      });
    });
    hold.on("error", (e) => {
      if (settled) { console.warn(e); return; }
      settled = true;
      try { hold.destroy(); } catch {}
      if (!match.active) return;
      if (e.type === "unavailable-id" && attempt < 6) setTimeout(() => multiSeek(attempt + 1), 800 + randInt(700));
      else { matchReset(); lobbyStatus("ルームを探せませんでした（" + e.type + "）。時間をおいて再度お試しください。"); }
    });
  }
  // 待ち合わせ ID に来た人へ、空きがあればルームコードを渡す
  function attachHold(hold) {
    if (matchHold && matchHold !== hold) { try { hold.destroy(); } catch {} return; }
    matchHold = hold;
    hold.on("connection", (conn) => {
      conn.on("open", () => {
        conn.on("data", (msg) => {
          if (!msg || msg.t !== "hello") return;
          const H = vs.host;
          const ok = H && H.randomMulti && H.status === "lobby" && H.players.filter((p) => p.connected).length < RANDOM_MULTI_MAX;
          try { conn.send(ok ? { t: "room", code: vs.code } : { t: "full" }); } catch {}
          setTimeout(() => { try { conn.close(); } catch {} }, 1500);
        });
      });
    });
    hold.on("disconnected", () => { if (matchHold === hold && !hold.destroyed) { try { hold.reconnect(); } catch {} } });
    hold.on("error", (e) => console.warn(e));
  }
  function holdMatch() {
    const H = vs.host;
    if (!H || !H.randomMulti || H.status !== "lobby" || matchHold || holdPending || !peerAvailable()) return;
    holdPending = true;
    const hold = makePeer(MATCH_MULTI_ID);
    hold.on("open", () => {
      holdPending = false;
      if (vs.host === H && H.status === "lobby" && H.players.filter((p) => p.connected).length < RANDOM_MULTI_MAX) attachHold(hold);
      else { try { hold.destroy(); } catch {} }
    });
    hold.on("error", () => { holdPending = false; try { hold.destroy(); } catch {} });   // 他のルームが持っている → そのまま
  }
  function releaseMatchHold() {
    if (matchHold) { try { matchHold.destroy(); } catch {} }
    matchHold = null;
  }

  // ---- guest
  // ホストにつなぐ（参加・復帰で共通）。opts: { first: 最初に送るメッセージ, onOpen(), onFail(msg) }
  function connectHost(code, opts) {
    const peer = makePeer(undefined);
    let joined = false;
    const fail = (msg) => { if (joined) return; joined = true; try { peer.destroy(); } catch {} opts.onFail(msg); };
    const timeout = setTimeout(() => fail("ホストに接続できませんでした。"), 15000);
    peer.on("open", () => {
      if (joined) return;   // サーバーへの再接続でも open が来るので、2回目は無視
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      conn.on("open", () => {
        clearTimeout(timeout); joined = true;
        vs.peer = peer; vs.conn = conn; vs.isHost = false; vs.code = code; vs.lost = false;
        conn.send(opts.first);
        conn.on("data", guestOnMessage);
        conn.on("close", () => onHostLost(conn));
        conn.on("error", () => onHostLost(conn));
        if (opts.onOpen) opts.onOpen();
      });
    });
    peer.on("error", (e) => { clearTimeout(timeout); fail(e.type === "peer-unavailable" ? "そのコードのルームが見つかりません。" : "接続エラー: " + e.type); });
  }
  function joinRoom() {
    if (!peerAvailable()) { toast("通信ライブラリが読み込めていません"); return; }
    const code = $("join-code").value.replace(/\D/g, "");
    if (code.length !== 6) { toast("6桁のコードを入力してください"); return; }
    const name = myNick();
    lobbyStatus("ルームに接続中…");
    $("btn-join-room").disabled = true;
    connectHost(code, {
      first: { t: "join", name, code: SOCIAL.myCode() },
      onOpen: () => { $("btn-join-room").disabled = false; enterRoomView(); },
      onFail: (msg) => { $("btn-join-room").disabled = false; lobbyStatus(msg === "そのコードのルームが見つかりません。" || msg.startsWith("接続エラー") ? msg : "ホストに接続できませんでした。コードを確認してください。"); },
    });
  }
  // 通信が切れたあとの「対戦に戻る」：つながるまで数秒おきに試す（相手側が戻るのを待つことにもなる）
  let rejoinTimer = null;
  function rejoin() {
    const r = loadResume(REJOIN_KEY);
    if (!r) { toast("戻れる対戦がありません"); vs.lost = false; renderConnBanner(); renderResumeCard(); return; }
    if (!peerAvailable()) { toast("通信ライブラリが読み込めていません"); return; }
    clearTimeout(rejoinTimer);
    vs.rejoining = true; renderConnBanner();
    if ($("screen-home").hidden === false) { openLobby(); lobbyStatus("対戦に戻っています…"); }
    connectHost(r.room, {
      first: { t: "rejoin", token: r.token, name: vs.name || "プレイヤー", code: SOCIAL.myCode() },
      onOpen: () => { vs.rejoining = false; vs.lost = false; enterRoomView(); renderConnBanner(); renderResumeCard(); },   // 状態が届くと対戦／ルームの画面に切り替わる
      onFail: () => { if (!vs.rejoining) return; renderConnBanner(); rejoinTimer = setTimeout(rejoin, 4000); },
    });
  }
  function stopRejoin() { vs.rejoining = false; clearTimeout(rejoinTimer); renderConnBanner(); }
  function guestOnMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "welcome") {
      vs.me = msg.you | 0;
      if (msg.topic) vs.myTopic = msg.topic;
      if (msg.img && validImg(msg.img)) vs.myTopicImg = msg.img;
      try { localStorage.setItem(REJOIN_KEY, JSON.stringify({ at: Date.now(), room: msg.room || vs.code, token: msg.token })); } catch {}
    }
    else if (msg.t === "state") applyState(msg.s);
    else if (msg.t === "stamp") showStamp(msg);
    else if (msg.t === "img") { if (validImg(msg.data)) { vs.answerImg = msg.data; renderAnswerImg(); } }
    else if (msg.t === "closed") { leaveVersus(); openLobby(); lobbyStatus("ホストがルームを閉じました。"); toast("ホストがルームを閉じました"); }
    else if (msg.t === "error") {
      toast(msg.msg || "エラー"); lobbyStatus(msg.msg || "");
      if (msg.fatal) { const m = msg.msg; leaveVersus(); openLobby(); lobbyStatus(m); }   // 参加できない・退出させられた など
    }
  }
  // 予期しない切断：画面はそのままにして「対戦に戻る」を出す
  function onHostLost(conn) {
    if (conn && conn !== vs.conn) return;   // 古いつながり
    if (!vs.peer) return;
    try { vs.peer.destroy(); } catch {}
    vs.peer = null; vs.conn = null; vs.lost = true; vs.deadlineLocal = null;
    $("act-panel").hidden = true; $("answer-panel").hidden = true;
    toast("通信が切れました");
    renderConnBanner();
  }
  // 通信まわりのお知らせ（画面上部）
  function renderConnBanner() {
    const b = $("conn-banner"), txt = $("conn-text"), act = $("conn-actions");
    act.innerHTML = "";
    const btn = (label, cls, fn) => { const x = el("button", "btn small " + (cls || ""), label); x.type = "button"; x.addEventListener("click", fn); act.appendChild(x); };
    const pub = vs.pub;
    let msg = "", warn = false;
    if (!vs.isHost && (vs.lost || vs.rejoining)) {
      warn = true;
      if (vs.rejoining) { msg = "再接続しています…（相手が戻るまで待ちます）"; btn("やめる", "", stopRejoin); }
      else { msg = "通信が切れました。"; btn("対戦に戻る", "primary", rejoin); }
      btn("ホームへ", "", goHome);
    } else if (vs.isHost && vs.hostOffline) {
      warn = true;
      msg = "サーバーとの接続が切れました。再接続しています…";
      btn("再接続", "", () => { try { vs.peer && vs.peer.reconnect(); } catch {} });
    } else if (pub && pub.status === "playing" && pub.paused) {
      const names = pub.players.filter((p) => p.dropped).map((p) => p.name).join("・") || "参加者";
      if (vs.isHost && pub.waitChoice === "ask") { msg = `${names} の通信が切れました（タイマー停止中）`; btn("相手を待つ", "primary", hostWait); btn("待たずに続ける", "", hostNoWait); }
      else if (vs.isHost) { msg = `${names} の復帰を待っています…（タイマー停止中）`; btn("待つのをやめて続ける", "", hostNoWait); }
      else msg = `${names} の通信が切れました。復帰を待っています（タイマー停止中）`;
    }
    b.hidden = !msg; b.classList.toggle("warn", warn); txt.textContent = msg;
  }
  // ホーム画面の「前の対戦に戻る」
  function renderResumeCard() {
    const snap = loadResume(SNAP_KEY), rj = loadResume(REJOIN_KEY);
    const it = snap && (!rj || snap.at >= rj.at) ? { host: true, ...snap } : rj ? { host: false, ...rj } : null;
    $("resume-card").hidden = !it || !!vs.peer;
    if (!it) return;
    $("resume-text").textContent = it.host
      ? `ルーム ${it.code} の${it.H.status === "playing" ? "対戦" : "ルーム"}（あなたがホスト）に戻れます`
      : `ルーム ${it.room} に戻れます（相手がまだルームにいれば、対戦かルームに復帰します）`;
    $("btn-resume").onclick = () => {
      if (it.host) {
        openLobby(); lobbyStatus("ルームを元に戻しています…");
        tryHostCode(0, it.name, { code: it.code, restore: it.H, restoreAt: it.at, mode: it.H.mode, randomMulti: it.H.randomMulti,
          onFail: (e) => { lobbyStatus("ルームを元に戻せませんでした（" + e.type + "）。"); clearResume(); } });
      } else rejoin();
      $("resume-card").hidden = true;
    };
  }

  // ---- shared
  function enterRoomView() {
    $("lobby-choice").hidden = true; $("lobby-room").hidden = false; $("lobby-match").hidden = true;
    $("room-code-display").textContent = vs.code;
    $("btn-start").hidden = !vs.isHost;
    lobbyStatus("");
    $("topbar-status").textContent = "ルーム " + vs.code;
  }
  // keep=true：あとで戻れるように、戻る情報を残して相手には何も伝えずに切る（ホームへ）
  // keep=false：完全に抜ける（退出ボタンなど）。自分で抜けたことを伝えてから切る（通信切れと区別するため）
  function leaveVersus(keep) {
    stopTimer();
    releaseMatchHold();
    if (vs.host) clearTimeout(vs.host.autoTimer);
    if (match.active) matchReset();
    clearTimeout(rejoinTimer);
    const oldPeer = vs.peer, oldConn = vs.conn;
    if (keep && vs.isHost) saveHostSnap();   // 抜けた瞬間の状態（タイマーの残り）を保存
    if (!keep || !vs.code) {
      clearResume();
      if (vs.isHost && vs.host) vs.host.players.forEach((p) => { if (p.conn && p.connected) hostSend(p.conn, { t: "closed" }); });
      else if (oldConn && oldConn.open) { try { oldConn.send({ t: "leave" }); } catch {} }
    }
    setTimeout(() => { try { oldConn && oldConn.close(); } catch {} try { oldPeer && oldPeer.destroy(); } catch {} }, 300);
    vs.lost = false; vs.rejoining = false; vs.hostOffline = false;
    $("conn-banner").hidden = true;
    vs.peer = null; vs.conn = null; vs.host = null; vs.pub = null; vs.isHost = false; vs.code = null; vs.me = -1; vs.myTopic = null;
    lastStatus = null;
    $("topbar-status").textContent = "";
    $("room-chat").hidden = true; $("chat-list").innerHTML = ""; chatKey = ""; chatSeenTs = null;
    $("pop-area").innerHTML = ""; $("stamp-area").innerHTML = "";
    SOCIAL.refresh();
  }
  function renderPlayers(ul, pub, withSocial) {
    ul.innerHTML = "";
    pub.players.forEach((p, i) => {
      const li = el("li", (i === vs.me ? "me " : "") + (pub.status === "playing" && pub.turn === i && pub.phase === "ask" ? "turn " : "") + (!p.connected || p.out ? "offline" : ""));
      const dot = el("span", "pdot"); dot.style.setProperty("--c", PLAYER_COLORS[i % PLAYER_COLORS.length]); li.appendChild(dot);
      li.appendChild(el("span", null, p.name + (i === 0 ? "（ホスト）" : "")));
      const setter = i === pub.setter && pub.setterPicked !== false;   // ランダム対戦（複数人）は3人そろうまで出題者なし
      const tag = !p.connected ? (p.dropped ? "通信切れ" : "切断") : p.out ? (p.outWhy === "g" ? "回答切れ" : p.outWhy === "t" ? "時間切れで降参" : p.outWhy === "d" ? "切断（離脱）" : "降参") : setter ? (i === vs.me ? "出題者（あなた）" : "出題者") : i === vs.me ? "あなた" : "";
      if (p.stats && (p.stats.hit || p.stats.esc)) li.appendChild(el("span", "p-stats", (p.stats.hit ? `🎯${p.stats.hit}` : "") + (p.stats.esc ? ` 🛡️${p.stats.esc}` : "")));
      if (pub.status === "playing" && pub.per && !setter && p.left && !p.out) li.appendChild(el("span", "p-left", `回答残り${p.left.g}`));
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
  const optsSummary = (pub) => {
    const o = pub.opts;
    const each = pub.mode === "multi" && o.per !== "total";
    return [
      pub.randomMulti ? `ランダム対戦（複数人・最大${pub.cap}人）` : pub.mode === "multi" ? `複数人（最大${pub.cap}人）` : "1対1",
      o.bMax ? `偏見 ${o.bMax}回` : "偏見 無制限", `自由質問 ${o.fMax}回`, `回答 ${o.gMax}回` + (pub.mode === "multi" ? (each ? "（1人ずつ）" : "（全員合計）") : ""),
      o.turnSec ? `1手 ${o.turnSec}秒` : "制限時間なし",
    ].join("・");
  };
  function renderLobby(pub) {
    renderPlayers($("lobby-players"), pub, true);
    // 設定
    $("room-options").hidden = false;
    $("room-options-host").hidden = !vs.isHost;
    $("room-options-summary").textContent = optsSummary(pub);
    $("room-per-field").hidden = pub.mode !== "multi";
    if (vs.isHost) {
      const set = (id, v) => { const e = $(id); if (e.value !== String(v)) e.value = String(v); };
      set("room-bias", pub.opts.bMax); set("room-free", pub.opts.fMax); set("room-guess", pub.opts.gMax); set("room-turn-seconds", pub.opts.turnSec); set("room-per", pub.opts.per);
      // 出題者の選択
      $("setter-field").hidden = !!pub.randomMulti;   // ランダム対戦（複数人）は自動で決まる
      const sel = $("setter-select"); sel.innerHTML = "";
      pub.players.forEach((p, i) => { const o = el("option", null, p.name + (i === 0 ? "（ホスト）" : "")); o.value = String(i); sel.appendChild(o); });
      sel.value = String(pub.setter);
      $("btn-start").disabled = pub.players.filter((p) => p.connected).length < 2 || !pub.topicChosen;
    } else $("setter-field").hidden = true;
    if (!pub.topicChosen) vs.myTopic = null;
    renderTopicUI();
    const meSet = vs.me === pub.setter;
    const n = pub.players.filter((p) => p.connected).length;
    if (pub.randomMulti) {
      $("lobby-hint").textContent = n < 3 ? `参加者を待っています（${n}人）。3人そろうと出題者がランダムで決まります。`
        : meSet ? (pub.topicChosen ? "お題が決まりました。まもなく開始します。" : "あなたが出題者に選ばれました！お題を決めると自動で開始します。")
        : (pub.topicChosen ? "お題が決まりました。まもなく開始します。" : `${setterName(pub)} がお題を選んでいます…`);
      return;
    }
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
  let chatSeenTs = null;   // ポップを出した最後の発言の時刻（入った直後の過去ログは出さない）
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
    const lastTs = chat.length ? chat[chat.length - 1].ts : 0;
    if (chatSeenTs != null) chat.filter((m) => m.ts > chatSeenTs && m.p !== vs.me && !SOCIAL.isBlocked(m.code)).forEach(popChat);
    chatSeenTs = Math.max(chatSeenTs || 0, lastTs);
  }
  function popChat(m) {
    const area = $("pop-area");
    const card = el("div", "pop-chat");
    const nm = el("b", null, m.name); nm.style.setProperty("--c", PLAYER_COLORS[m.p % PLAYER_COLORS.length]);
    card.append("💬 ", nm, el("span", null, m.text));
    card.addEventListener("click", () => { card.remove(); $("room-chat").scrollIntoView({ behavior: "smooth", block: "center" }); $("chat-input").focus(); });
    area.appendChild(card);
    while (area.children.length > 3) area.firstChild.remove();
    setTimeout(() => { card.classList.add("out"); setTimeout(() => card.remove(), 400); }, 4000);
  }

  // ---- スタンプ（チャットとは別。ログには残さず、その場で大きく表示する）
  const STAMPS = CFG.stamps || ["www", "OH！", "？？？", "わかった！"];
  function hostStamp(pIdx, k) {
    const H = vs.host; const p = H && H.players[pIdx]; if (!p) return;
    k = k | 0; if (!(k >= 0 && k < STAMPS.length)) return;
    const now = Date.now(); if (now - (p.stampAt || 0) < 1200) return;   // 連打の制限
    p.stampAt = now;
    const msg = { t: "stamp", p: pIdx, name: p.name, code: p.code || "", k };
    H.players.forEach((x) => { if (x.conn && x.connected) hostSend(x.conn, msg); });
    showStamp(msg);
  }
  function showStamp(m) {
    if (SOCIAL.isBlocked(m.code) || !STAMPS[m.k]) return;
    const area = $("stamp-area");
    const st = el("div", "stamp-pop");
    st.style.setProperty("--c", PLAYER_COLORS[m.p % PLAYER_COLORS.length]);
    st.style.left = (STAMPS[m.k].length > 6 ? 50 : 25 + Math.random() * 50) + "%";   // 長いスタンプは真ん中に（画面からはみ出さないように）
    st.appendChild(el("div", "stamp-text", STAMPS[m.k]));
    st.appendChild(el("div", "stamp-by", m.p === vs.me ? "あなた" : m.name));
    area.appendChild(st);
    while (area.children.length > 6) area.firstChild.remove();
    setTimeout(() => st.remove(), 2200);
  }
  function sendStamp(k) {
    if (!vs.pub) return;
    const now = Date.now(); if (now - (vs.stampAt || 0) < 1200) return;
    vs.stampAt = now;
    send({ t: "stamp", k }, () => hostStamp(vs.me, k));
  }
  STAMPS.forEach((t, k) => {
    const b = el("button", "stamp-btn", t); b.type = "button";
    b.addEventListener("click", () => sendStamp(k));
    $("stamp-bar").appendChild(b);
  });
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
    renderConnBanner();
    if (pub.status === "lobby") {
      if ($("screen-lobby").hidden) { stopTimer(); showScreen("lobby"); enterRoomView(); }
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
    const myLeft = pub.per ? (me && me.left) || { b: 0, f: 0, g: 0 } : pub.shared || { b: 0, f: 0, g: 0 };
    if (pub.per && meSetter) ct.appendChild(el("span", "counter", "回数は回答者1人ずつ（残りは参加者一覧に表示）"));
    else {
      if (pub.per) ct.appendChild(el("span", "counter-label", "あなたの残り"));
      [["偏見", leftText(myLeft.b, pub.opts.bMax)], ["自由質問", leftText(myLeft.f, pub.opts.fMax)], ["回答", leftText(myLeft.g, pub.opts.gMax)]]
        .forEach(([k, v]) => { const s = el("span", "counter"); s.append(k + " ", el("b", null, v)); ct.appendChild(s); });
    }
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
        const tp = el("div", "turn-topic"); tp.append("お題：", el("b", null, t ? t.name : ""));
        const ti = myTopicImg(); if (ti) { const im = el("img", "turn-thumb"); im.src = ti; im.alt = ""; tp.appendChild(im); }
        who.appendChild(tp);
      } else who.textContent = waiting ? `${setterName(pub)} が考え中…` : mine ? "あなたの番！" : `${pub.players[pub.turn].name} の番`;
      who.className = "turn-who" + (mine || (meSetter && waiting) ? " me" : "");

      // 出題者：返事／判定パネル
      const showAns = meSetter && waiting && !pub.paused;
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
      const canAct = mine && !meOut && !meSetter && !pub.paused;
      $("act-panel").hidden = !canAct;
      if (canAct) {
        const avail = { bias: myLeft.b !== 0, free: myLeft.f > 0, guess: myLeft.g > 0 };
        if (!avail[actTab]) actTab = ["bias", "free", "guess"].find((k) => avail[k]) || "guess";
        $("tab-bias-left").textContent = myLeft.b < 0 ? "" : `残り${myLeft.b}`;
        $("tab-free-left").textContent = `残り${myLeft.f}`;
        $("tab-guess-left").textContent = `残り${myLeft.g}`;
        document.querySelectorAll(".act-tab").forEach((b) => { b.disabled = !avail[b.dataset.act]; });
        const newTurn = lastStatus !== "playing:" + pub.turnNo + ":" + pub.phase;
        if (newTurn || !shownIdeas.length) pickIdeas();
        setActTab(actTab, newTurn);
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
  // ---- 偏見の候補（bias-ideas.js からランダムで3つ。一度選んだものはこの端末では出さない）
  const IDEAS = (window.BIAS_IDEAS || []).filter((s, i, a) => s && a.indexOf(s) === i);
  const USED_IDEAS_KEY = CFG.id + ".usedIdeas";
  let usedIdeas = new Set();
  try { usedIdeas = new Set(JSON.parse(localStorage.getItem(USED_IDEAS_KEY) || "[]")); } catch {}
  let shownIdeas = [];
  function ideaPool() {
    const asked = new Set((vs.pub ? vs.pub.log : []).filter((x) => x.k === "b").map((x) => textNorm(x.q)));
    const ok = (s) => !asked.has(textNorm(s)) && !shownIdeas.includes(s);
    let pool = IDEAS.filter((s) => !usedIdeas.has(s) && ok(s));
    if (pool.length < 3 && IDEAS.length) {   // 使い切ったら最初から
      usedIdeas.clear(); try { localStorage.removeItem(USED_IDEAS_KEY); } catch {}
      pool = IDEAS.filter(ok);
    }
    return pool;
  }
  function pickIdeas() {
    const pool = ideaPool();   // いま出ている候補は除いて選ぶ
    shownIdeas = [];
    while (shownIdeas.length < 3 && pool.length) shownIdeas.push(pool.splice(randInt(pool.length), 1)[0]);
    renderIdeas();
  }
  function renderIdeas() {
    const box = $("bias-ideas"); box.innerHTML = "";
    if (!IDEAS.length) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el("span", "ideas-label", "候補"));
    shownIdeas.forEach((s) => {
      const b = el("button", "idea-chip", s + "そう"); b.type = "button";
      b.addEventListener("click", () => {
        $("bias-input").value = s;
        usedIdeas.add(s); try { localStorage.setItem(USED_IDEAS_KEY, JSON.stringify([...usedIdeas])); } catch {}
        // 選んだ候補は新しいものに入れ替える
        const pool = ideaPool();
        shownIdeas = shownIdeas.map((x) => (x === s ? (pool.length ? pool[randInt(pool.length)] : null) : x)).filter(Boolean);
        renderIdeas();
        $("bias-input").focus();
      });
      box.appendChild(b);
    });
    const r = el("button", "idea-chip reroll", "🔄 ほかの候補"); r.type = "button";
    r.addEventListener("click", pickIdeas);
    box.appendChild(r);
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
      if (x.k === "t") {   // 時間切れ
        const li = el("li", "qa-item timeout");
        const head = el("div", "qa-q");
        const dot = el("span", "pdot"); dot.style.setProperty("--c", PLAYER_COLORS[x.p % PLAYER_COLORS.length]); head.appendChild(dot);
        head.appendChild(el("span", "qa-no", "時間切れ"));
        head.appendChild(el("span", "qa-by", by));
        li.appendChild(head);
        li.appendChild(el("div", "qa-a " + (x.out ? "no" : "unknown"), x.out ? "降参扱い" : (x.used ? "偏見 −1" : "パス") + (x.n ? `（連続${x.n}回）` : "")));
        ol.prepend(li);
        return;
      }
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
    const ib = el("div", "answer-img-box"); ib.id = "answer-img-box"; ib.hidden = true; card.appendChild(ib);
    if (vs.isHost && vs.host && vs.host.topicImg) vs.answerImg = vs.host.topicImg;
    renderAnswerImg();
    // このルームでの成績
    const ranked = pub.players.map((p, i) => ({ p, i })).filter((x) => x.p.connected && x.p.stats).sort((a, b) => (b.p.stats.hit - a.p.stats.hit) || (b.p.stats.esc - a.p.stats.esc));
    if (ranked.length > 1) {
      const box = el("div", "end-stats");
      box.appendChild(el("div", "muted", "このルームの成績（🎯当てた回数・🛡️出題者で逃げ切った回数）"));
      ranked.forEach((x) => box.appendChild(el("div", "row" + (x.i === vs.me ? " me" : ""), `${x.p.name}　🎯${x.p.stats.hit}　🛡️${x.p.stats.esc}`)));
      card.appendChild(box);
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
      ...pub.log.map((x) => (x.k === "t" ? `⏰ 時間切れ${x.used ? "（偏見 −1）" : ""}${x.out ? "→ 降参扱い" : ""}` : x.k === "b" ? `🗯️ ${biasText(x.q)} → ${answerLabel("b", x.a) || "-"}` : x.k === "f" ? `❓ ${x.q} → ${answerLabel("f", x.a) || "-"}` : `🎯 ${x.q} → ${(JUDGES.find((y) => y.k === x.r) || {}).label || "-"}`))].filter(Boolean).join("\n");
    $("btn-copy-result").hidden = false;
    $("btn-again").hidden = !vs.isHost || pub.randomMulti; $("btn-again-same").hidden = !vs.isHost || pub.randomMulti;
  }
  function clearEndUI() {
    $("answer-card").hidden = true; $("answer-card").innerHTML = "";
    vs.answerImg = null;
    ["btn-copy-result", "btn-again", "btn-again-same"].forEach((id) => ($(id).hidden = true));
  }

  function tick() {
    if (vs.isHost) hostTick();
    const pub = vs.pub;
    const t = $("turn-timer");
    if (pub && pub.status === "playing" && (pub.paused || vs.lost)) { t.textContent = "⏸ 停止中"; t.className = "turn-timer"; return; }
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
    if (vs.pub && vs.pub.status === "playing") armConfirm($("btn-back-home"), "ホームへ？（もう一度押す・あとで戻れます）", goHome);
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
    if (vs.pub && vs.pub.status === "playing") armConfirm($("btn-back-home"), "ホームへ？（もう一度押す・あとで戻れます）", goHome);
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
  $("topic-img-file").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    try { setTopicImg(await shrinkImage(f)); toast("画像を添付しました（正解発表のときに表示されます）"); }
    catch (err) { toast(err.message || "画像を読み込めませんでした"); }
  });
  $("btn-topic-img-clear").addEventListener("click", () => setTopicImg(null));
  $("show-images").checked = showImages;
  $("show-images").addEventListener("change", (e) => { showImages = e.target.checked; try { localStorage.setItem(SHOW_IMG_KEY, showImages ? "1" : "0"); } catch {} renderAnswerImg(); });
  ["topic-input", "hint-input"].forEach((id) => $(id).addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); setTopicFromInputs(); } }));
  $("btn-topic-change").addEventListener("click", () => {
    const t = myTopic(); if (t) { $("topic-input").value = t.name; $("hint-input").value = t.hint; }
    pickTopic(null);
  });
  const readOpts = () => ({ bMax: $("room-bias").value, fMax: $("room-free").value, gMax: $("room-guess").value, turnSec: $("room-turn-seconds").value, per: $("room-per").value });
  ["room-bias", "room-free", "room-guess", "room-turn-seconds", "room-per"].forEach((id) => $(id).addEventListener("change", () => { if (vs.isHost) hostSetOptions(readOpts()); }));
  $("chat-send").addEventListener("click", sendChat);
  $("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendChat(); } });
  $("setter-select").addEventListener("change", () => { if (vs.isHost) hostSetSetter(+$("setter-select").value); });
  window.addEventListener("beforeunload", () => { if (vs.isHost) saveHostSnap(); try { vs.peer && vs.peer.destroy(); } catch {} });

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
  $("btn-resume-discard").addEventListener("click", () => { clearResume(); renderResumeCard(); });
  renderResumeCard();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && vs.lost && !vs.rejoining) rejoin(); });
  const roomParam = new URLSearchParams(location.search).get("room");
  if (roomParam && /^\d{6}$/.test(roomParam)) openLobby(roomParam);
};
