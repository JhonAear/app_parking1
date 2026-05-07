import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_ROOT = path.join(__dirname, "web");
const PORT = Number(process.env.PORT || 8787);
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const DATA_DIR = path.join(__dirname, "data");
const POSTS_FILE = path.join(DATA_DIR, "community-posts.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const ADMIN_USERS = String(process.env.ADMIN_USERS || "").trim(); // comma-separated usernames
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

// --- Simple in-memory rate limiting (prototype) ---
// key: `${ip}|${route}` -> { count, resetAtMs }
const RATE = new Map();
function getIp(req) {
  // best-effort (behind proxies you'd use X-Forwarded-For)
  return String(req.socket?.remoteAddress || "unknown");
}
function rateLimit(req, res, routeKey, { limit, windowMs }) {
  const key = `${getIp(req)}|${routeKey}`;
  const now = Date.now();
  const cur = RATE.get(key);
  if (!cur || cur.resetAtMs <= now) {
    RATE.set(key, { count: 1, resetAtMs: now + windowMs });
    return true;
  }
  if (cur.count >= limit) {
    const retrySec = Math.max(1, Math.ceil((cur.resetAtMs - now) / 1000));
    sendJson(res, 429, { ok: false, error: "Rate limited", message: `Troppi tentativi. Riprova tra ${retrySec}s.` });
    return false;
  }
  cur.count += 1;
  RATE.set(key, cur);
  return true;
}

// Best-effort in-memory cache to keep the app usable when Overpass is flaky.
// Keyed by rounded bbox.
const OSM_CACHE = new Map(); // key -> { tsMs, json }
const OSM_CACHE_TTL_MS = 10 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(POSTS_FILE)) fs.writeFileSync(POSTS_FILE, "[]", "utf-8");
  if (!fs.existsSync(REPORTS_FILE)) fs.writeFileSync(REPORTS_FILE, "[]", "utf-8");
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]", "utf-8");
}

// Data store abstraction:
// - default: JSON files in ./data
// - postgres: when DATABASE_URL is set
let STORE = null;
async function getStore() {
  if (STORE) return STORE;
  if (DATABASE_URL) {
    const { createPgStore } = await import("./db/pg-store.mjs");
    STORE = await createPgStore({ databaseUrl: DATABASE_URL });
    return STORE;
  }
  STORE = { kind: "json" };
  return STORE;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function pruneExpiredAvailability(posts) {
  const now = Date.now();
  const out = [];
  let changed = false;
  for (const p of Array.isArray(posts) ? posts : []) {
    if (p?.kind === "availability" && Number.isFinite(p.expiresAtMs) && p.expiresAtMs <= now) {
      changed = true;
      continue; // drop expired live signals from API
    }
    out.push(p);
  }
  return { posts: out, changed };
}

function writeJsonFileAtomic(file, obj) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

function safeJoin(root, reqPath) {
  const cleaned = reqPath.split("?")[0].split("#")[0];
  const decoded = decodeURIComponent(cleaned);
  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(root, normalized);
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(obj));
}

function parseUrl(reqUrl) {
  try {
    return new URL(reqUrl || "/", `http://localhost:${PORT}`);
  } catch {
    return new URL("/", `http://localhost:${PORT}`);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function getBearerToken(req) {
  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// sessions in-memory (fine for JSON prototype)
const SESSIONS = new Map(); // token -> { userId, username, createdAtMs }

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function isValidUsername(username) {
  // simple: 3-24 chars, letters/numbers/_.
  return /^[a-z0-9_]{3,24}$/.test(username);
}

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  const key = crypto.scryptSync(password, salt, 32);
  return key.toString("hex");
}

function timingSafeEqualHex(aHex, bHex) {
  const a = Buffer.from(String(aHex || ""), "hex");
  const b = Buffer.from(String(bHex || ""), "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function publicUser(u) {
  return {
    userId: u.id,
    username: u.username,
    createdAtMs: u.createdAtMs,
    displayName: u.displayName || "",
    bio: u.bio || "",
  };
}

function requireAuth(req, res) {
  const token = getBearerToken(req);
  if (!token) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return Promise.resolve(null);
  }
  if (DATABASE_URL) {
    return getStore()
      .then((st) => st.getSession(token).then((row) => ({ st, row })))
      .then(({ st, row }) => {
        if (!row) {
          sendJson(res, 401, { ok: false, error: "Invalid session" });
          return null;
        }
        if (st.isBanned) {
          return st.isBanned({ userId: row.user_id }).then((banned) => {
            if (banned) {
              sendJson(res, 403, { ok: false, error: "Banned" });
              return null;
            }
            return { userId: row.user_id, username: row.username, createdAtMs: Number(row.created_at_ms) };
          });
        }
        return { userId: row.user_id, username: row.username, createdAtMs: Number(row.created_at_ms) };
      })
      .catch((e) => {
        sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) });
        return null;
      });
  }
  const s = SESSIONS.get(token);
  if (!s) {
    sendJson(res, 401, { ok: false, error: "Invalid session" });
    return Promise.resolve(null);
  }
  return Promise.resolve(s);
}

function isAdminSession(s) {
  if (!s) return false;
  if (!ADMIN_USERS) return false;
  const set = new Set(
    ADMIN_USERS.split(",")
      .map((x) => normalizeUsername(x))
      .filter(Boolean),
  );
  return set.has(normalizeUsername(s.username));
}

function ensureVotesShape(post) {
  // votes: { [userId]: 1 | -1 }  (1=confirm, -1=deny)
  const v = post && typeof post === "object" ? post.votes : null;
  if (!v || typeof v !== "object" || Array.isArray(v)) post.votes = {};
}

function votesSummary(post) {
  ensureVotesShape(post);
  const vals = Object.values(post.votes || {});
  let confirm = 0;
  let deny = 0;
  for (const x of vals) {
    if (x === 1) confirm += 1;
    else if (x === -1) deny += 1;
  }
  return { confirm, deny, total: confirm + deny };
}

function liveConsensusSummary(events) {
  // Count last unique users for each kind
  const byUser = new Map(); // userId -> kind
  for (const e of Array.isArray(events) ? events : []) {
    if (!e?.userId) continue;
    if (!byUser.has(e.userId)) byUser.set(e.userId, e.kind);
  }
  let free = 0;
  let occupied = 0;
  for (const k of byUser.values()) {
    if (k === "confirm_free") free += 1;
    else if (k === "confirm_occupied") occupied += 1;
  }
  return { free, occupied };
}

function overpassQuery(lat, lon, radiusM) {
  // Convert radius to bbox degrees (approx)
  const r = radiusM;
  const dLat = r / 111_320;
  const dLon = r / (111_320 * Math.cos((lat * Math.PI) / 180));
  const s = lat - dLat;
  const w = lon - dLon;
  const n = lat + dLat;
  const e = lon + dLon;

  return `
    [out:json][timeout:25];
    (
      node["amenity"="parking"](${s},${w},${n},${e});
      way["amenity"="parking"](${s},${w},${n},${e});
      relation["amenity"="parking"](${s},${w},${n},${e});
    );
    out center tags;
  `.trim();
}

function overpassQueryBBox(s, w, n, e) {
  return `
    [out:json][timeout:25];
    (
      /* nodes only for speed/stability */
      node["amenity"="parking"](${s},${w},${n},${e});
    );
    out tags;
  `.trim();
}

async function fetchOverpass(lat, lon, radiusM) {
  const data = overpassQuery(lat, lon, radiusM);
  const body = new URLSearchParams({ data }).toString();

  let lastErr = null;
  for (const url of OVERPASS_URLS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error("Overpass unavailable");
}

async function fetchOverpassBBox(s, w, n, e) {
  const data = overpassQueryBBox(s, w, n, e);
  const body = new URLSearchParams({ data }).toString();

  let lastErr = null;
  for (const url of OVERPASS_URLS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
        signal: AbortSignal.timeout(18_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e2) {
      lastErr = e2;
      continue;
    }
  }
  throw lastErr || new Error("Overpass unavailable");
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label || "timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function bboxCacheKey(s, w, n, e) {
  return `${round3(s)}|${round3(w)}|${round3(n)}|${round3(e)}`;
}

function getCachedBBox(s, w, n, e) {
  const key = bboxCacheKey(s, w, n, e);
  const v = OSM_CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.tsMs > OSM_CACHE_TTL_MS) return { ...v, stale: true };
  return { ...v, stale: false };
}

function setCachedBBox(s, w, n, e, json) {
  const key = bboxCacheKey(s, w, n, e);
  OSM_CACHE.set(key, { tsMs: Date.now(), json });
}

async function fetchNominatim(q) {
  // Nominatim usage policy: be gentle, set UA, keep results small.
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "6");
  url.searchParams.set("countrycodes", "it");

  const r = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "ParkingFinderMVP/1.0 (local prototype)",
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

const server = http.createServer((req, res) => {
  try {
    ensureDataDir();
    // init store lazily (JSON by default, Postgres if DATABASE_URL is set)
    // NOTE: getStore() is async; we only use it inside async branches.
    const u = parseUrl(req.url);

    // Basic CORS preflight support
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    if (u.pathname === "/api/auth/login" && req.method === "POST") {
      if (!rateLimit(req, res, "auth:login", { limit: 12, windowMs: 60_000 })) return;
      readBody(req)
        .then((raw) => {
          const body = raw ? JSON.parse(raw) : {};
          const username = normalizeUsername(body.username);
          const password = String(body.password || "");
          if (!isValidUsername(username)) {
            sendJson(res, 400, { ok: false, error: "Invalid username" });
            return;
          }
          if (!password || password.length < 8) {
            sendJson(res, 400, { ok: false, error: "Invalid password" });
            return;
          }

          if (DATABASE_URL) {
            return getStore()
              .then((st) => st.getUserByUsername(username))
              .then((u2) => {
                if (!u2) {
                  sendJson(res, 401, { ok: false, error: "Invalid credentials" });
                  return null;
                }
                const computed = hashPassword(password, u2.salt_hex);
                if (!timingSafeEqualHex(computed, u2.password_hash_hex)) {
                  sendJson(res, 401, { ok: false, error: "Invalid credentials" });
                  return null;
                }
                return getStore()
                  .then((st) => st.createSession({ userId: u2.id, username: u2.username, ttlMs: 30 * 24 * 3600 * 1000 }))
                  .then((sess) => {
                    const session = { userId: u2.id, username: u2.username, createdAtMs: Date.now() };
                    sendJson(res, 200, { ok: true, token: sess.token, user: session });
                    return null;
                  });
              });
          }

          const users = readJsonFile(USERS_FILE, []);
          const user = users.find((u2) => u2.username === username);
          if (!user) {
            sendJson(res, 401, { ok: false, error: "Invalid credentials" });
            return;
          }

          const computed = hashPassword(password, user.saltHex);
          if (!timingSafeEqualHex(computed, user.passwordHashHex)) {
            sendJson(res, 401, { ok: false, error: "Invalid credentials" });
            return;
          }

          const token = crypto.randomUUID();
          const session = { userId: user.id, username: user.username, createdAtMs: Date.now() };
          SESSIONS.set(token, session);
          sendJson(res, 200, { ok: true, token, user: session });
        })
        .catch((e) => sendJson(res, 400, { ok: false, error: "Bad request", message: String(e?.message || e) }));
      return;
    }

    if (u.pathname === "/api/auth/register" && req.method === "POST") {
      if (!rateLimit(req, res, "auth:register", { limit: 6, windowMs: 60_000 })) return;
      readBody(req)
        .then((raw) => {
          const body = raw ? JSON.parse(raw) : {};
          const username = normalizeUsername(body.username);
          const password = String(body.password || "");
          if (!isValidUsername(username)) {
            sendJson(res, 400, { ok: false, error: "Invalid username (use a-z, 0-9, _; 3-24 chars)" });
            return;
          }
          if (!password || password.length < 8) {
            sendJson(res, 400, { ok: false, error: "Password too short (min 8)" });
            return;
          }

          const saltHex = crypto.randomBytes(16).toString("hex");
          const passwordHashHex = hashPassword(password, saltHex);

          if (DATABASE_URL) {
            return getStore()
              .then((st) => st.getUserByUsername(username))
              .then((existing) => {
                if (existing) {
                  sendJson(res, 409, { ok: false, error: "Username already taken" });
                  return null;
                }
                return getStore()
                  .then((st) => st.createUser({ username, saltHex, passwordHashHex }))
                  .then((user) => {
                    return getStore()
                      .then((st) =>
                        st.createSession({ userId: user.id, username: user.username, ttlMs: 30 * 24 * 3600 * 1000 }),
                      )
                      .then((sess) => {
                        const session = { userId: user.id, username: user.username, createdAtMs: Date.now() };
                        sendJson(res, 200, { ok: true, token: sess.token, user: session });
                        return null;
                      });
                  });
              });
          }

          const users = readJsonFile(USERS_FILE, []);
          if (users.some((u2) => u2.username === username)) {
            sendJson(res, 409, { ok: false, error: "Username already taken" });
            return;
          }

          const user = { id: crypto.randomUUID(), username, saltHex, passwordHashHex, createdAtMs: Date.now() };
          users.push(user);
          writeJsonFileAtomic(USERS_FILE, users);

          const token = crypto.randomUUID();
          const session = { userId: user.id, username: user.username, createdAtMs: Date.now() };
          SESSIONS.set(token, session);
          sendJson(res, 200, { ok: true, token, user: session });
        })
        .catch((e) => sendJson(res, 400, { ok: false, error: "Bad request", message: String(e?.message || e) }));
      return;
    }

    if (u.pathname === "/api/auth/me" && req.method === "GET") {
      requireAuth(req, res).then((s) => {
        if (!s) return;
        if (DATABASE_URL) {
          getStore()
            .then((st) => st.getUserById(s.userId))
            .then((u0) => {
              const enriched = u0 ? { ...s, displayName: u0.display_name || "", bio: u0.bio || "" } : s;
              sendJson(res, 200, { ok: true, user: enriched });
            })
            .catch((e) => sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) }));
          return;
        }
        const users = readJsonFile(USERS_FILE, []);
        const u0 = users.find((x) => x.id === s.userId);
        const enriched = u0 ? { ...s, displayName: u0.displayName || "", bio: u0.bio || "" } : s;
        sendJson(res, 200, { ok: true, user: enriched });
      });
      return;
    }

    if (u.pathname === "/api/profile" && req.method === "GET") {
      requireAuth(req, res).then((s) => {
        if (!s) return;
        if (DATABASE_URL) {
          getStore()
            .then((st) => st.getUserById(s.userId))
            .then((user) => {
              if (!user) {
                sendJson(res, 404, { ok: false, error: "User not found" });
                return;
              }
              sendJson(res, 200, { ok: true, profile: publicUser({ id: user.id, username: user.username, createdAtMs: user.created_at_ms, displayName: user.display_name, bio: user.bio }) });
            })
            .catch((e) => sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) }));
          return;
        }
        const users = readJsonFile(USERS_FILE, []);
        const user = users.find((x) => x.id === s.userId);
        if (!user) {
          sendJson(res, 404, { ok: false, error: "User not found" });
          return;
        }
        sendJson(res, 200, { ok: true, profile: publicUser(user) });
      });
      return;
    }

    if (u.pathname === "/api/profile" && req.method === "POST") {
      // auth checked inside handler
      readBody(req)
        .then((raw) => {
          return requireAuth(req, res).then((s) => {
            if (!s) return null;
            const body = raw ? JSON.parse(raw) : {};
            const displayName = String(body.displayName || "").trim().slice(0, 40);
            const bio = String(body.bio || "").trim().slice(0, 240);
            if (DATABASE_URL) {
              return getStore()
                .then((st) => st.updateProfile({ userId: s.userId, displayName, bio }))
                .then((user) => {
                  if (!user) {
                    sendJson(res, 404, { ok: false, error: "User not found" });
                    return null;
                  }
                  sendJson(res, 200, {
                    ok: true,
                    profile: publicUser({
                      id: user.id,
                      username: user.username,
                      createdAtMs: user.created_at_ms,
                      displayName: user.display_name,
                      bio: user.bio,
                    }),
                  });
                  return null;
                })
                .catch((e) => {
                  sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) });
                  return null;
                });
            }
            const users = readJsonFile(USERS_FILE, []);
            const user = users.find((x) => x.id === s.userId);
            if (!user) {
              sendJson(res, 404, { ok: false, error: "User not found" });
              return null;
            }
            user.displayName = displayName;
            user.bio = bio;
            writeJsonFileAtomic(USERS_FILE, users);
            sendJson(res, 200, { ok: true, profile: publicUser(user) });
            return null;
          });
        })
        .catch((e) => sendJson(res, 400, { ok: false, error: "Bad request", message: String(e?.message || e) }));
      return;
    }

    if (u.pathname === "/api/community/posts" && req.method === "GET") {
      if (DATABASE_URL) {
        getStore()
          .then((st) => st.listPostsPruned())
          .then((posts) => sendJson(res, 200, { ok: true, posts }))
          .catch((e) => sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) }));
        return;
      }
      const rawPosts = readJsonFile(POSTS_FILE, []);
      const pruned = pruneExpiredAvailability(rawPosts);
      if (pruned.changed) writeJsonFileAtomic(POSTS_FILE, pruned.posts);
      sendJson(res, 200, { ok: true, posts: pruned.posts });
      return;
    }

    // Admin: delete post
    {
      const m = u.pathname.match(/^\/api\/community\/posts\/([^/]+)$/);
      if (m && req.method === "DELETE") {
        requireAuth(req, res).then((s) => {
          if (!s) return;
          if (!isAdminSession(s)) {
            sendJson(res, 403, { ok: false, error: "Forbidden" });
            return;
          }
          const postId = m[1];
          if (DATABASE_URL) {
            getStore()
              .then((st) => st.deletePost(postId))
              .then((ok) => {
                if (!ok) {
                  sendJson(res, 404, { ok: false, error: "Post not found" });
                  return;
                }
                sendJson(res, 200, { ok: true, deleted: postId });
              })
              .catch((e) => sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) }));
            return;
          }
          const posts = readJsonFile(POSTS_FILE, []);
          const before = posts.length;
          const filtered = posts.filter((p) => p.id !== postId);
          if (filtered.length === before) {
            sendJson(res, 404, { ok: false, error: "Post not found" });
            return;
          }
          writeJsonFileAtomic(POSTS_FILE, filtered);
          sendJson(res, 200, { ok: true, deleted: postId });
        });
        return;
      }
    }

    if (u.pathname === "/api/community/posts" && req.method === "POST") {
      readBody(req)
        .then((raw) =>
          requireAuth(req, res).then((s) => {
            if (!s) return null;
            if (!rateLimit(req, res, `community:post:${s.userId}`, { limit: 20, windowMs: 60_000 })) return null;
            const body = raw ? JSON.parse(raw) : {};
            const title = String(body.title || "").trim();
            const note = String(body.note || "").trim();
            const fee = String(body.fee || "unknown");
            const lat = Number(body.lat);
            const lon = Number(body.lon);
            const kind = String(body.kind || "missing_report");
            const durationMin = Math.max(5, Math.min(60, Number(body.durationMin || 15)));
            if (!title) {
              sendJson(res, 400, { ok: false, error: "Missing title" });
              return null;
            }
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
              sendJson(res, 400, { ok: false, error: "Invalid coordinates" });
              return null;
            }

            if (DATABASE_URL) {
              return getStore()
                .then((st) =>
                  st.createPost({
                    title,
                    note,
                    fee,
                    lat,
                    lon,
                    author: { userId: s.userId, username: s.username },
                    kind: kind === "availability" ? "availability" : "missing_report",
                    durationMin,
                  }),
                )
                .then((post) => sendJson(res, 200, { ok: true, post }))
                .catch((e) => sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) }));
            }

            const posts = readJsonFile(POSTS_FILE, []);
            const post = {
              id: crypto.randomUUID(),
              title,
              note,
              fee,
              lat,
              lon,
              createdAtMs: Date.now(),
              author: { userId: s.userId, username: s.username },
              likes: [],
              votes: {},
              comments: [],
              kind: kind === "availability" ? "availability" : "missing_report",
              expiresAtMs: kind === "availability" ? Date.now() + durationMin * 60 * 1000 : null,
              availability: kind === "availability" ? "free" : null,
            };
            posts.push(post);
            writeJsonFileAtomic(POSTS_FILE, posts);
            sendJson(res, 200, { ok: true, post });
            return null;
          }),
        )
        .catch((e) => sendJson(res, 400, { ok: false, error: "Bad request", message: String(e?.message || e) }));
      return;
    }

    // Live availability update (extend/mark occupied)
    {
      const m = u.pathname.match(/^\/api\/community\/posts\/([^/]+)\/availability$/);
      if (m && req.method === "POST") {
        const postId = m[1];
        readBody(req)
          .then((raw) => {
            return requireAuth(req, res).then((s) => {
              if (!s) return null;
              if (!rateLimit(req, res, `community:availability:${s.userId}`, { limit: 30, windowMs: 60_000 })) return null;
              const body = raw ? JSON.parse(raw) : {};
              const action = String(body.action || ""); // extend | occupied | confirm_free | confirm_occupied
              const durationMin = Math.max(5, Math.min(60, Number(body.durationMin || 15)));

              if (DATABASE_URL) {
                return getStore()
                  .then((st) => st.getPost(postId))
                  .then((post) => {
                    if (!post) {
                      sendJson(res, 404, { ok: false, error: "Post not found" });
                      return null;
                    }
                    if (post.kind !== "availability") {
                      sendJson(res, 400, { ok: false, error: "Not an availability post" });
                      return null;
                    }
                    // Author shortcuts remain, but consensus actions allowed for everyone.
                    if (action === "extend" || action === "occupied") {
                      if (post.author?.userId !== s.userId) {
                        sendJson(res, 403, { ok: false, error: "Only author can update" });
                        return null;
                      }
                      const next =
                        action === "extend"
                          ? { expiresAtMs: Date.now() + durationMin * 60 * 1000, availability: "free" }
                          : { expiresAtMs: Date.now(), availability: "occupied" };
                      return getStore()
                        .then((st2) => st2.updateAvailability({ postId, ...next }))
                        .then((p2) => sendJson(res, 200, { ok: true, post: p2 }));
                    }

                    if (action === "confirm_free" || action === "confirm_occupied") {
                      const kind = action;
                      return getStore()
                        .then((st2) => st2.addLiveEvent({ postId, userId: s.userId, username: s.username, kind }))
                        .then(() => getStore().then((st2) => st2.listLiveEvents(postId)))
                        .then((events) => {
                          const sum = liveConsensusSummary(events);
                          const threshold = 2;
                          // Update availability when consensus reached
                          const decided =
                            sum.occupied >= threshold ? "occupied" : sum.free >= threshold ? "free" : null;
                          if (!decided) {
                            sendJson(res, 200, { ok: true, consensus: sum, decided: null });
                            return null;
                          }
                          const expiresAtMs = decided === "occupied" ? Date.now() : Math.max(Date.now() + 5 * 60 * 1000, Number(post.expiresAtMs || 0));
                          return getStore()
                            .then((st2) => st2.updateAvailability({ postId, expiresAtMs, availability: decided }))
                            .then((p2) => {
                              // notify author
                              if (p2?.author?.userId) {
                                getStore()
                                  .then((st3) =>
                                    st3.createNotification({
                                      userId: p2.author.userId,
                                      type: "live_consensus",
                                      payload: { postId, decided, free: sum.free, occupied: sum.occupied },
                                    }),
                                  )
                                  .catch(() => {});
                              }
                              sendJson(res, 200, { ok: true, post: p2, consensus: sum, decided });
                              return null;
                            });
                        })
                        .catch((e) => {
                          sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) });
                          return null;
                        });
                    }

                    sendJson(res, 400, { ok: false, error: "Invalid action" });
                    return null;
                  })
                  .catch((e) => {
                    sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) });
                    return null;
                  });
              }

              const postsRaw = readJsonFile(POSTS_FILE, []);
              const pruned = pruneExpiredAvailability(postsRaw);
              const posts = pruned.posts;

              const post = posts.find((p) => p.id === postId);
              if (!post) {
                sendJson(res, 404, { ok: false, error: "Post not found" });
                return null;
              }
              if (post.kind !== "availability") {
                sendJson(res, 400, { ok: false, error: "Not an availability post" });
                return null;
              }
              if (post.author?.userId !== s.userId) {
                sendJson(res, 403, { ok: false, error: "Only author can update" });
                return null;
              }
              if (action === "extend") {
                post.expiresAtMs = Date.now() + durationMin * 60 * 1000;
                post.availability = "free";
              } else if (action === "occupied") {
                post.expiresAtMs = Date.now();
                post.availability = "occupied";
              } else {
                sendJson(res, 400, { ok: false, error: "Invalid action" });
                return null;
              }
              writeJsonFileAtomic(POSTS_FILE, posts);
              sendJson(res, 200, { ok: true, post });
              return null;
            });
          })
          .catch((e) => sendJson(res, 400, { ok: false, error: "Bad request", message: String(e?.message || e) }));
        return;
      }
    }

    // Toggle like
    {
      const m = u.pathname.match(/^\/api\/community\/posts\/([^/]+)\/like$/);
      if (m && req.method === "POST") {
        const postId = m[1];
        requireAuth(req, res).then((s) => {
          if (!s) return;
          if (DATABASE_URL) {
            getStore()
              .then((st) => st.toggleLike({ postId, userId: s.userId }))
              .then((post) => {
                if (!post) {
                  sendJson(res, 404, { ok: false, error: "Post not found" });
                  return;
                }
                const likes = Array.isArray(post.likes) ? post.likes : [];
                sendJson(res, 200, { ok: true, likesCount: likes.length, liked: likes.includes(s.userId) });
              })
              .catch((e) => sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) }));
            return;
          }
          const posts = readJsonFile(POSTS_FILE, []);
          const post = posts.find((p) => p.id === postId);
          if (!post) {
            sendJson(res, 404, { ok: false, error: "Post not found" });
            return;
          }
          post.likes = Array.isArray(post.likes) ? post.likes : [];
          const idx = post.likes.indexOf(s.userId);
          if (idx >= 0) post.likes.splice(idx, 1);
          else post.likes.push(s.userId);
          writeJsonFileAtomic(POSTS_FILE, posts);
          sendJson(res, 200, { ok: true, likesCount: post.likes.length, liked: idx < 0 });
        });
        return;
      }
    }

    // Add comment
    {
      const m = u.pathname.match(/^\/api\/community\/posts\/([^/]+)\/comments$/);
      if (m && req.method === "POST") {
        const postId = m[1];
        readBody(req)
          .then((raw) => {
            return requireAuth(req, res).then((s) => {
              if (!s) return null;
              if (!rateLimit(req, res, `community:comment:${s.userId}`, { limit: 40, windowMs: 60_000 })) return null;
              const body = raw ? JSON.parse(raw) : {};
              const text = String(body.text || "").trim();
              if (!text || text.length < 1) {
                sendJson(res, 400, { ok: false, error: "Empty comment" });
                return null;
              }
              if (text.length > 800) {
                sendJson(res, 400, { ok: false, error: "Comment too long" });
                return null;
              }
              const c = {
                id: crypto.randomUUID(),
                text,
                createdAtMs: Date.now(),
                author: { userId: s.userId, username: s.username },
              };
              if (DATABASE_URL) {
                return getStore()
                  .then((st) => st.addComment({ postId, comment: c }))
                  .then((post) => {
                    if (!post) {
                      sendJson(res, 404, { ok: false, error: "Post not found" });
                      return null;
                    }
                    sendJson(res, 200, { ok: true, comment: c, commentsCount: (post.comments || []).length });
                    return null;
                  })
                  .catch((e) => {
                    sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) });
                    return null;
                  });
              }

              const posts = readJsonFile(POSTS_FILE, []);
              const post = posts.find((p) => p.id === postId);
              if (!post) {
                sendJson(res, 404, { ok: false, error: "Post not found" });
                return null;
              }
              post.comments = Array.isArray(post.comments) ? post.comments : [];
              post.comments.push(c);
              writeJsonFileAtomic(POSTS_FILE, posts);
              sendJson(res, 200, { ok: true, comment: c, commentsCount: post.comments.length });
              return null;
            });
          })
          .catch((e) => sendJson(res, 400, { ok: false, error: "Bad request", message: String(e?.message || e) }));
        return;
      }
    }

    // Confirm / deny (community reliability)
    {
      const m = u.pathname.match(/^\/api\/community\/posts\/([^/]+)\/vote$/);
      if (m && req.method === "POST") {
        const postId = m[1];
        readBody(req)
          .then((raw) => {
            return requireAuth(req, res).then((s) => {
              if (!s) return null;
              if (!rateLimit(req, res, `community:vote:${s.userId}`, { limit: 120, windowMs: 60_000 })) return null;
              const body = raw ? JSON.parse(raw) : {};
              const valueRaw = Number(body.value);
              const value = valueRaw === 1 ? 1 : valueRaw === -1 ? -1 : 0;

              if (DATABASE_URL) {
                return getStore()
                  .then((st) => st.getPost(postId).then((p0) => ({ st, p0 })))
                  .then(({ st, p0 }) => {
                    if (!p0) {
                      sendJson(res, 404, { ok: false, error: "Post not found" });
                      return null;
                    }
                    const prev = Number(p0?.votes?.[s.userId] || 0);
                    return st
                      .setVote({ postId, userId: s.userId, value })
                      .then((post) => ({ st, post, prev }));
                  })
                  .then(({ st, post, prev }) => {
                    if (!post) {
                      sendJson(res, 404, { ok: false, error: "Post not found" });
                      return null;
                    }
                    // Reputation: author gains/losses based on vote delta
                    const delta = Number(value || 0) - Number(prev || 0);
                    if (delta !== 0 && post.author?.userId) {
                      st.adjustReputation({ userId: post.author.userId, delta }).catch(() => {});
                    }
                    const summary = votesSummary(post);
                    sendJson(res, 200, { ok: true, confirm: summary.confirm, deny: summary.deny, total: summary.total, myVote: value });
                    return null;
                  })
                  .catch((e) => {
                    sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) });
                    return null;
                  });
              }

              const posts = readJsonFile(POSTS_FILE, []);
              const post = posts.find((p) => p.id === postId);
              if (!post) {
                sendJson(res, 404, { ok: false, error: "Post not found" });
                return null;
              }
              ensureVotesShape(post);
              const prev = Number(post?.votes?.[s.userId] || 0);
              if (value === 0) delete post.votes[s.userId];
              else post.votes[s.userId] = value;
              // reputation in JSON mode (best-effort)
              try {
                const users = readJsonFile(USERS_FILE, []);
                const author = users.find((u2) => u2.id === post.author?.userId);
                const delta = Number(value || 0) - Number(prev || 0);
                if (author && delta !== 0) author.reputationScore = Number(author.reputationScore || 0) + delta;
                writeJsonFileAtomic(USERS_FILE, users);
              } catch {
                // ignore
              }
              const summary = votesSummary(post);
              writeJsonFileAtomic(POSTS_FILE, posts);
              sendJson(res, 200, { ok: true, confirm: summary.confirm, deny: summary.deny, total: summary.total, myVote: value });
              return null;
            });
          })
          .catch((e) => sendJson(res, 400, { ok: false, error: "Bad request", message: String(e?.message || e) }));
        return;
      }
    }

    // Report post
    {
      const m = u.pathname.match(/^\/api\/community\/posts\/([^/]+)\/report$/);
      if (m && req.method === "POST") {
        const postId = m[1];
        readBody(req)
          .then((raw) => {
            return requireAuth(req, res).then((s) => {
              if (!s) return null;
              if (!rateLimit(req, res, `community:report:${s.userId}`, { limit: 10, windowMs: 60_000 })) return null;
              const body = raw ? JSON.parse(raw) : {};
              const reason = String(body.reason || "").trim().slice(0, 240);
              const reasonType = String(body.reasonType || "").trim().slice(0, 40) || null;
              if (DATABASE_URL) {
                return getStore()
                  .then((st) => st.getPost(postId))
                  .then((post) => {
                    if (!post) {
                      sendJson(res, 404, { ok: false, error: "Post not found" });
                      return null;
                    }
                    return getStore()
                      .then((st) =>
                        (st.createReportV2
                          ? st.createReportV2({
                              postId,
                              reason: reason || "Segnalato",
                              reasonType,
                              reporter: { userId: s.userId, username: s.username },
                            })
                          : st.createReport({
                              postId,
                              reason: reason || "Segnalato",
                              reporter: { userId: s.userId, username: s.username },
                            })),
                      )
                      .then(() => sendJson(res, 200, { ok: true }));
                  })
                  .catch((e) => {
                    sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) });
                    return null;
                  });
              }
              const posts = readJsonFile(POSTS_FILE, []);
              const post = posts.find((p) => p.id === postId);
              if (!post) {
                sendJson(res, 404, { ok: false, error: "Post not found" });
                return null;
              }
              const reports = readJsonFile(REPORTS_FILE, []);
              reports.push({
                id: crypto.randomUUID(),
                postId,
                reason: reason || "Segnalato",
                reasonType,
                createdAtMs: Date.now(),
                reporter: { userId: s.userId, username: s.username },
              });
              writeJsonFileAtomic(REPORTS_FILE, reports);
              sendJson(res, 200, { ok: true });
              return null;
            });
          })
          .catch((e) => sendJson(res, 400, { ok: false, error: "Bad request", message: String(e?.message || e) }));
        return;
      }
    }

    // Admin: list reports
    if (u.pathname === "/api/community/reports" && req.method === "GET") {
      requireAuth(req, res).then((s) => {
        if (!s) return;
        if (!isAdminSession(s)) {
          sendJson(res, 403, { ok: false, error: "Forbidden" });
          return;
        }
        if (DATABASE_URL) {
          getStore()
            .then((st) => st.listReports())
            .then((reports) => sendJson(res, 200, { ok: true, reports }))
            .catch((e) => sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) }));
          return;
        }
        const reports = readJsonFile(REPORTS_FILE, []);
        sendJson(res, 200, { ok: true, reports });
      });
      return;
    }

    // Admin: ban user (PG only)
    if (u.pathname === "/api/admin/ban" && req.method === "POST") {
      readBody(req)
        .then((raw) =>
          requireAuth(req, res).then((s) => {
            if (!s) return null;
            if (!isAdminSession(s)) {
              sendJson(res, 403, { ok: false, error: "Forbidden" });
              return null;
            }
            const body = raw ? JSON.parse(raw) : {};
            const userId = String(body.userId || "").trim();
            const username = String(body.username || "").trim();
            const reason = String(body.reason || "").trim().slice(0, 240) || "banned";
            if (!DATABASE_URL) {
              sendJson(res, 400, { ok: false, error: "Postgres mode required" });
              return null;
            }
            if (!userId || !username) {
              sendJson(res, 400, { ok: false, error: "Missing userId/username" });
              return null;
            }
            return getStore()
              .then((st) => st.banUser({ userId, username, reason }))
              .then(() => sendJson(res, 200, { ok: true }))
              .catch((e) => sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) }));
          }),
        )
        .catch((e) => sendJson(res, 400, { ok: false, error: "Bad request", message: String(e?.message || e) }));
      return;
    }

    if (u.pathname === "/api/osm") {
      const s = Number(u.searchParams.get("s"));
      const w = Number(u.searchParams.get("w"));
      const n = Number(u.searchParams.get("n"));
      const e = Number(u.searchParams.get("e"));

      const lat = Number(u.searchParams.get("lat"));
      const lon = Number(u.searchParams.get("lon"));
      const radiusM = Math.max(100, Number(u.searchParams.get("radiusM") || "1500"));

      const useBBox = Number.isFinite(s) && Number.isFinite(w) && Number.isFinite(n) && Number.isFinite(e);
      const useCenter = Number.isFinite(lat) && Number.isFinite(lon);

      if (!useBBox && !useCenter) {
        sendJson(res, 400, { ok: false, error: "Invalid bbox or lat/lon" });
        return;
      }

      // Guardrail: avoid huge bbox requests (Overpass often 502s)
      if (useBBox) {
        const latSpan = Math.abs(n - s);
        const lonSpan = Math.abs(e - w);
        // Rough limit ~ city/metro scale. If user is zoomed out too much, ask them to zoom in.
        if (latSpan > 0.55 || lonSpan > 0.85) {
          sendJson(res, 400, {
            ok: false,
            error: "BBox too large",
            message: "Area troppo ampia. Zooma di più sulla città per caricare i parcheggi.",
          });
          return;
        }
      }

      // Serve cache if available, otherwise fetch.
      if (useBBox) {
        const cached = getCachedBBox(s, w, n, e);
        if (cached && !cached.stale) {
          sendJson(res, 200, { ok: true, json: cached.json, cached: true });
          return;
        }
      }

      const promise = useBBox ? fetchOverpassBBox(s, w, n, e) : fetchOverpass(lat, lon, radiusM);

      withTimeout(promise, 20_000, "Overpass timeout")
        .then((json) => {
          if (useBBox) setCachedBBox(s, w, n, e, json);
          sendJson(res, 200, { ok: true, json, cached: false });
        })
        .catch((e) => {
          // If Overpass fails, return cached stale data (or empty) with 200 so the browser fetch doesn't hard-fail.
          if (useBBox) {
            const cached = getCachedBBox(s, w, n, e);
            if (cached?.json) {
              sendJson(res, 200, {
                ok: true,
                json: cached.json,
                cached: true,
                warning: "Overpass unavailable; served cached data",
              });
              return;
            }
          }
          sendJson(res, 200, {
            ok: true,
            json: { elements: [] },
            warning: "Overpass unavailable; empty response",
            message: String(e?.message || e),
          });
        });
      return;
    }

    if (u.pathname === "/api/geocode") {
      const q = String(u.searchParams.get("q") || "").trim();
      if (!q || q.length < 3) {
        sendJson(res, 400, { ok: false, error: "Query too short" });
        return;
      }
      fetchNominatim(q)
        .then((results) => sendJson(res, 200, { ok: true, results }))
        .catch((e) =>
          sendJson(res, 502, { ok: false, error: "Geocode failed", message: String(e?.message || e) }),
        );
      return;
    }

    // Health / debug endpoint (no auth)
    if (u.pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        mode: DATABASE_URL ? "postgres" : "json",
        port: PORT,
        hasDatabaseUrl: Boolean(DATABASE_URL),
      });
      return;
    }

    // Notifications (PG only)
    if (u.pathname === "/api/notifications" && req.method === "GET") {
      requireAuth(req, res).then((s) => {
        if (!s) return;
        if (!DATABASE_URL) {
          sendJson(res, 200, { ok: true, notifications: [] });
          return;
        }
        const sinceMs = Number(u.searchParams.get("sinceMs") || "0");
        getStore()
          .then((st) => st.listNotifications({ userId: s.userId, sinceMs }))
          .then((notifications) => sendJson(res, 200, { ok: true, notifications }))
          .catch((e) => sendJson(res, 500, { ok: false, error: "DB error", message: String(e?.message || e) }));
      });
      return;
    }

    if (u.pathname === "/api/notifications/read" && req.method === "POST") {
      requireAuth(req, res).then((s) => {
        if (!s) return;
        if (!DATABASE_URL) {
          sendJson(res, 200, { ok: true });
          return;
        }
        readBody(req)
          .then((raw) => {
            const body = raw ? JSON.parse(raw) : {};
            const ids = Array.isArray(body.ids) ? body.ids : [];
            return getStore()
              .then((st) => st.markNotificationsRead({ userId: s.userId, ids }))
              .then(() => sendJson(res, 200, { ok: true }));
          })
          .catch((e) => sendJson(res, 400, { ok: false, error: "Bad request", message: String(e?.message || e) }));
      });
      return;
    }

    const urlPath = u.pathname === "/" ? "/index.html" : u.pathname || "/index.html";
    const filePath = safeJoin(WEB_ROOT, urlPath);

    if (!filePath.startsWith(WEB_ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const finalPath = stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const ext = path.extname(finalPath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";

    const buf = fs.readFileSync(finalPath);
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(500);
    res.end("Server error");
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Parking Finder MVP running on http://localhost:${PORT}`);
});

