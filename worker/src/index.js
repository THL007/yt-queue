// YT Queue API — Cloudflare Worker bound to an R2 bucket.
// Flow: POST /jobs (queued) -> YT Boy prepares a draft (preparing -> editing, jobs/<id>/edit.json)
//       -> the user edits in the app (PUT /jobs/<id>/edit) -> POST /jobs/<id>/export (exporting)
//       -> YT Boy renders the edit (running -> done | failed).
// Auth: `Authorization: Bearer <APP_TOKEN>` on every /api route.
// Files are read through short-lived HMAC-signed URLs (/f/<key>?exp=&sig=), so <video> tags work.

const JSON_HEADERS = { "content-type": "application/json" };
const FORMATS = ["short-9x16", "vlog-16x9", "square-1x1", "portrait-4x5"];
const TYPES = ["montage", "day-in-life", "travel", "food", "grwm", "tutorial", "cinematic", "talking", "explainer", "product", "vlog", "story", "bts", "event", "city-walk", "nature", "workout", "haul", "home-tour", "review", "before-after", "timelapse", "sports", "music-video", "pets", "family", "qna", "comedy", "trailer", "interview", "blank", "custom"];

function cors(env, res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", env.ALLOWED_ORIGIN || "*");
  h.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  h.set("access-control-allow-headers", "authorization,content-type");
  h.set("access-control-expose-headers", "content-length,content-range,etag");
  h.set("vary", "origin");
  return new Response(res.body, { status: res.status, headers: h });
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const err = (message, status = 400) => json({ error: message }, status);

// Secrets come from Worker secrets, or from config/secrets.json in the bucket (written once by /api/setup).
let CONFIG = null;
async function loadConfig(env) {
  if (CONFIG && CONFIG.at > Date.now() - 30000) return CONFIG;
  const obj = await env.BUCKET.get("config/secrets.json");
  const stored = obj ? await obj.json() : {};
  CONFIG = {
    appToken: stored.appToken || "",
    renderToken: stored.renderToken || "",
    webhookSecret: env.WEBHOOK_SECRET || stored.webhookSecret || "",
    at: Date.now(),
  };
  return CONFIG;
}
async function saveConfig(env, cfg) {
  const { appToken, renderToken, webhookSecret } = cfg;
  await env.BUCKET.put("config/secrets.json", JSON.stringify({ appToken, renderToken, webhookSecret }), { httpMetadata: { contentType: "application/json" } });
  CONFIG = null;
}
function bearerOk(auth, cfg) {
  return Boolean((cfg.appToken && safeEqual(auth, `Bearer ${cfg.appToken}`)) || (cfg.renderToken && safeEqual(auth, `Bearer ${cfg.renderToken}`)));
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function validKey(key) {
  return typeof key === "string" && /^(broll|jobs|thumbs)\/[A-Za-z0-9._\-\/ ()]+$/.test(key) && !key.includes("..") && key.length < 512;
}
function newId() {
  const t = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${t}-${crypto.randomUUID().slice(0, 8)}`;
}

async function signUrl(env, origin, key, ttl = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = await hmacHex((await loadConfig(env)).renderToken, `${key}:${exp}`);
  return `${origin}/f/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
}

async function readJob(env, id) {
  const obj = await env.BUCKET.get(`jobs/${id}/job.json`);
  return obj ? await obj.json() : null;
}
async function writeJob(env, job) {
  job.updatedAt = new Date().toISOString();
  await env.BUCKET.put(`jobs/${job.id}/job.json`, JSON.stringify(job, null, 2), { httpMetadata: { contentType: "application/json" } });
  return job;
}

const KEEP = ".keep";
async function deletePrefix(env, prefix) {
  let n = 0;
  for (;;) {
    const page = await env.BUCKET.list({ prefix, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (!keys.length) return n;
    await env.BUCKET.delete(keys);
    n += keys.filter((k) => !k.endsWith(KEEP)).length;
    if (!page.truncated) return n;
  }
}

async function deleteJobFiles(env, id) {
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: `jobs/${id}/`, cursor });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function fireEvent(env, type, data, id) {
  const cfg = await loadConfig(env);
  if (!env.WEBHOOK_URL || !cfg.webhookSecret) return { sent: false, reason: "webhook not configured" };
  const body = JSON.stringify({ type, occurredAt: new Date().toISOString(), data });
  const ts = Math.floor(Date.now() / 1000).toString();
  const delivery = `${id}-${ts}`;
  const sig = await hmacHex(cfg.webhookSecret, `${ts}.${delivery}.${body}`);
  const res = await fetch(env.WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openbot-timestamp": ts, "x-openbot-delivery-id": delivery, "x-openbot-signature": `sha256=${sig}` },
    body,
  });
  return { sent: res.status === 202 || res.status === 200, status: res.status };
}
function fireWebhook(env, job) {
  return fireEvent(env, "yt.job.created", {
    jobId: job.id, format: job.format, type: job.type || null, customType: job.customType || null, title: job.title, maxSeconds: job.maxSeconds, captions: job.captions, framing: job.framing || "fit", notes: job.notes, clips: job.clips,
  }, `job-${job.id}`);
}

function fireExport(env, job) {
  return fireEvent(env, "yt.job.export", { jobId: job.id, format: job.format, title: job.title }, `export-${job.id}`);
}

// ---- the edit: a timeline the agent drafts and the user changes
const EDIT_LIMIT = 300 * 1024;
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, n) => (v == null ? "" : String(v)).slice(0, n);
const TRANSITIONS = ["fade", "dissolve", "fadeblack", "fadewhite", "slideleft", "slideright", "slideup", "slidedown", "wipeleft", "wiperight", "circleopen", "circleclose", "zoomin", "hblur", "pixelize", "radial", "smoothleft", "squeezeh"];
const TEXT_FONTS = ["barlow", "anton", "bebas", "marker", "pacifico", "archivo"];
function cleanEdit(e) {
  if (!e || typeof e !== "object" || !Array.isArray(e.clips)) throw new Error("edit needs a clips array");
  const clips = e.clips.slice(0, 300).filter((c) => c && validKey(c.key) && c.key.startsWith("broll/")).map((c, i) => {
    const duration = num(c.duration, 0, 36000, 0);
    const kind = c.kind === "image" ? "image" : "video";
    const max = kind === "image" ? 3600 : duration || 36000;
    const inP = num(c.in, 0, max, 0);
    const outP = num(c.out, inP + 0.1, kind === "image" ? 3600 : max, inP + 3);
    const tr = c.transition && TRANSITIONS.includes(c.transition.type) ? { type: c.transition.type, duration: num(c.transition.duration, 0.1, 3, 0.6) } : null;
    return { id: str(c.id || `c${i}`, 40), key: c.key, kind, duration, in: inP, out: outP, volume: num(c.volume, 0, 2, 1), muted: Boolean(c.muted), detached: Boolean(c.detached), transition: tr };
  });
  const texts = (Array.isArray(e.texts) ? e.texts : []).slice(0, 100).map((t, i) => ({
    id: str(t.id || `t${i}`, 40), text: str(t.text, 200), start: num(t.start, 0, 36000, 0), end: num(t.end, 0, 36000, 3),
    position: ["top", "center", "bottom"].includes(t.position) ? t.position : "bottom", size: ["s", "m", "l"].includes(t.size) ? t.size : "m",
    font: TEXT_FONTS.includes(t.font) ? t.font : "barlow",
  })).filter((t) => t.text && t.end > t.start);
  const music = e.music && validKey(e.music.key) && e.music.key.startsWith("broll/")
    ? { key: e.music.key, volume: num(e.music.volume, 0, 2, 0.6), start: num(e.music.start, 0, 36000, 0), duck: e.music.duck !== false }
    : null;
  // Separate sound items (detached clip sound, or sound from any library file) on the audio track.
  const audios = (Array.isArray(e.audios) ? e.audios : []).slice(0, 100).filter((a) => a && validKey(a.key) && a.key.startsWith("broll/")).map((a, i) => {
    const duration = num(a.duration, 0, 36000, 0);
    const inP = num(a.in, 0, duration || 36000, 0);
    return { id: str(a.id || `a${i}`, 40), key: a.key, duration, in: inP, out: num(a.out, inP + 0.1, duration || 36000, inP + 3), start: num(a.start, 0, 36000, 0),
      volume: num(a.volume, 0, 2, 1), muted: Boolean(a.muted), fromClip: a.fromClip ? str(a.fromClip, 40) : null };
  });
  return {
    version: 2,
    format: FORMATS.includes(e.format) ? e.format : "vlog-16x9",
    framing: e.framing === "fill" ? "fill" : "fit",
    title: str(e.title, 140) || null,
    captions: Boolean(e.captions),
    fadeIn: num(e.fadeIn, 0, 5, 0.5), fadeOut: num(e.fadeOut, 0, 5, 0.6),
    clips, texts, music, audios,
    notes: str(e.notes, 2000),
  };
}
async function readJson(env, key) {
  const o = await env.BUCKET.get(key);
  return o ? await o.json() : null;
}
async function writeJson(env, key, data) {
  await env.BUCKET.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
}

const thumbKey = (key) => `thumbs/${key}.jpg`;
async function moveObject(env, from, to) {
  if (from === to) return;
  const obj = await env.BUCKET.get(from);
  if (!obj) throw new Error(`not found: ${from}`);
  const { readable, writable } = new FixedLengthStream(obj.size);
  obj.body.pipeTo(writable);
  await env.BUCKET.put(to, readable, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
  await env.BUCKET.delete(from);
}

async function serveFile(request, env, url) {
  const key = decodeURIComponent(url.pathname.slice(3));
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  if (!validKey(key) || !exp || exp < Date.now() / 1000) return err("expired or invalid link", 403);
  const cfg = await loadConfig(env);
  if (!cfg.renderToken || !safeEqual(sig, await hmacHex(cfg.renderToken, `${key}:${exp}`))) return err("bad signature", 403);

  const range = request.headers.get("range");
  let opts = {};
  let m;
  if (range && (m = /bytes=(\d*)-(\d*)/.exec(range))) {
    const head = await env.BUCKET.head(key);
    if (!head) return err("not found", 404);
    const start = m[1] ? Number(m[1]) : head.size - Number(m[2]);
    const end = m[1] && m[2] ? Number(m[2]) : head.size - 1;
    opts.range = { offset: start, length: end - start + 1 };
    const obj = await env.BUCKET.get(key, opts);
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set("content-range", `bytes ${start}-${end}/${head.size}`);
    h.set("content-length", String(end - start + 1));
    h.set("accept-ranges", "bytes");
    return new Response(obj.body, { status: 206, headers: h });
  }
  const obj = await env.BUCKET.get(key);
  if (!obj) return err("not found", 404);
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("content-length", String(obj.size));
  h.set("accept-ranges", "bytes");
  if (url.searchParams.get("download")) h.set("content-disposition", `attachment; filename="${key.split("/").pop()}"`);
  return new Response(obj.body, { headers: h });
}

async function api(request, env, url) {
  const cfg = await loadConfig(env);
  const auth = request.headers.get("authorization") || "";
  const p = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  // Public: tells the app whether to show "create token" or "sign in".
  if (p === "/status" && method === "GET") return json({ ready: Boolean(cfg.renderToken), appTokenSet: Boolean(cfg.appToken), webhook: Boolean(cfg.webhookSecret) });

  // Render server claims the API once (open only while no render token exists).
  if (p === "/setup/render" && method === "POST") {
    if (cfg.renderToken) return err("already claimed", 403);
    const b = await request.json();
    if (!b.renderToken || b.renderToken.length < 24) return err("renderToken too short");
    await saveConfig(env, { ...cfg, renderToken: b.renderToken });
    return json({ ok: true });
  }

  // The app sets its token (open only while none is set) and the webhook secret.
  if (p === "/setup/app" && method === "POST") {
    if (!cfg.renderToken) return err("API not claimed by the render server yet", 409);
    if (cfg.appToken && !bearerOk(auth, cfg)) return err("already set up: sign in with your token", 403);
    const b = await request.json();
    const next = { ...cfg };
    if (b.appToken) {
      if (String(b.appToken).length < 12) return err("Use at least 12 characters for the token.");
      next.appToken = String(b.appToken);
    }
    if (b.webhookSecret) next.webhookSecret = String(b.webhookSecret).trim();
    if (!next.appToken) return err("Set an access token first.");
    await saveConfig(env, next);
    return json({ ok: true, webhook: Boolean(next.webhookSecret) });
  }

  if (!bearerOk(auth, cfg)) return err("unauthorized", 401);
  if (p === "/health") return json({ ok: true, webhook: Boolean(env.WEBHOOK_URL && cfg.webhookSecret), formats: FORMATS, types: TYPES });

  // ---- multipart upload (chunks go through the Worker; no bucket keys in the browser)
  if (p === "/uploads" && method === "POST") {
    const { name, contentType, prefix } = await request.json();
    const clean = String(name || "clip").replace(/[^A-Za-z0-9._\- ()]/g, "_").slice(-120);
    const key = prefix && validKey(`${prefix}/x`) ? `${prefix}/${clean}` : `broll/_inbox/${crypto.randomUUID().slice(0, 6)}-${clean}`;
    const mpu = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: contentType || "application/octet-stream" } });
    return json({ key, uploadId: mpu.uploadId });
  }
  let m;
  if ((m = /^\/uploads\/part$/.exec(p)) && method === "PUT") {
    const key = url.searchParams.get("key");
    const uploadId = url.searchParams.get("uploadId");
    const part = Number(url.searchParams.get("part"));
    if (!validKey(key) || !uploadId || !(part >= 1)) return err("bad part request");
    const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
    const res = await mpu.uploadPart(part, request.body);
    return json(res);
  }
  if (p === "/uploads/complete" && method === "POST") {
    const { key, uploadId, parts } = await request.json();
    if (!validKey(key)) return err("bad key");
    const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
    const obj = await mpu.complete(parts);
    return json({ key, size: obj.size });
  }
  if (p === "/uploads/abort" && method === "POST") {
    const { key, uploadId } = await request.json();
    if (!validKey(key)) return err("bad key");
    await env.BUCKET.resumeMultipartUpload(key, uploadId).abort();
    return json({ ok: true });
  }

  // ---- b-roll library: one folder level at a time (lazy), with signed thumbnail links
  if (p === "/broll" && method === "GET") {
    let prefix = url.searchParams.get("prefix") || "broll/";
    if (!prefix.endsWith("/")) prefix += "/";
    if (!prefix.startsWith("broll/") || !validKey(prefix + "x")) return err("bad prefix");
    const folders = [];
    const files = [];
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix, delimiter: "/", cursor, limit: 1000 });
      for (const f of page.delimitedPrefixes) folders.push({ prefix: f, name: f.slice(prefix.length, -1) });
      for (const o of page.objects) if (!o.key.endsWith(KEEP)) files.push({ key: o.key, size: o.size, uploaded: o.uploaded });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && files.length < 2000);
    const thumbs = new Set();
    cursor = undefined;
    do {
      const page = await env.BUCKET.list({ prefix: `thumbs/${prefix}`, delimiter: "/", cursor, limit: 1000 });
      for (const o of page.objects) thumbs.add(o.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (const f of files) f.thumb = thumbs.has(thumbKey(f.key)) ? await signUrl(env, url.origin, thumbKey(f.key), 6 * 3600) : null;
    files.sort((a, b) => (a.uploaded < b.uploaded ? 1 : -1));
    folders.sort((a, b) => (a.name === "_inbox" ? -1 : b.name === "_inbox" ? 1 : a.name.localeCompare(b.name)));
    return json({ prefix, folders, files });
  }
  // ---- folders. R2 has no folders: an empty one is kept alive by a hidden ".keep" object.
  if (p === "/broll/folders" && method === "GET") {
    const set = new Set();
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix: "broll/", cursor, limit: 1000 });
      for (const o of page.objects) {
        const parts = o.key.split("/").slice(1, -1);
        for (let i = 1; i <= parts.length; i++) set.add(`broll/${parts.slice(0, i).join("/")}/`);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ folders: [...set].sort((a, b) => a.localeCompare(b)) });
  }
  if (p === "/broll/folder" && method === "POST") {
    const b = await request.json();
    const parent = String(b.parent || "broll/");
    const name = String(b.name || "").trim().replace(/[^A-Za-z0-9._\- ()]+/g, "-").replace(/^[.\- ]+|[.\- ]+$/g, "").slice(0, 60);
    if (!name) return err("Give the folder a name.");
    if (!parent.startsWith("broll/") || !parent.endsWith("/") || parent.startsWith("broll/_inbox/")) return err("bad parent folder");
    const prefix = `${parent}${name}/`;
    if (!validKey(prefix + KEEP) || prefix.split("/").length > 8) return err("That folder name or depth isn't allowed.");
    await env.BUCKET.put(prefix + KEEP, "", { httpMetadata: { contentType: "text/plain" } });
    return json({ folder: { prefix, name } }, 201);
  }
  if (p === "/broll/folder" && method === "DELETE") {
    const prefix = url.searchParams.get("prefix") || "";
    if (!prefix.startsWith("broll/") || !prefix.endsWith("/") || prefix === "broll/" || !validKey(prefix + "x")) return err("bad folder");
    const n = await deletePrefix(env, prefix);
    await deletePrefix(env, `thumbs/${prefix}`);
    return json({ deleted: n });
  }
  // Clear all materials (every clip, folder and thumbnail). Finished videos in jobs/ stay.
  if (p === "/broll/all" && method === "DELETE") {
    if (url.searchParams.get("confirm") !== "DELETE") return err("confirm=DELETE required");
    const n = await deletePrefix(env, "broll/");
    await deletePrefix(env, "thumbs/broll/");
    return json({ deleted: n });
  }
  if (p === "/broll" && method === "DELETE") {
    const key = url.searchParams.get("key");
    if (!validKey(key) || !key.startsWith("broll/")) return err("bad key");
    await env.BUCKET.delete([key, thumbKey(key)]);
    return json({ ok: true });
  }
  // Thumbnail for a clip (small JPEG from the browser or the render server).
  if (p === "/thumbs" && method === "PUT") {
    const key = url.searchParams.get("key");
    if (!validKey(key) || !key.startsWith("broll/")) return err("bad key");
    const len = Number(request.headers.get("content-length") || 0);
    if (len > 2 * 1024 * 1024) return err("thumbnail too large");
    await env.BUCKET.put(thumbKey(key), request.body, { httpMetadata: { contentType: "image/jpeg" } });
    return json({ ok: true });
  }
  // Move clips into folders (used by YT Boy when sorting the inbox). Thumbnails move along.
  if (p === "/broll/move" && method === "POST") {
    const { moves } = await request.json();
    const done = [];
    for (const mv of (moves || []).slice(0, 200)) {
      if (!validKey(mv.from) || !validKey(mv.to) || !mv.from.startsWith("broll/") || !mv.to.startsWith("broll/")) return err(`bad move ${mv.from}`);
      await moveObject(env, mv.from, mv.to);
      if (await env.BUCKET.head(thumbKey(mv.from))) await moveObject(env, thumbKey(mv.from), thumbKey(mv.to));
      done.push(mv);
    }
    return json({ moved: done.length });
  }
  // Ask YT Boy to sort new uploads into folders.
  if (p === "/broll/organize" && method === "POST") {
    const { keys } = await request.json();
    const list = (keys || []).filter((k) => validKey(k) && k.startsWith("broll/")).slice(0, 200);
    if (!list.length) return err("no keys");
    const hook = await fireEvent(env, "yt.broll.uploaded", { keys: list }, `org-${crypto.randomUUID().slice(0, 8)}`);
    return json({ webhook: hook });
  }

  // ---- signed read links
  if (p === "/sign" && method === "POST") {
    const { keys } = await request.json();
    const out = {};
    for (const k of (keys || []).slice(0, 200)) if (validKey(k)) out[k] = await signUrl(env, url.origin, k);
    return json({ urls: out });
  }

  // ---- jobs
  if (p === "/jobs" && method === "GET") {
    const ids = new Set();
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix: "jobs/", delimiter: "/", cursor });
      for (const pre of page.delimitedPrefixes) ids.add(pre.split("/")[1]);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const jobs = (await Promise.all([...ids].sort().reverse().slice(0, 100).map((id) => readJob(env, id)))).filter(Boolean);
    return json({ jobs });
  }
  if (p === "/jobs" && method === "POST") {
    const b = await request.json();
    const clips = (b.clips || []).filter((k) => validKey(k) && k.startsWith("broll/"));
    if (!clips.length) return err("pick at least one clip");
    if (!FORMATS.includes(b.format)) return err("unknown format");
    const job = {
      id: newId(),
      title: b.title ? String(b.title).slice(0, 140) : null,
      notes: String(b.notes || "").slice(0, 4000),
      format: b.format,
      type: TYPES.includes(b.type) ? b.type : null,
      customType: b.type === "custom" && b.customType ? String(b.customType).slice(0, 200) : null,
      maxSeconds: Math.min(Math.max(Number(b.maxSeconds) || 0, 0), 1800) || null,
      captions: Boolean(b.captions),
      framing: b.framing === "fill" ? "fill" : "fit",
      music: b.music && validKey(b.music) ? b.music : null,
      clips,
      status: "queued",
      phase: "draft",
      progress: 0,
      createdAt: new Date().toISOString(),
      output: null,
      thumbnail: null,
      error: null,
      log: [],
    };
    await writeJob(env, job);
    const hook = await fireWebhook(env, job);
    job.webhook = hook;
    if (!hook.sent) job.log.push(`webhook not delivered: ${hook.reason || hook.status}`);
    await writeJob(env, job);
    return json({ job }, 201);
  }
  if ((m = /^\/jobs\/([A-Za-z0-9\-]+)\/(edit|export)$/.exec(p))) {
    const job = await readJob(env, m[1]);
    if (!job) return err("job not found", 404);
    const editKey = `jobs/${job.id}/edit.json`, draftKey = `jobs/${job.id}/draft.json`;
    if (m[2] === "edit" && method === "GET") {
      const edit = await readJson(env, url.searchParams.get("draft") ? draftKey : editKey);
      return edit ? json({ edit, job }) : err("no draft yet", 404);
    }
    if (m[2] === "edit" && method === "PUT") {
      if (["exporting", "running", "cancelling"].includes(job.status)) return err("this video is exporting; wait until it is done", 409);
      const len = Number(request.headers.get("content-length") || 0);
      if (len > EDIT_LIMIT) return err("edit too large", 413);
      let edit;
      try { edit = cleanEdit(await request.json()); } catch (e) { return err(String(e.message || e)); }
      await writeJson(env, editKey, edit);
      // The agent saves its draft with ?draft=1: keep a copy the user can reset to, and open the editor.
      if (url.searchParams.get("draft")) {
        await writeJson(env, draftKey, edit);
        job.status = "editing"; job.stage = "ready to edit"; job.progress = 0; job.error = null;
        job.log = [...(job.log || []), `${new Date().toISOString()} draft ready: ${edit.clips.length} clips`].slice(-50);
      }
      if (edit.title) job.title = edit.title;
      job.format = edit.format; job.framing = edit.framing; job.captions = edit.captions;
      job.editedAt = new Date().toISOString();
      await writeJob(env, job);
      return json({ ok: true, edit, job });
    }
    if (m[2] === "export" && method === "POST") {
      if (!["editing", "failed", "done"].includes(job.status)) return err(`can’t export while ${job.status}`, 409);
      if (!(await env.BUCKET.head(editKey))) return err("no draft to export", 409);
      job.status = "exporting"; job.stage = "export queued"; job.progress = 0; job.error = null; job.phase = "export";
      job.exportRequestedAt = new Date().toISOString();
      await writeJob(env, job);
      const hook = await fireExport(env, job);
      job.webhook = hook;
      if (!hook.sent) job.log = [...(job.log || []), `export webhook not delivered: ${hook.reason || hook.status}`].slice(-50);
      return json({ job: await writeJob(env, job) });
    }
    return err("not found", 404);
  }
  if ((m = /^\/jobs\/([A-Za-z0-9\-]+)$/.exec(p))) {
    const job = await readJob(env, m[1]);
    if (!job) return err("job not found", 404);
    if (method === "GET") return json({ job });
    if (method === "DELETE") {
      // Running: ask the render worker to stop; it deletes the job when it has stopped.
      // Anything else (or a second delete of a stuck "cancelling" job): delete now.
      if (job.status === "running") {
        job.status = "cancelling"; job.stage = "stopping"; job.cancelRequestedAt = new Date().toISOString();
        job.log = [...(job.log || []), `${job.cancelRequestedAt} delete requested while rendering`].slice(-50);
        return json({ job: await writeJob(env, job), cancelling: true }, 202);
      }
      await deleteJobFiles(env, job.id);
      return json({ deleted: true, id: job.id });
    }
    if (method === "PATCH") {
      const b = await request.json();
      // A delete was requested: keep the job stopping, ignore progress from the worker.
      if (job.status === "cancelling") return json({ job, cancelling: true });
      for (const k of ["status", "progress", "output", "thumbnail", "error", "durationSeconds", "stage", "title", "maxSeconds", "type", "customType", "framing", "phase"]) if (k in b) job[k] = b[k];
      if (b.logLine) job.log = [...(job.log || []), `${new Date().toISOString()} ${String(b.logLine).slice(0, 300)}`].slice(-50);
      return json({ job: await writeJob(env, job) });
    }
    if (method === "POST" && url.searchParams.get("action") === "retry") {
      if (job.status === "cancelling") return err("this video is being deleted", 409);
      // A failed export re-exports the saved edit; a failed draft asks YT Boy for a new draft.
      if (job.phase === "export" && (await env.BUCKET.head(`jobs/${job.id}/edit.json`))) {
        job.status = "exporting"; job.stage = "export queued"; job.error = null; job.progress = 0;
        await writeJob(env, job);
        job.webhook = await fireExport(env, job);
        return json({ job: await writeJob(env, job) });
      }
      job.status = "queued"; job.error = null; job.progress = 0; job.phase = "draft";
      await writeJob(env, job);
      job.webhook = await fireWebhook(env, { ...job, id: job.id });
      return json({ job: await writeJob(env, job) });
    }
  }
  return err("not found", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));
    try {
      if (url.pathname.startsWith("/f/")) return cors(env, await serveFile(request, env, url));
      if (url.pathname.startsWith("/api/")) return cors(env, await api(request, env, url));
      return cors(env, json({ name: "yt-queue-api" }));
    } catch (e) {
      return cors(env, err(String(e && e.message ? e.message : e), 500));
    }
  },
};
