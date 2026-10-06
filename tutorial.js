/* 遊び方のチュートリアル（スライド）。ホームの「遊び方を見る」と右上の「？」で開く。
   初めて開いた人には最初の1回だけ自動で出す（ルームへの招待リンクから来たときは出さない） */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SEEN_KEY = ((window.GAME_CONFIG && window.GAME_CONFIG.id) || "game") + ".tutorialSeen";
  const modal = $("tutorial-modal");
  const slides = [...document.querySelectorAll("#tut-slides .tut-slide")];
  let idx = 0;

  const dots = $("tut-dots");
  slides.forEach((_, i) => {
    const d = document.createElement("button");
    d.type = "button"; d.className = "tut-dot"; d.setAttribute("aria-label", `${i + 1}枚目`);
    d.addEventListener("click", () => show(i));
    dots.appendChild(d);
  });

  function show(i) {
    idx = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, k) => { s.hidden = k !== idx; });
    [...dots.children].forEach((d, k) => d.classList.toggle("on", k === idx));
    $("tut-prev").disabled = idx === 0;
    const last = idx === slides.length - 1;
    $("tut-next").textContent = last ? "はじめる！" : "次へ →";
    $("tut-skip").textContent = last ? "閉じる" : "スキップ";
    $("tut-slides").scrollTop = 0;
  }
  function open() { modal.hidden = false; show(0); $("tut-next").focus(); }
  function close() { modal.hidden = true; try { localStorage.setItem(SEEN_KEY, "1"); } catch {} }

  $("tut-next").addEventListener("click", () => (idx === slides.length - 1 ? close() : show(idx + 1)));
  $("tut-prev").addEventListener("click", () => show(idx - 1));
  $("tut-skip").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => {
    if (modal.hidden) return;
    if (e.key === "ArrowRight") show(idx + 1);
    else if (e.key === "ArrowLeft") show(idx - 1);
    else if (e.key === "Escape") close();
  });
  // スワイプでめくる
  let sx = null, sy = null;
  $("tut-slides").addEventListener("touchstart", (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
  $("tut-slides").addEventListener("touchend", (e) => {
    if (sx == null) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    sx = sy = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) show(idx + (dx < 0 ? 1 : -1));
  }, { passive: true });

  document.querySelectorAll("[data-open-tutorial]").forEach((b) => b.addEventListener("click", open));

  // 初めての人には1回だけ自動で出す
  let seen = false;
  try { seen = localStorage.getItem(SEEN_KEY) === "1"; } catch {}
  const invited = new URLSearchParams(location.search).has("room");
  if (!seen && !invited) open();
})();
