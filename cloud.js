/* Firebase（ルーム一覧・サイト内SNS）
   - 匿名ログインで、端末ごとのID（uid）を作る（登録・メールアドレスは不要）
   - rooms：公開ルームの一覧。ホストが30秒ごとに書き直し、90秒更新がないものは一覧に出さない
   - posts：試合のハイライトの投稿と、いいね（posts/{id}/likes/{uid}）
   書き込みのルールは firestore.rules（Firebase コンソールに貼る）
   app.js からは window.CLOUD を通して使う（読み込みに失敗したら window.CLOUD はできない） */
const V = "10.12.2";
const base = `https://www.gstatic.com/firebasejs/${V}/`;
try {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(base + "firebase-app.js"), import(base + "firebase-auth.js"), import(base + "firebase-firestore.js"),
  ]);
  const app = initializeApp(window.GAME_CONFIG.firebase);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const ROOM_FRESH_MS = 45 * 1000;   // ホストは20秒ごとに書き直すので、45秒更新がなければ閉じたとみなす

  // 匿名ログイン（前回のIDが残っていればそれを使う）
  let uidP = null;
  function ensureAuth() {
    if (!uidP) {
      uidP = new Promise((resolve, reject) => {
        const off = A.onAuthStateChanged(auth, (u) => {
          off();
          if (u) resolve(u.uid);
          else A.signInAnonymously(auth).then((c) => resolve(c.user.uid)).catch(reject);
        });
      });
      uidP.catch(() => { uidP = null; });
    }
    return uidP;
  }

  // ---- ルーム一覧
  async function putRoom(r) {
    const uid = await ensureAuth();
    await F.setDoc(F.doc(db, "rooms", r.code), {
      code: r.code, genre: r.genre, gkey: r.gkey, mode: r.mode, cap: r.cap, n: r.n, status: r.status, host: r.host,
      ownerUid: uid, updatedAt: F.serverTimestamp(), expireAt: F.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
    });
  }
  async function removeRoom(code) {
    try { await ensureAuth(); await F.deleteDoc(F.doc(db, "rooms", code)); } catch (e) { /* 自分のでない・もうない */ }
  }
  async function listRooms() {
    const since = F.Timestamp.fromMillis(Date.now() - ROOM_FRESH_MS);
    const q = F.query(F.collection(db, "rooms"), F.where("updatedAt", ">", since), F.orderBy("updatedAt", "desc"), F.limit(200));
    const snap = await F.getDocs(q);
    return snap.docs.map((d) => d.data());
  }

  // ---- 投稿
  const toPost = (d) => { const x = d.data(); return { id: d.id, ...x, createdAt: x.createdAt ? x.createdAt.toMillis() : Date.now() }; };
  async function listPosts(sort, after) {
    // 並べ替えは1項目だけにする（2項目にすると Firebase 側で「複合インデックス」の作成が必要になるため）
    const order = sort === "popular" ? [F.orderBy("likeCount", "desc")] : [F.orderBy("createdAt", "desc")];
    const parts = [F.collection(db, "posts"), ...order];
    if (after) parts.push(F.startAfter(after));
    parts.push(F.limit(15));
    const snap = await F.getDocs(F.query(...parts));
    return { posts: snap.docs.map(toPost), cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : null, more: snap.docs.length === 15 };
  }
  async function createPost(p) {
    const uid = await ensureAuth();
    const ref = F.doc(F.collection(db, "posts"));
    const b = F.writeBatch(db);
    b.set(F.doc(db, "users", uid), { lastPostAt: F.serverTimestamp() });
    b.set(ref, { uid, name: p.name, icon: p.icon || "", genre: p.genre || "", topic: p.topic, hint: p.hint || "", verdict: p.verdict || "", comment: p.comment || "", log: p.log || "", likeCount: 0, createdAt: F.serverTimestamp() });
    await b.commit();
    return ref.id;
  }
  async function deletePost(id) { await ensureAuth(); await F.deleteDoc(F.doc(db, "posts", id)); }
  async function likedSet(ids) {
    const uid = await ensureAuth();
    const res = await Promise.all(ids.map((id) => F.getDoc(F.doc(db, "posts", id, "likes", uid)).then((s) => (s.exists() ? id : null)).catch(() => null)));
    return new Set(res.filter(Boolean));
  }
  async function setLike(id, on) {
    const uid = await ensureAuth();
    const b = F.writeBatch(db);
    const likeRef = F.doc(db, "posts", id, "likes", uid);
    if (on) b.set(likeRef, { at: F.serverTimestamp() }); else b.delete(likeRef);
    b.update(F.doc(db, "posts", id), { likeCount: F.increment(on ? 1 : -1) });
    await b.commit();
  }
  async function report(postId, reason) {
    const uid = await ensureAuth();
    await F.addDoc(F.collection(db, "reports"), { postId, reason: String(reason || "").slice(0, 200), uid, createdAt: F.serverTimestamp() });
  }

  window.CLOUD = { ensureAuth, putRoom, removeRoom, listRooms, listPosts, createPost, deletePost, likedSet, setLike, report, myUid: () => (auth.currentUser ? auth.currentUser.uid : null) };
  window.dispatchEvent(new Event("cloud-ready"));
} catch (e) {
  console.warn("Firebase を読み込めませんでした", e);
  window.dispatchEvent(new Event("cloud-failed"));
}
