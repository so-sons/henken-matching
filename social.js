/* フレンド機能・個人チャット・ブロック（サーバーなし）
   - 端末ごとに署名用の鍵（ECDSA P-256）を作り、その公開鍵のハッシュを「フレンドコード」にする
   - サイトを開いている間は PeerJS の ID「<ゲームID>-u-<フレンドコード>」で待ち受ける
   - つながったら互いに相手の乱数に署名して、コードの持ち主本人か確かめる（なりすまし防止）
   - フレンド一覧・ブロック・会話履歴はこの端末の localStorage にだけ保存する
   - メッセージは相手もサイトを開いているときだけ届く（預かっておく仕組みはない）
   app.js の GAME_START から SOCIAL_START(app) で起動し、ルームとの連携用の関数を返す */
window.SOCIAL_START = (app) => {
  "use strict";

  const CFG = window.GAME_CONFIG;
  const $ = (id) => document.getElementById(id);
  const { el, toast } = app;
  const PRESENCE = (code) => CFG.id + "-u-" + code;
  const LS = CFG.id + ".social.";
  const ls = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(LS + k)); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch {} },
  };
  const te = new TextEncoder();
  const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 紛らわしい I O 0 1 を除いた32文字
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(String(s || "")), (c) => c.charCodeAt(0));
  const fmtCode = (c) => (c ? c.slice(0, 5) + "-" + c.slice(5) : "");
  const normCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z2-9]/g, "");
  const cleanName = (n) => String(n || "").replace(/\s+/g, " ").trim().slice(0, 12) || "プレイヤー";
  const EC = { name: "ECDSA", namedCurve: "P-256" };
  const SIG = { name: "ECDSA", hash: "SHA-256" };
  async function codeOf(rawPub) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", rawPub));
    let s = ""; for (let i = 0; i < 10; i++) s += B32[h[i] & 31];
    return s;
  }
  const authBytes = (nonce) => te.encode("henken-auth:" + nonce);

  // ---------------------------------------------------------------- 保存データ
  let friends = ls.get("friends", []);     // [{code, name}]
  let blocked = ls.get("blocked", []);     // [{code, name}]
  let requests = ls.get("requests", []);   // 受け取った申請 [{code, name, ts}]
  let outgoing = ls.get("outgoing", []);   // 送った申請 [code]（相手が後で承認したときに受け取れるように）
  let unread = ls.get("unread", {});       // code -> 未読数
  const settings = { acceptRequests: true, acceptChat: true, ...ls.get("settings", {}) };
  const save = () => { ls.set("friends", friends); ls.set("blocked", blocked); ls.set("requests", requests); ls.set("outgoing", outgoing); ls.set("unread", unread); ls.set("settings", settings); };
  const isFriend = (c) => friends.some((f) => f.code === c);
  const isBlocked = (c) => blocked.some((b) => b.code === c);
  const friendName = (c) => (friends.find((f) => f.code === c) || {}).name || "プレイヤー";
  const dmLoad = (c) => ls.get("dm." + c, []);
  const dmPush = (c, m) => { const a = dmLoad(c); a.push(m); while (a.length > 200) a.shift(); ls.set("dm." + c, a); };

  // ---------------------------------------------------------------- 本人の鍵
  let me = null;   // { code, pub(b64 raw), priv(CryptoKey) }
  async function loadIdentity() {
    let id = ls.get("identity", null);
    if (!id) {
      const kp = await crypto.subtle.generateKey(EC, true, ["sign", "verify"]);
      id = { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64(await crypto.subtle.exportKey("raw", kp.publicKey)) };
      ls.set("identity", id);
    }
    const priv = await crypto.subtle.importKey("jwk", id.priv, EC, false, ["sign"]);
    return { priv, pub: id.pub, code: await codeOf(unb64(id.pub)) };
  }
  const sign = async (bytes) => b64(await crypto.subtle.sign(SIG, me.priv, bytes));
  async function verify(pubB64, sigB64, bytes) {
    try { const k = await crypto.subtle.importKey("raw", unb64(pubB64), EC, false, ["verify"]); return await crypto.subtle.verify(SIG, k, unb64(sigB64), bytes); }
    catch { return false; }
  }

  // ---------------------------------------------------------------- 通信
  let peer = null;
  let status = "starting";   // starting | online | offline | other-tab | unsupported
  let retryTimer = null;
  const sessions = new Map();   // code -> 認証済みのつながり
  const dialing = new Map();    // code -> [{ok, fail}]（接続待ちのコールバック）
  const isOnline = (c) => { const s = sessions.get(c); return !!(s && s.conn.open); };

  function scheduleRestart(ms) { clearTimeout(retryTimer); retryTimer = setTimeout(startPeer, ms); }
  function startPeer() {
    if (typeof window.Peer !== "function") { status = "offline"; render(); scheduleRestart(30000); return; }
    try { peer && peer.destroy(); } catch {}
    const p = new Peer(PRESENCE(me.code), { debug: 0 });
    peer = p;
    p.on("open", () => { status = "online"; render(); friends.forEach((f) => dial(f.code)); });
    p.on("connection", (conn) => setupConn(conn, null));
    p.on("disconnected", () => {
      if (p.destroyed || peer !== p) return;
      status = "offline"; render();
      setTimeout(() => { if (peer === p && !p.destroyed) { try { p.reconnect(); } catch { scheduleRestart(5000); } } }, 2000);
    });
    p.on("error", (e) => {
      if (peer !== p) return;
      if (e.type === "peer-unavailable") {   // 相手がオフライン
        const m = String(e.message || "").match(/-u-([A-Z2-9]{10})/);
        if (m) dialDone(m[1], null);
        return;
      }
      if (e.type === "unavailable-id") { status = "other-tab"; render(); try { p.destroy(); } catch {} scheduleRestart(20000); return; }
      if (p.destroyed || ["network", "server-error", "socket-error", "socket-closed"].includes(e.type)) { status = "offline"; render(); if (p.destroyed) scheduleRestart(15000); }
    });
  }
  // スマホで画面を戻したときなどに、切れていたらつなぎ直す
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !me || status === "unsupported") return;
    if (!peer || peer.destroyed) scheduleRestart(500);
    else if (peer.disconnected) { try { peer.reconnect(); } catch {} }
  });
  // オフラインのフレンドがあとから来たとき用に、ときどき接続を試す
  setInterval(() => { if (status === "online") friends.forEach((f) => { if (!isOnline(f.code)) dial(f.code); }); }, 45000);

  function dial(code, opts) {
    opts = opts || {};
    if (isOnline(code)) { if (opts.ok) opts.ok(sessions.get(code)); return; }
    if (!peer || status !== "online") { if (opts.fail) opts.fail(); return; }
    if (dialing.has(code)) { dialing.get(code).push(opts); return; }
    dialing.set(code, [opts]);
    setupConn(peer.connect(PRESENCE(code), { reliable: true }), code);
  }
  function dialDone(code, st) {
    const w = dialing.get(code); if (!w) return;
    dialing.delete(code);
    w.forEach((o) => (st ? o.ok && o.ok(st) : o.fail && o.fail()));
  }

  // expected: 自分から接続したときの相手のコード（受けた接続は null）
  function setupConn(conn, expected) {
    const st = { conn, outgoing: !!expected, nonce: b64(crypto.getRandomValues(new Uint8Array(16))), code: null, pub: null, name: "", authed: false, q: Promise.resolve(), recent: [] };
    const timer = setTimeout(() => { if (!st.authed) { try { conn.close(); } catch {} if (expected) dialDone(expected, null); } }, 12000);
    st.timer = timer;
    conn.on("open", () => { conn.send({ t: "hi", v: 1, code: me.code, name: app.getName(), pub: me.pub, nonce: st.nonce }); });
    // 受信は順番に処理する（署名の確認が非同期なので、順番が入れ替わらないように）
    conn.on("data", (m) => { st.q = st.q.then(() => onData(st, m, expected)).catch((e) => console.warn(e)); });
    conn.on("close", () => {
      clearTimeout(timer);
      if (!st.authed && expected) dialDone(expected, null);
      if (st.code && sessions.get(st.code) === st) { sessions.delete(st.code); render(); }
    });
    conn.on("error", () => { try { conn.close(); } catch {} });
  }
  // 同じ相手と2本つながったとき、どちらを残すか（両側で同じ結論になるように、コードが小さい側から張ったほう）
  const preferred = (s) => (s.outgoing ? me.code : s.code) === [me.code, s.code].sort()[0];

  async function onData(st, m, expected) {
    if (!m || typeof m !== "object") return;
    if (m.t === "hi") {
      if (st.code) return;
      const code = String(m.code || ""), pub = String(m.pub || "");
      const bad = !/^[A-Z2-9]{10}$/.test(code) || (expected && code !== expected) || code === me.code || isBlocked(code);
      if (bad || (await codeOf(unb64(pub)).catch(() => "")) !== code) { st.conn.close(); return; }
      st.code = code; st.pub = pub; st.name = cleanName(m.name);
      st.conn.send({ t: "proof", sig: await sign(authBytes(String(m.nonce || ""))) });
      return;
    }
    if (m.t === "proof") {
      if (!st.code || st.authed) return;
      if (!(await verify(st.pub, m.sig, authBytes(st.nonce)))) { st.conn.close(); return; }
      st.authed = true; clearTimeout(st.timer);
      const old = sessions.get(st.code);
      if (old && old !== st && old.conn.open) {
        if (preferred(old) && !preferred(st)) { try { st.conn.close(); } catch {} dialDone(st.code, old); return; }
        try { old.conn.close(); } catch {}
      }
      sessions.set(st.code, st);
      const f = friends.find((x) => x.code === st.code);
      if (f && f.name !== st.name) { f.name = st.name; save(); }
      if (f) st.conn.send({ t: "fsync" });   // フレンド関係の食い違い（オフライン中の承認・解除）を直す
      dialDone(st.code, st);
      render();
      return;
    }
    if (st.authed) handle(st, m);
  }

  function handle(st, m) {
    const code = st.code;
    // 連投の制限（10秒に20件まで）
    const now = Date.now(); st.recent = st.recent.filter((t) => now - t < 10000); st.recent.push(now);
    if (st.recent.length > 20) return;
    switch (m.t) {
      case "freq":   // フレンド申請
        if (isFriend(code)) { st.conn.send({ t: "fok", name: app.getName() }); return; }
        if (outgoing.includes(code)) { addFriend(code, st.name); st.conn.send({ t: "fok", name: app.getName() }); toast(`${st.name} とフレンドになりました`); return; }
        if (!settings.acceptRequests) { st.conn.send({ t: "fno", why: "off" }); return; }
        if (!requests.some((r) => r.code === code)) { requests.push({ code, name: st.name, ts: now }); save(); }
        toast(`${st.name} からフレンド申請が届きました`);
        render();
        return;
      case "fok":    // 申請が承認された
        if (!outgoing.includes(code) && !isFriend(code)) return;
        addFriend(code, st.name);
        toast(`${st.name} とフレンドになりました`);
        return;
      case "fno":
        outgoing = outgoing.filter((c) => c !== code); save(); render();
        toast(m.why === "off" ? `${st.name} はフレンド申請を受け付けていません` : `${st.name} に申請を断られました`);
        return;
      case "fsync":
        if (isFriend(code)) return;
        if (outgoing.includes(code)) { addFriend(code, st.name); toast(`${st.name} とフレンドになりました`); }
        else st.conn.send({ t: "unfriend" });
        return;
      case "unfriend":
        if (isFriend(code)) removeFriend(code, true);
        return;
      case "msg": {
        if (!isFriend(code)) return;
        if (!settings.acceptChat) { st.conn.send({ t: "msgoff" }); return; }
        const text = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
        if (text) receive(code, { me: false, text, ts: now });
        return;
      }
      case "invite": {
        if (!isFriend(code)) return;
        const room = String(m.room || "");
        if (/^\d{6}$/.test(room)) receive(code, { me: false, kind: "invite", room, ts: now });
        return;
      }
      case "msgoff":
        toast(`${st.name} はチャットを受け取らない設定です`);
        return;
      case "hi-name": {   // 相手がニックネームを変えた
        st.name = cleanName(m.name);
        const f = friends.find((x) => x.code === code);
        if (f && f.name !== st.name) { f.name = st.name; save(); render(); }
        return;
      }
    }
  }

  // ---------------------------------------------------------------- 操作
  function addFriend(code, name) {
    outgoing = outgoing.filter((c) => c !== code);
    requests = requests.filter((r) => r.code !== code);
    if (!isFriend(code)) friends.push({ code, name: cleanName(name) });
    save(); render();
  }
  function removeFriend(code, fromRemote) {
    const s = sessions.get(code);
    if (!fromRemote && s && s.conn.open) s.conn.send({ t: "unfriend" });
    friends = friends.filter((f) => f.code !== code);
    delete unread[code];
    save();
    if (chatWith === code) closeChat();
    render();
  }
  function request(code, nameHint) {
    code = normCode(code);
    if (!me) { toast("準備中です。少し待ってください"); return; }
    if (code.length !== 10) { toast("フレンドコードは10文字です"); return; }
    if (code === me.code) { toast("自分のコードです"); return; }
    if (isBlocked(code)) { toast("ブロック中の相手です（ブロックを解除してから申請してください）"); return; }
    if (isFriend(code)) { toast("すでにフレンドです"); return; }
    const req = requests.find((r) => r.code === code);
    if (req) { accept(code); return; }   // 相手からも申請が来ていた
    if (!outgoing.includes(code)) { outgoing.push(code); save(); }
    toast("申請を送っています…");
    dial(code, {
      ok: (s) => { s.conn.send({ t: "freq", name: app.getName() }); toast(`${nameHint || s.name} にフレンド申請を送りました`); render(); },
      fail: () => toast("相手が見つかりません。相手もサイトを開いているときに申請してください"),
    });
    render();
  }
  function accept(code) {
    const r = requests.find((x) => x.code === code); if (!r) return;
    addFriend(code, r.name);
    toast(`${r.name} とフレンドになりました`);
    // 相手がオフラインでも、次につながったとき fsync で反映される
    dial(code, { ok: (s) => s.conn.send({ t: "fok", name: app.getName() }) });
  }
  function decline(code) {
    requests = requests.filter((r) => r.code !== code); save(); render();
    const s = sessions.get(code); if (s && s.conn.open) s.conn.send({ t: "fno" });
  }
  function block(code, name) {
    code = normCode(code); if (!code || code === (me && me.code)) return;
    const nm = cleanName(name || friendName(code));
    if (isFriend(code)) removeFriend(code, false);
    requests = requests.filter((r) => r.code !== code);
    outgoing = outgoing.filter((c) => c !== code);
    if (!isBlocked(code)) blocked.push({ code, name: nm });
    const s = sessions.get(code); if (s) { try { s.conn.close(); } catch {} sessions.delete(code); }
    save(); render();
    toast(`${nm} をブロックしました`);
    app.onBlock(code);
  }
  function unblock(code) { blocked = blocked.filter((b) => b.code !== code); save(); render(); }
  function receive(code, msg) {
    dmPush(code, msg);
    if (chatWith === code && !$("friends-modal").hidden) renderChat();
    else {
      unread[code] = (unread[code] || 0) + 1; save();
      toast(msg.kind === "invite" ? `📨 ${friendName(code)} からルームに招待されました` : `💬 ${friendName(code)}：${msg.text.slice(0, 30)}`);
    }
    render();
  }
  function sendDM() {
    const code = chatWith; if (!code) return;
    const input = $("dm-input");
    const text = input.value.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text) return;
    const s = sessions.get(code);
    if (!s || !s.conn.open) { toast("相手はオフラインです（相手もサイトを開いているときだけ届きます）"); return; }
    s.conn.send({ t: "msg", text });
    input.value = "";
    dmPush(code, { me: true, text, ts: Date.now() });
    renderChat();
  }
  function sendInvite(code) {
    const room = app.roomCode();
    if (!room) { toast("ルームに入ってから招待できます"); return; }
    const s = sessions.get(code);
    if (!s || !s.conn.open) { toast("相手はオフラインです"); return; }
    s.conn.send({ t: "invite", room });
    dmPush(code, { me: true, kind: "invite", room, ts: Date.now() });
    toast(`${friendName(code)} をルームに招待しました`);
    if (chatWith === code) renderChat();
  }

  // ---------------------------------------------------------------- 画面
  let chatWith = null;
  const openModal = () => { $("friends-modal").hidden = false; $("social-name").value = app.getName(); render(); };
  const closeModal = () => { $("friends-modal").hidden = true; chatWith = null; };
  function openChat(code) {
    chatWith = code;
    delete unread[code]; save();
    $("friends-main").hidden = true; $("dm-view").hidden = false;
    renderChat(); render();
    $("dm-input").focus();
  }
  function closeChat() { chatWith = null; $("friends-main").hidden = false; $("dm-view").hidden = true; render(); }
  const STATUS_TEXT = {
    starting: "準備中…", online: "オンライン（フレンドから見えています）", offline: "接続できていません。再接続を試しています…",
    "other-tab": "別のタブでこのサイトが開いています。フレンド機能はそちらのタブで使えます",
    unsupported: "このブラウザではフレンド機能を使えません",
  };
  function smallBtn(label, cls, fn) { const b = el("button", "btn small " + (cls || ""), label); b.type = "button"; b.addEventListener("click", fn); return b; }
  function confirmBtn(label, confirmLabel, cls, fn) {
    const b = smallBtn(label, cls, () => {
      if (b.dataset.armed) { fn(); return; }
      b.dataset.armed = "1"; b.textContent = confirmLabel;
      setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 3000);
    });
    return b;
  }

  function render() {
    // バッジ（申請＋未読）
    const n = requests.length + Object.values(unread).reduce((a, b) => a + b, 0);
    const badge = $("friends-badge"); badge.hidden = !n; badge.textContent = n > 99 ? "99+" : String(n);
    $("friends-online-dot").hidden = !friends.some((f) => isOnline(f.code));
    if (app.onChange) app.onChange();
    if ($("friends-modal").hidden) return;
    $("social-code").textContent = me ? fmtCode(me.code) : "……";
    $("social-status").textContent = STATUS_TEXT[status] || "";
    $("social-status").className = "social-status " + status;
    $("set-accept-requests").checked = settings.acceptRequests;
    $("set-accept-chat").checked = settings.acceptChat;
    // 申請
    const rq = $("req-list"); rq.innerHTML = "";
    $("req-section").hidden = !requests.length;
    requests.forEach((r) => {
      const li = el("li", "f-item");
      li.appendChild(el("span", "f-name", r.name)); li.appendChild(el("span", "f-code", fmtCode(r.code)));
      const act = el("span", "f-act");
      act.append(smallBtn("承認", "primary", () => accept(r.code)), smallBtn("拒否", "", () => decline(r.code)), confirmBtn("ブロック", "本当に？", "danger", () => block(r.code, r.name)));
      li.appendChild(act); rq.appendChild(li);
    });
    // フレンド（オンラインを上に）
    const fl = $("friend-list"); fl.innerHTML = "";
    const sorted = friends.slice().sort((a, b) => isOnline(b.code) - isOnline(a.code) || (unread[b.code] || 0) - (unread[a.code] || 0));
    sorted.forEach((f) => {
      const on = isOnline(f.code);
      const li = el("li", "f-item" + (on ? " on" : ""));
      const dot = el("span", "f-dot" + (on ? " on" : "")); dot.title = on ? "オンライン" : "オフライン"; li.appendChild(dot);
      const nm = el("span", "f-name", f.name); li.appendChild(nm);
      if (unread[f.code]) li.appendChild(el("span", "f-unread", String(unread[f.code])));
      const act = el("span", "f-act");
      act.appendChild(smallBtn("💬 チャット", "", () => openChat(f.code)));
      if (on && app.roomCode()) act.appendChild(smallBtn("招待", "primary", () => sendInvite(f.code)));
      li.appendChild(act); fl.appendChild(li);
    });
    $("friend-empty").hidden = friends.length > 0;
    $("friend-count").textContent = `（${friends.filter((f) => isOnline(f.code)).length}人オンライン / ${friends.length}人）`;
    // 申請中
    $("outgoing-note").hidden = !outgoing.length;
    $("outgoing-note").textContent = outgoing.length ? `申請中：${outgoing.length}件（相手が承認すると追加されます）` : "";
    // ブロック
    const bl = $("block-list"); bl.innerHTML = "";
    $("block-section").hidden = !blocked.length;
    blocked.forEach((b) => {
      const li = el("li", "f-item");
      li.appendChild(el("span", "f-name", b.name)); li.appendChild(el("span", "f-code", fmtCode(b.code)));
      const act = el("span", "f-act"); act.appendChild(smallBtn("解除", "", () => unblock(b.code)));
      li.appendChild(act); bl.appendChild(li);
    });
    if (chatWith) renderChatHead();
  }
  function renderChatHead() {
    const on = isOnline(chatWith);
    $("dm-name").textContent = friendName(chatWith);
    $("dm-state").textContent = on ? "オンライン" : "オフライン（メッセージは届きません）";
    $("dm-state").className = "dm-state" + (on ? " on" : "");
    $("dm-send").disabled = !on; $("dm-input").disabled = !on;
    $("dm-invite").hidden = !(on && app.roomCode());
  }
  function renderChat() {
    if (!chatWith) return;
    renderChatHead();
    const ol = $("dm-list"); ol.innerHTML = "";
    const msgs = dmLoad(chatWith);
    msgs.forEach((m) => {
      const li = el("li", "dm-msg" + (m.me ? " me" : ""));
      if (m.kind === "invite") {
        li.classList.add("invite");
        li.appendChild(el("div", "dm-text", m.me ? `ルーム ${m.room} に招待しました` : `ルーム ${m.room} に招待されました`));
        if (!m.me) li.appendChild(smallBtn("参加する", "primary", () => { closeModal(); app.joinByCode(m.room); }));
      } else li.appendChild(el("div", "dm-text", m.text));
      const d = new Date(m.ts); li.appendChild(el("div", "dm-time", `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`));
      ol.appendChild(li);
    });
    $("dm-empty").hidden = msgs.length > 0;
    ol.scrollTop = ol.scrollHeight;
  }

  // ---------------------------------------------------------------- イベント
  $("btn-friends").addEventListener("click", openModal);
  $("friends-close").addEventListener("click", closeModal);
  $("friends-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });
  $("btn-copy-my-code").addEventListener("click", () => me && app.copyText(fmtCode(me.code)));
  $("btn-add-friend").addEventListener("click", () => { request($("add-code").value); $("add-code").value = ""; });
  $("add-code").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); $("btn-add-friend").click(); } });
  $("social-name").addEventListener("change", () => {
    const n = app.setName($("social-name").value);
    $("social-name").value = n;
    sessions.forEach((s) => { if (s.conn.open) s.conn.send({ t: "hi-name", name: n }); });
  });
  $("set-accept-requests").addEventListener("change", (e) => { settings.acceptRequests = e.target.checked; save(); });
  $("set-accept-chat").addEventListener("change", (e) => { settings.acceptChat = e.target.checked; save(); });
  $("dm-back").addEventListener("click", closeChat);
  $("dm-send").addEventListener("click", sendDM);
  $("dm-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendDM(); } });
  $("dm-invite").addEventListener("click", () => chatWith && sendInvite(chatWith));
  $("dm-block").addEventListener("click", function () {
    if (!chatWith) return;
    if (this.dataset.armed) { delete this.dataset.armed; this.textContent = "ブロック"; const c = chatWith; closeChat(); block(c); return; }
    this.dataset.armed = "1"; this.textContent = "本当にブロック？";
    setTimeout(() => { delete this.dataset.armed; this.textContent = "ブロック"; }, 3000);
  });
  $("dm-remove").addEventListener("click", function () {
    if (!chatWith) return;
    if (this.dataset.armed) { delete this.dataset.armed; this.textContent = "フレンド解除"; const c = chatWith; closeChat(); removeFriend(c, false); return; }
    this.dataset.armed = "1"; this.textContent = "本当に解除？";
    setTimeout(() => { delete this.dataset.armed; this.textContent = "フレンド解除"; }, 3000);
  });

  // ---------------------------------------------------------------- 起動
  render();
  if (!window.isSecureContext || !window.crypto || !crypto.subtle) { status = "unsupported"; render(); }
  else loadIdentity().then((id) => { me = id; startPeer(); render(); }).catch((e) => { console.warn(e); status = "unsupported"; render(); });

  return {
    myCode: () => (me ? me.code : ""),
    isFriend, isBlocked, request, block,
    hasPendingRequestTo: (c) => outgoing.includes(c),
    refresh: render,
  };
};
