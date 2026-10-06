/* NGワードの簡易フィルター
   チャット・偏見・質問・回答・お題・名前などに含まれていたら「＊」で隠す。
   ひらがな／カタカナ、全角／半角、間に入れた空白や記号の違いはまとめて判定する。
   ふつうの言葉を巻き込みやすいもの（例：「ちんこ」→「パチンコ」）は入れていない。追加・削除は自由 */
window.NG_WORDS = [
  // 暴言・脅し
  "死ね", "氏ね", "殺すぞ", "殺してやる", "ぶっ殺", "ぶっころ", "消えろ", "自殺しろ",
  // 差別的な言葉
  "きちがい", "基地外", "ガイジ", "池沼", "チョン公", "支那人",
  // 性的な言葉
  "セックス", "まんこ", "ちんぽ", "レイプ", "fuck", "sex",
];

window.ngFilter = (() => {
  const SKIP = /[\s・･\-‐ー_.,、。!！?？*＊~〜]/;
  const norm = (c) => c
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
  const words = window.NG_WORDS.map((w) => [...w].filter((c) => !SKIP.test(c)).map(norm).join("")).filter(Boolean);
  return (text) => {
    text = text == null ? "" : String(text);
    if (!text || !words.length) return text;
    const chars = [...text];
    const at = []; let n = "";   // 判定用の文字列と、その1文字が元の何文字目か
    chars.forEach((c, i) => { if (SKIP.test(c)) return; const m = norm(c); n += m; for (let k = 0; k < m.length; k++) at.push(i); });
    const mask = new Array(chars.length).fill(false);
    let hit = false;
    for (const w of words) {
      for (let p = n.indexOf(w); p >= 0; p = n.indexOf(w, p + 1)) { hit = true; for (let k = p; k < p + w.length; k++) mask[at[k]] = true; }
    }
    return hit ? chars.map((c, i) => (mask[i] ? "＊" : c)).join("") : text;
  };
})();
