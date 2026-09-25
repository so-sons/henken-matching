/* カギ付きリンクの検証と、暗号化されたキャラデータ (data.bin) の復号
   - URL の #k=XXXX がカギ。初回に開いた端末では localStorage に保存する
   - カギが無い／間違っている場合は「無効なリンク」画面だけを表示する */
(async () => {
  const KEY_LS = (window.GAME_CONFIG && window.GAME_CONFIG.id ? window.GAME_CONFIG.id : "game") + ".key";
  const gate = document.getElementById("gate");
  const gateMsg = document.getElementById("gate-msg");
  const app = document.getElementById("app");

  const showGate = (msg) => { gateMsg.textContent = msg; gate.hidden = false; app.hidden = true; };

  function readKey() {
    const m = location.hash.match(/[#&]k=([A-Za-z0-9_-]{16,})/);
    if (m) { try { localStorage.setItem(KEY_LS, m[1]); } catch {} return m[1]; }
    try { return localStorage.getItem(KEY_LS); } catch { return null; }
  }
  const b64urlToBytes = (s) => {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  };

  const key = readKey();
  if (!key) return showGate("このリンクからは開けません。招待してくれた人からもらったリンク（#k=… 付き）を開いてください。");
  if (!window.isSecureContext || !crypto.subtle) return showGate("このブラウザでは開けません（https で開いてください）。");

  let data;
  try {
    const buf = await fetch("data.bin", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); });
    const raw = b64urlToBytes(key);
    const ck = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, ck, buf.slice(12));
    data = JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    try { localStorage.removeItem(KEY_LS); } catch {}
    return showGate("リンクが正しくありません。招待してくれた人に最新のリンクを確認してください。");
  }

  window.GAME_KEY = key;
  gate.hidden = true;
  app.hidden = false;
  window.GAME_START(data);
})();
