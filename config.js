/* ================================================================
   題材ごとの設定ファイル（偏見ゲッサー）
   キャラデータ（data.src.js → data.bin）はイナゲッサーと同じ形式。
   ================================================================ */
window.GAME_CONFIG = {
  // --- 識別子（localStorage と PeerJS ルームIDの接頭辞。題材ごとに必ず変える） ---
  id: "henken-guesser",
  // --- 公開URL（build-data.js が共有リンクを表示するのに使う） ---
  siteUrl: "https://so-sons.github.io/henken-guesser/",

  // --- 見た目の文言 ---
  title: "偏見ゲッサー",
  kicker: "INAZUMA ELEVEN 偏見 GUESSER",
  heroTitle: "「〇〇そうですか？」\n偏見でキャラを当てよう",
  itemLabel: "キャラ",
  unit: "人",
  credit: "非公式ファンゲームです。キャラクターデータは",
  creditLink: { label: "イナズマイレブン公式選手図鑑 Inagle", url: "https://zukan.inazuma.jp/" },
  creditTail: "を元にしています。©LEVEL-5 Inc.",

  // --- 入力欄の例 ---
  biasExample: "彼女がコロコロ変わって",   // 「　」そうですか？ の空欄の例
  freeExample: "中学生ですか？",           // 自由質問の例

  // --- ルール ---
  maxPlayers: 4,

  // --- 画像（空文字にすると画像なしで動く） ---
  imageBase: "https://dxi4wb638ujep.cloudfront.net/1/",
  imageExt: ".webp",

  // --- キャラデータの読み方 ---
  fields: { name: "n", kana: "k", alias: "a", image: "i", main: "m" },
  suggestSub: (c) => c.p + "・" + c.t.slice(0, 2).join(" / "),

  // --- 正解発表で見せるプロフィール ---
  attrs: [
    { key: "t",  label: "所属チーム", type: "set", empty: "所属なし" },
    { key: "p",  label: "ポジション" },
    { key: "g",  label: "性別" },
    { key: "gr", label: "学年" },
    { key: "e",  label: "属性" },
    { key: "f",  label: "初登場作品", labels: "works" },
  ],
};
