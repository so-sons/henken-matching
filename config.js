/* ================================================================
   偏見マッチングの設定（文言・人数など）
   お題は出題者が自由に入力するので、キャラデータは使わない。
   ================================================================ */
window.GAME_CONFIG = {
  // --- 識別子（localStorage と PeerJS ルームIDの接頭辞） ---
  id: "henken-guesser",
  // --- 公開URL（友達に教えるリンクはこのURLになる） ---
  siteUrl: "https://so-sons.github.io/henken-matching/",

  // --- 見た目の文言 ---
  title: "偏見マッチング",
  kicker: "HENKEN MATCHING",
  heroTitle: "「〇〇そうですか？」\n偏見でお題を当てよう",

  // --- 入力欄の例 ---
  biasExample: "淫夢知って",   // 「　」そうですか？ の空欄の例
  freeExample: "中学生ですか？",           // 自由質問の例
  topicExample: "ルフィ",                  // お題の例
  hintExample: "アニメキャラ",             // ジャンルの例

  // --- ルール ---
  maxPlayers: 4,
};
