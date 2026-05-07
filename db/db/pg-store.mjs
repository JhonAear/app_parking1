// Postgres store (loaded only when DATABASE_URL is set)
// NOTE: uses JSONB columns for likes/votes/comments in MVP.

import crypto from "node:crypto";

export async function createPgStore({ databaseUrl }) {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });

  const q = (text, params) => pool.query(text, params);

  async function getUserByUsername(username) {
    const r = await q("select * from users where username=$1 limit 1", [username]);
    return r.rows[0] || null;
  }

  async function getUserById(id) {
    const r = await q("select * from users where id=$1 limit 1", [id]);
    return r.rows[0] || null;
  }

  async function createUser({ username, saltHex, passwordHashHex }) {
    const id = crypto.randomUUID();
    const createdAtMs = Date.now();
    await q(
      "insert into users(id, username, salt_hex, password_hash_hex, created_at_ms, display_name, bio, reputation_score) values($1,$2,$3,$4,$5,'','',0)",
      [id, username, saltHex, passwordHashHex, createdAtMs],
    );
    return { id, username, saltHex, passwordHashHex, createdAtMs, displayName: "", bio: "" };
  }

  async function createSession({ userId, username, ttlMs }) {
    const token = crypto.randomUUID();
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + Math.max(5 * 60 * 1000, Number(ttlMs || 0));
    await q("insert into sessions(token, user_id, username, created_at_ms, expires_at_ms) values($1,$2,$3,$4,$5)", [
      token,
      userId,
      username,
      createdAtMs,
      expiresAtMs,
    ]);
    return { token, userId, username, createdAtMs, expiresAtMs };
  }

  async function getSession(token) {
    await q("delete from sessions where expires_at_ms <= $1", [Date.now()]);
    const r = await q("select * from sessions where token=$1 limit 1", [token]);
    return r.rows[0] || null;
  }

  async function deleteSession(token) {
    await q("delete from sessions where token=$1", [token]);
  }

  async function updateProfile({ userId, displayName, bio }) {
    await q("update users set display_name=$2, bio=$3 where id=$1", [userId, displayName, bio]);
    return await getUserById(userId);
  }

  async function adjustReputation({ userId, delta }) {
    const d = Number(delta || 0);
    if (!Number.isFinite(d) || d === 0) return;
    await q("update users set reputation_score = reputation_score + $2 where id=$1", [userId, Math.trunc(d)]);
  }

  async function listPostsPruned() {
    // prune expired availability at read time (delete)
    await q("delete from community_posts where kind='availability' and expires_at_ms is not null and expires_at_ms <= $1", [
      Date.now(),
    ]);
    const r = await q("select * from community_posts order by created_at_ms desc limit 500", []);
    return r.rows.map(rowToPost);
  }

  function rowToPost(r) {
    return {
      id: r.id,
      title: r.title,
      note: r.note,
      fee: r.fee,
      lat: Number(r.lat),
      lon: Number(r.lon),
      createdAtMs: Number(r.created_at_ms),
      author: { userId: r.author_user_id, username: r.author_username },
      likes: r.likes || [],
      votes: r.votes || {},
      comments: r.comments || [],
      kind: r.kind || "missing_report",
      expiresAtMs: r.expires_at_ms == null ? null : Number(r.expires_at_ms),
      availability: r.availability || null,
    };
  }

  async function createPost({ title, note, fee, lat, lon, author, kind, durationMin }) {
    const id = crypto.randomUUID();
    const createdAtMs = Date.now();
    const isAvail = kind === "availability";
    const expiresAtMs = isAvail ? createdAtMs + Math.max(5, Math.min(60, Number(durationMin || 15))) * 60 * 1000 : null;
    const availability = isAvail ? "free" : null;

    await q(
      `insert into community_posts(
        id,title,note,fee,lat,lon,created_at_ms,author_user_id,author_username,kind,expires_at_ms,availability,likes,votes,comments
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'[]'::jsonb,'{}'::jsonb,'[]'::jsonb)`,
      [id, title, note, fee, lat, lon, createdAtMs, author.userId, author.username, isAvail ? "availability" : "missing_report", expiresAtMs, availability],
    );
    const row = await q("select * from community_posts where id=$1", [id]);
    return rowToPost(row.rows[0]);
  }

  async function toggleLike({ postId, userId }) {
    const post = await getPost(postId);
    if (!post) return null;
    const likes = Array.isArray(post.likes) ? [...post.likes] : [];
    const idx = likes.indexOf(userId);
    if (idx >= 0) likes.splice(idx, 1);
    else likes.push(userId);
    return await updatePostJson(postId, {
      likes,
      votes: post.votes || {},
      comments: post.comments || [],
      expiresAtMs: post.expiresAtMs,
      availability: post.availability,
    });
  }

  async function addComment({ postId, comment }) {
    const post = await getPost(postId);
    if (!post) return null;
    const comments = Array.isArray(post.comments) ? [...post.comments] : [];
    comments.push(comment);
    return await updatePostJson(postId, {
      likes: post.likes || [],
      votes: post.votes || {},
      comments,
      expiresAtMs: post.expiresAtMs,
      availability: post.availability,
    });
  }

  async function setVote({ postId, userId, value }) {
    const post = await getPost(postId);
    if (!post) return null;
    const votes = post.votes && typeof post.votes === "object" ? { ...post.votes } : {};
    if (!value) delete votes[userId];
    else votes[userId] = value;
    return await updatePostJson(postId, {
      likes: post.likes || [],
      votes,
      comments: post.comments || [],
      expiresAtMs: post.expiresAtMs,
      availability: post.availability,
    });
  }

  async function updateAvailability({ postId, expiresAtMs, availability }) {
    const post = await getPost(postId);
    if (!post) return null;
    return await updatePostJson(postId, {
      likes: post.likes || [],
      votes: post.votes || {},
      comments: post.comments || [],
      expiresAtMs,
      availability,
    });
  }

  async function deletePost(postId) {
    const r = await q("delete from community_posts where id=$1", [postId]);
    return r.rowCount > 0;
  }

  async function getPost(postId) {
    const r = await q("select * from community_posts where id=$1 limit 1", [postId]);
    return r.rows[0] ? rowToPost(r.rows[0]) : null;
  }

  async function updatePostJson(postId, { likes, votes, comments, expiresAtMs, availability }) {
    await q(
      "update community_posts set likes=$2::jsonb, votes=$3::jsonb, comments=$4::jsonb, expires_at_ms=$5, availability=$6 where id=$1",
      [postId, JSON.stringify(likes), JSON.stringify(votes), JSON.stringify(comments), expiresAtMs, availability],
    );
    return await getPost(postId);
  }

  async function createReport({ postId, reason, reporter }) {
    const id = crypto.randomUUID();
    const createdAtMs = Date.now();
    await q("insert into reports(id, post_id, reason, reason_type, created_at_ms, reporter_user_id, reporter_username) values($1,$2,$3,$4,$5,$6,$7)", [
      id,
      postId,
      reason,
      null,
      createdAtMs,
      reporter.userId,
      reporter.username,
    ]);
    return { id, postId, reason, createdAtMs, reporter };
  }

  async function createReportV2({ postId, reason, reasonType, reporter }) {
    const id = crypto.randomUUID();
    const createdAtMs = Date.now();
    await q(
      "insert into reports(id, post_id, reason, reason_type, created_at_ms, reporter_user_id, reporter_username) values($1,$2,$3,$4,$5,$6,$7)",
      [id, postId, reason, reasonType || null, createdAtMs, reporter.userId, reporter.username],
    );
    return { id, postId, reason, reasonType: reasonType || null, createdAtMs, reporter };
  }

  async function listReports() {
    const r = await q("select * from reports order by created_at_ms desc limit 500", []);
    return r.rows.map((x) => ({
      id: x.id,
      postId: x.post_id,
      reason: x.reason,
      reasonType: x.reason_type || null,
      createdAtMs: Number(x.created_at_ms),
      reporter: { userId: x.reporter_user_id, username: x.reporter_username },
    }));
  }

  async function banUser({ userId, username, reason }) {
    const id = crypto.randomUUID();
    const createdAtMs = Date.now();
    await q("insert into bans(id, user_id, username, created_at_ms, reason) values($1,$2,$3,$4,$5)", [
      id,
      userId,
      username,
      createdAtMs,
      reason || "banned",
    ]);
    return { id, userId, username, createdAtMs, reason: reason || "banned" };
  }

  async function isBanned({ userId }) {
    const r = await q("select 1 from bans where user_id=$1 limit 1", [userId]);
    return r.rows.length > 0;
  }

  async function addLiveEvent({ postId, userId, username, kind }) {
    const id = crypto.randomUUID();
    const createdAtMs = Date.now();
    await q("insert into live_events(id, post_id, user_id, username, kind, created_at_ms) values($1,$2,$3,$4,$5,$6)", [
      id,
      postId,
      userId,
      username,
      kind,
      createdAtMs,
    ]);
    return { id, postId, userId, username, kind, createdAtMs };
  }

  async function listLiveEvents(postId) {
    const r = await q("select * from live_events where post_id=$1 order by created_at_ms desc limit 200", [postId]);
    return r.rows.map((x) => ({
      id: x.id,
      postId: x.post_id,
      userId: x.user_id,
      username: x.username,
      kind: x.kind,
      createdAtMs: Number(x.created_at_ms),
    }));
  }

  async function createNotification({ userId, type, payload }) {
    const id = crypto.randomUUID();
    const createdAtMs = Date.now();
    await q("insert into notifications(id, user_id, created_at_ms, type, payload) values($1,$2,$3,$4,$5::jsonb)", [
      id,
      userId,
      createdAtMs,
      type,
      JSON.stringify(payload || {}),
    ]);
    return { id, userId, createdAtMs, type, payload: payload || {} };
  }

  async function listNotifications({ userId, sinceMs = 0 }) {
    const r = await q(
      "select * from notifications where user_id=$1 and created_at_ms >= $2 order by created_at_ms desc limit 200",
      [userId, Number(sinceMs || 0)],
    );
    return r.rows.map((x) => ({
      id: x.id,
      userId: x.user_id,
      createdAtMs: Number(x.created_at_ms),
      type: x.type,
      payload: x.payload || {},
      readAtMs: x.read_at_ms == null ? null : Number(x.read_at_ms),
    }));
  }

  async function markNotificationsRead({ userId, ids }) {
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length) return;
    await q("update notifications set read_at_ms=$3 where user_id=$1 and id = any($2::uuid[])", [
      userId,
      list,
      Date.now(),
    ]);
  }

  return {
    pool,
    getUserByUsername,
    getUserById,
    createUser,
    createSession,
    getSession,
    deleteSession,
    updateProfile,
    adjustReputation,
    listPostsPruned,
    createPost,
    deletePost,
    getPost,
    updatePostJson,
    toggleLike,
    addComment,
    setVote,
    updateAvailability,
    createReport,
    createReportV2,
    listReports,
    banUser,
    isBanned,
    addLiveEvent,
    listLiveEvents,
    createNotification,
    listNotifications,
    markNotificationsRead,
  };
}
