/* サイト内SNS「みんなの試合」：試合のハイライトの投稿・一覧・いいね・通報・削除
   データは Firebase（cloud.js の window.CLOUD）。app.js から FEED.compose(試合のまとめ) で投稿画面を開く */
window.FEED = (() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const ng = window.ngFilter || ((t) => t);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let toast = (m) => alert(m);
  const cloud = () => window.CLOUD || null;
  const whenCloud = () => new Promise((res, rej) => {
    if (window.CLOUD) return res(window.CLOUD);
    const t = setTimeout(() => rej(new Error("つながりませんでした")), 15000);
    window.addEventListener("cloud-ready", () => { clearTimeout(t); res(window.CLOUD); }, { once: true });
    window.addEventListener("cloud-failed", () => { clearTimeout(t); rej(new Error("つながりませんでした")); }, { once: true });
  });

  const KIND = { b: "🗯️", f: "❓", g: "🎯", t: "⏰" };
  const ago = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "たった今"; if (s < 3600) return `${Math.floor(s / 60)}分前`; if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
    const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  // 投稿のログ（1行＝「種類\t誰\t内容\t結果」）
  const parseLog = (s) => String(s || "").split("\n").filter(Boolean).map((l) => { const [k, by, q, a] = l.split("\t"); return { k, by, q, a }; });

  // ---------------------------------------------------------------- 一覧
  let sort = "new", cursor = null, liked = new Set(), loading = false;
  async function load(reset) {
    if (loading) return;
    loading = true;
    const list = $("feed-list");
    if (reset) { list.innerHTML = ""; cursor = null; }
    $("feed-status").textContent = "読み込み中…"; $("feed-more").hidden = true;
    try {
      const C = await whenCloud();
      const r = await C.listPosts(sort, cursor);
      cursor = r.cursor;
      const ls = await C.likedSet(r.posts.map((p) => p.id)).catch(() => new Set());
      ls.forEach((id) => liked.add(id));
      r.posts.forEach((p) => list.appendChild(renderPost(p)));
      $("feed-status").textContent = list.children.length ? "" : "まだ投稿がありません。試合が終わったら「この試合を投稿」から投稿できます！";
      $("feed-more").hidden = !r.more;
    } catch (e) {
      console.warn(e);
      $("feed-status").textContent = "読み込めませんでした。通信状況を確認して、もう一度お試しください。";
    } finally { loading = false; }
  }
  function renderPost(p) {
    const card = el("article", "post");
    const head = el("header", "post-head");
    head.appendChild(window.PROFILE ? PROFILE.avatar({ icon: p.icon }, p.name, 34) : el("span"));
    const who = el("div", "post-who"); who.appendChild(el("b", null, ng(p.name))); who.appendChild(el("span", "muted", ago(p.createdAt))); head.appendChild(who);
    if (p.genre) head.appendChild(el("span", "genre-chip", ng(p.genre)));
    card.appendChild(head);
    const topic = el("div", "post-topic");
    topic.append(el("span", "muted", "お題 "), el("b", null, ng(p.topic)));
    if (p.hint) topic.appendChild(el("span", "muted", `（${ng(p.hint)}）`));
    card.appendChild(topic);
    if (p.verdict) card.appendChild(el("div", "post-verdict", ng(p.verdict)));
    if (p.comment) card.appendChild(el("p", "post-comment", ng(p.comment)));
    const lines = parseLog(p.log);
    if (lines.length) {
      const ol = el("ol", "post-log");
      lines.forEach((x, i) => {
        const li = el("li", "pl-" + x.k + (i >= 4 ? " more" : ""));
        li.append(el("span", "pl-k", KIND[x.k] || "・"), el("span", "pl-by", ng(x.by || "")), el("span", "pl-q", ng(x.q || "")));
        if (x.a) li.appendChild(el("span", "pl-a", ng(x.a)));
        ol.appendChild(li);
      });
      card.appendChild(ol);
      if (lines.length > 4) {
        const b = el("button", "link-btn", `ほかの ${lines.length - 4} 件も見る`); b.type = "button";
        b.addEventListener("click", () => { ol.classList.add("open"); b.remove(); });
        card.appendChild(b);
      }
    }
    const foot = el("footer", "post-foot");
    const like = el("button", "like-btn" + (liked.has(p.id) ? " on" : "")); like.type = "button";
    let count = p.likeCount || 0;
    const paint = () => { like.textContent = (liked.has(p.id) ? "♥ " : "♡ ") + "いいね！ " + count; like.classList.toggle("on", liked.has(p.id)); };
    paint();
    like.addEventListener("click", async () => {
      const on = !liked.has(p.id);
      like.disabled = true;
      try { await cloud().setLike(p.id, on); if (on) liked.add(p.id); else liked.delete(p.id); count += on ? 1 : -1; paint(); }
      catch (e) { console.warn(e); toast("いいねできませんでした"); }
      finally { like.disabled = false; }
    });
    foot.appendChild(like);
    const mine = cloud() && cloud().myUid() && cloud().myUid() === p.uid;
    if (mine) {
      const del = el("button", "btn small", "削除"); del.type = "button";
      del.addEventListener("click", async () => {
        if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "本当に削除？"; setTimeout(() => { delete del.dataset.armed; del.textContent = "削除"; }, 3000); return; }
        try { await cloud().deletePost(p.id); card.remove(); toast("削除しました"); } catch (e) { console.warn(e); toast("削除できませんでした"); }
      });
      foot.appendChild(del);
    } else {
      const rep = el("button", "link-btn muted-link", "通報"); rep.type = "button";
      rep.addEventListener("click", async () => {
        const reason = prompt("通報の理由を教えてください（例：暴言、個人情報、不適切な内容）");
        if (reason == null) return;
        try { await cloud().report(p.id, reason); toast("通報しました。ご協力ありがとうございます"); } catch (e) { console.warn(e); toast("通報できませんでした"); }
      });
      foot.appendChild(rep);
    }
    card.appendChild(foot);
    return card;
  }
  function setSort(s) {
    sort = s;
    document.querySelectorAll(".feed-tab").forEach((b) => b.classList.toggle("active", b.dataset.sort === s));
    load(true);
  }
  document.querySelectorAll(".feed-tab").forEach((b) => b.addEventListener("click", () => setSort(b.dataset.sort)));
  $("feed-more").addEventListener("click", () => load(false));
  $("feed-reload").addEventListener("click", () => load(true));

  // ---------------------------------------------------------------- 投稿する
  let draft = null;
  function compose(d) {
    draft = d;
    $("cp-topic").textContent = d.topic + (d.hint ? `（${d.hint}）` : "");
    $("cp-verdict").textContent = d.verdict;
    $("cp-genre").textContent = d.genre ? "ジャンル：" + d.genre : "";
    $("cp-comment").value = "";
    $("cp-hide").checked = true;
    renderLines();
    $("compose-modal").hidden = false;
  }
  function renderLines() {
    const hide = $("cp-hide").checked;
    const box = $("cp-lines"); const keep = new Set([...box.querySelectorAll("input:checked")].map((c) => +c.value));
    const first = !box.children.length;
    box.innerHTML = "";
    draft.lines.forEach((x, i) => {
      const lab = el("label", "cp-line");
      const cb = el("input"); cb.type = "checkbox"; cb.value = String(i); cb.checked = first ? i < 30 : keep.has(i);
      lab.appendChild(cb);
      lab.append(el("span", "pl-k", KIND[x.k] || "・"), el("span", "pl-by", hide ? x.role : x.name), el("span", "pl-q", x.q));
      if (x.a) lab.appendChild(el("span", "pl-a", x.a));
      box.appendChild(lab);
    });
    $("cp-verdict").textContent = hide ? draft.verdictHidden : draft.verdict;
    $("cp-count").textContent = `${$("cp-comment").value.length}/140`;
  }
  $("cp-hide").addEventListener("change", renderLines);
  $("cp-comment").addEventListener("input", () => { $("cp-count").textContent = `${$("cp-comment").value.length}/140`; });
  $("cp-cancel").addEventListener("click", () => { $("compose-modal").hidden = true; });
  $("cp-post").addEventListener("click", async () => {
    if (!draft) return;
    const hide = $("cp-hide").checked;
    const picked = [...$("cp-lines").querySelectorAll("input:checked")].map((c) => draft.lines[+c.value]).slice(0, 30);
    const clip = (s, n) => String(s || "").replace(/[\t\n]/g, " ").slice(0, n);
    let log = picked.map((x) => [x.k, clip(hide ? x.role : x.name, 12), clip(x.q, 80), clip(x.a, 20)].join("\t")).join("\n");
    while (log.length > 3900) log = log.slice(0, log.lastIndexOf("\n"));
    const btn = $("cp-post"); btn.disabled = true; btn.textContent = "投稿中…";
    try {
      const C = await whenCloud();
      await C.createPost({
        name: clip(ng(draft.myName), 12) || "プレイヤー", icon: draft.icon && draft.icon.length < 20000 ? draft.icon : "",
        genre: clip(ng(draft.genre), 20), topic: clip(ng(draft.topic), 40), hint: clip(ng(draft.hint), 30),
        verdict: clip(hide ? draft.verdictHidden : draft.verdict, 40), comment: clip(ng($("cp-comment").value.trim()), 140), log: ng(log),
      });
      $("compose-modal").hidden = true;
      toast("投稿しました！「みんなの試合」で見られます");
    } catch (e) {
      console.warn(e);
      toast(/permission/i.test(String(e && e.code || e)) ? "投稿できませんでした（続けて投稿するときは1分あけてください）" : "投稿できませんでした。通信状況を確認してください");
    } finally { btn.disabled = false; btn.textContent = "投稿する"; }
  });

  return {
    init: (o) => { if (o && o.toast) toast = o.toast; },
    open: () => setSort(sort),
    compose,
  };
})();
