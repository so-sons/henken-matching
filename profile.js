/* プロフィール（アイコン・自己紹介・よく参加しているジャンル3つ）
   この端末に保存し、ルームの参加者やフレンドには通信で渡す（サーバーには保存しない）。
   遊んだルームのジャンルを数えておき、ジャンル欄の候補に出す */
window.PROFILE = (() => {
  "use strict";
  const CFG = window.GAME_CONFIG;
  const $ = (id) => document.getElementById(id);
  const ng = window.ngFilter || ((t) => t);
  const KEY = CFG.id + ".profile", HIST = CFG.id + ".genreHistory";
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const validIcon = (d) => typeof d === "string" && d.length < 40000 && /^data:image\/(jpeg|png|webp);base64,/.test(d);
  const cleanGenre = (g) => ng(String(g || "").replace(/\s+/g, " ").trim().slice(0, 20));
  // 受け取ったプロフィールもこれで整える（長さ・NGワード・画像の形式）
  function clean(p) {
    p = p && typeof p === "object" ? p : {};
    const genres = (Array.isArray(p.genres) ? p.genres : []).map(cleanGenre).filter(Boolean).filter((g, i, a) => a.indexOf(g) === i).slice(0, 3);
    return { bio: ng(String(p.bio || "").replace(/\s+/g, " ").trim().slice(0, 100)), icon: validIcon(p.icon) ? p.icon : "", genres };
  }
  let prof = { bio: "", icon: "", genres: [] };
  try { prof = clean(JSON.parse(localStorage.getItem(KEY) || "null")); } catch {}
  const listeners = [];
  function set(p) {
    prof = clean(p);
    try { localStorage.setItem(KEY, JSON.stringify(prof)); } catch {}
    listeners.forEach((f) => { try { f(prof); } catch (e) { console.warn(e); } });
  }
  const isEmpty = (p) => !p || (!p.bio && !p.icon && !(p.genres && p.genres.length));

  // ---- 遊んだルームのジャンル
  function history() { try { return JSON.parse(localStorage.getItem(HIST) || "{}") || {}; } catch { return {}; } }
  function addHistory(genre) {
    genre = cleanGenre(genre); if (!genre) return;
    const h = history(); h[genre] = (h[genre] || 0) + 1;
    try { localStorage.setItem(HIST, JSON.stringify(h)); } catch {}
  }
  const topHistory = (n) => Object.entries(history()).sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0]);

  // ---- アイコン画像：真ん中を正方形に切り抜いて 96px に縮める
  async function shrinkIcon(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error("画像ファイルを選んでください");
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("画像を読み込めませんでした")); i.src = url; });
      const S = 96, side = Math.min(img.width, img.height);
      const c = document.createElement("canvas"); c.width = S; c.height = S;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, S, S);
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      return c.toDataURL("image/jpeg", 0.8);
    } finally { URL.revokeObjectURL(url); }
  }

  // ---- アイコン（画像がなければ名前の1文字目）
  function avatar(profile, name, size) {
    const a = el("span", "avatar"); a.style.setProperty("--s", (size || 24) + "px");
    if (profile && profile.icon) { const im = el("img"); im.src = profile.icon; im.alt = ""; a.appendChild(im); }
    else a.textContent = ([...String(name || "？")][0] || "？");
    return a;
  }

  // ---- 他の人のプロフィールを見る
  function showCard(o) {
    const p = clean(o.profile);
    const box = $("profile-card"); box.innerHTML = "";
    const head = el("div", "pc-head");
    head.appendChild(avatar(p, o.name, 72));
    const nm = el("div", "pc-name"); nm.appendChild(el("b", null, ng(o.name || "プレイヤー"))); if (o.sub) nm.appendChild(el("div", "muted", o.sub)); head.appendChild(nm);
    box.appendChild(head);
    box.appendChild(el("p", "pc-bio" + (p.bio ? "" : " muted"), p.bio || "自己紹介はまだありません"));
    if (p.genres.length) {
      const g = el("div", "pc-genres"); g.appendChild(el("span", "muted small-label", "よく参加しているジャンル"));
      p.genres.forEach((x) => g.appendChild(el("span", "genre-chip", x)));
      box.appendChild(g);
    }
    if (o.actions) { const a = el("div", "pc-actions"); a.appendChild(o.actions); box.appendChild(a); }
    $("profile-modal").hidden = false;
  }
  function hideCard() { $("profile-modal").hidden = true; }
  $("profile-close").addEventListener("click", hideCard);
  $("profile-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) hideCard(); });

  // ---- 自分のプロフィールの編集（フレンド画面の「あなた」の欄）
  let draftIcon = prof.icon;
  function renderEditor() {
    const av = $("pe-avatar"); av.innerHTML = ""; av.appendChild(avatar({ icon: draftIcon }, $("social-name").value || "？", 64));
    $("pe-icon-clear").hidden = !draftIcon;
    $("pe-bio").value = prof.bio;
    [0, 1, 2].forEach((i) => { $("pe-genre-" + i).value = prof.genres[i] || ""; });
    // ジャンルの候補：よく遊んだジャンル
    const dl = $("pe-genre-list"); dl.innerHTML = "";
    topHistory(12).forEach((g) => { const o = el("option"); o.value = g; dl.appendChild(o); });
    const top = topHistory(3);
    $("pe-genre-hint").textContent = top.length ? `よく遊んでいるジャンル：${top.join("・")}` : "ルームのジャンルで遊ぶと、ここに候補が出ます";
    $("pe-bio-count").textContent = `${$("pe-bio").value.length}/100`;
  }
  $("pe-icon-file").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    try { draftIcon = await shrinkIcon(f); renderEditor(); $("pe-save").classList.add("attn"); } catch (err) { alert(err.message); }
  });
  $("pe-icon-clear").addEventListener("click", () => { draftIcon = ""; renderEditor(); $("pe-save").classList.add("attn"); });
  $("pe-bio").addEventListener("input", () => { $("pe-bio-count").textContent = `${$("pe-bio").value.length}/100`; $("pe-save").classList.add("attn"); });
  [0, 1, 2].forEach((i) => $("pe-genre-" + i).addEventListener("input", () => $("pe-save").classList.add("attn")));
  $("pe-fill-history").addEventListener("click", () => { topHistory(3).forEach((g, i) => { $("pe-genre-" + i).value = g; }); $("pe-save").classList.add("attn"); });
  $("pe-save").addEventListener("click", () => {
    set({ bio: $("pe-bio").value, icon: draftIcon, genres: [0, 1, 2].map((i) => $("pe-genre-" + i).value) });
    $("pe-save").classList.remove("attn");
    $("pe-saved").hidden = false; setTimeout(() => { $("pe-saved").hidden = true; }, 1600);
    renderEditor();
  });

  return {
    get: () => ({ ...prof, genres: prof.genres.slice() }),
    set, clean, isEmpty, onChange: (f) => listeners.push(f),
    addHistory, topHistory, avatar, showCard, hideCard,
    openEditor: () => { draftIcon = prof.icon; renderEditor(); },
  };
})();
