// Shared helpers for YT Queue's server scripts (prepare-edit.mjs, render-edit.mjs, organize.mjs).
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
const envFile = join(HERE, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
export const API = (process.env.YQ_API || "https://yt-queue-api.thl007.workers.dev").replace(/\/+$/, "");
export const TOKEN = process.env.YQ_TOKEN;
export const VS = process.env.VLOG_STUDIO || "/home/projects/vlog-studio"; // faster-whisper venv + caption scripts

export const PRESETS = {
  "short-9x16": { w: 1080, h: 1920, defaultMax: 60 },
  "vlog-16x9": { w: 1920, h: 1080, defaultMax: null },
  "square-1x1": { w: 1080, h: 1080, defaultMax: 60 },
  "portrait-4x5": { w: 1080, h: 1350, defaultMax: 60 },
};
export const FPS = 30;
export const STILL_SECONDS = 3;
// Longest a single clip may run, by video type (null = keep the clip's own length).
export const PACE = { "montage": 1.6, "day-in-life": 2.8, "travel": 3.2, "food": 2.4, "grwm": 2.6, "tutorial": null, "cinematic": 5.5, "talking": null, "explainer": 4, "product": 3, "vlog": 3.5, "story": 3.5, "bts": 2.8, "event": 2.2, "city-walk": 4.5, "nature": 5, "workout": 2, "haul": 2.6, "home-tour": 3.2, "review": 3, "before-after": 2.4, "timelapse": 3, "sports": 1.8, "music-video": 1.8, "pets": 2.4, "family": 3, "qna": null, "comedy": 2.2, "trailer": 1.8, "interview": null, blank: null, custom: null };

export function die(msg) {
  console.error(msg);
  process.exit(1);
}
if (!TOKEN) die("YQ_TOKEN missing (worker/.env)");

export const argVal = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

export async function call(path, init = {}) {
  const res = await fetch(`${API}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
    duplex: init.body && typeof init.body !== "string" ? "half" : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`${init.method || "GET"} ${path}: ${data.error || res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

export const sign = async (keys) => (await call("/sign", { method: "POST", body: JSON.stringify({ keys }) })).urls;

/** Per-job context: progress patches, child processes, and stop-on-delete (the user deleted the job in the app). */
export function jobContext(jobId, work) {
  const CANCEL_EXIT = 3;
  const children = new Set();
  let cancelled = false;
  let watch = null;
  class Cancelled extends Error {}
  async function stopForCancel(reason) {
    if (cancelled) return;
    cancelled = true;
    if (watch) clearInterval(watch);
    for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
    rmSync(work, { recursive: true, force: true });
    if (reason !== "deleted") await call(`/jobs/${jobId}`, { method: "DELETE" }).catch(() => {});
    console.log(JSON.stringify({ ok: false, cancelled: true, jobId, reason }));
    console.error("CANCELLED by the user (deleted in the app). Stop: do not retry this job.");
    process.exit(CANCEL_EXIT);
  }
  async function checkCancel() {
    try {
      const res = await fetch(`${API}/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (res.status === 404) return stopForCancel("deleted");
      const d = await res.json().catch(() => ({}));
      if (d.job && d.job.status === "cancelling") return stopForCancel("cancelling");
    } catch {}
  }
  const patch = (body) => call(`/jobs/${jobId}`, { method: "PATCH", body: JSON.stringify(body) })
    .then((d) => (d && d.cancelling ? stopForCancel("cancelling") : d))
    .catch((e) => (e.status === 404 ? stopForCancel("deleted") : console.error("patch failed:", e.message)));
  function run(cmd, args) {
    return new Promise((resolve, reject) => {
      if (cancelled) return reject(new Cancelled("cancelled"));
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      children.add(p);
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => (children.delete(p), cancelled ? reject(new Cancelled("cancelled")) : code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.split("\n").slice(-6).join(" ")}`))));
    });
  }
  return {
    patch, run, checkCancel, stopForCancel, Cancelled,
    isCancelled: () => cancelled,
    startWatch: () => { watch = setInterval(checkCancel, 3000); },
    stopWatch: () => watch && clearInterval(watch),
  };
}

export async function probe(run, fileOrUrl) {
  const j = JSON.parse(await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", fileOrUrl]));
  const v = j.streams.find((s) => s.codec_type === "video" && !(s.disposition && s.disposition.attached_pic));
  const a = j.streams.find((s) => s.codec_type === "audio");
  const dur = Number(j.format.duration) || 0;
  const still = v && ["png", "mjpeg", "webp", "bmp", "tiff", "gif"].includes(v.codec_name) && !a && dur < 1;
  const rot = v ? Math.abs(Number((v.side_data_list || []).find((d) => "rotation" in d)?.rotation || 0)) % 180 === 90 : false;
  return {
    kind: still ? "image" : v ? "video" : a ? "audio" : "unknown",
    duration: dur, hasAudio: Boolean(a),
    width: v ? (rot ? v.height : v.width) : 0, height: v ? (rot ? v.width : v.height) : 0,
  };
}

export async function download(key, dest) {
  const urls = await sign([key]);
  const res = await fetch(urls[key]);
  if (!res.ok) throw new Error(`download ${key}: ${res.status} (moved or deleted? check the library)`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

export async function upload(file, key, contentType) {
  const PART = 10 * 1024 * 1024;
  const prefix = key.slice(0, key.lastIndexOf("/"));
  const name = key.slice(key.lastIndexOf("/") + 1);
  const { key: finalKey, uploadId } = await call("/uploads", { method: "POST", body: JSON.stringify({ name, contentType, prefix }) });
  const size = statSync(file).size;
  const parts = [];
  const fd = openSync(file, "r");
  try {
    for (let n = 1, off = 0; off < size || n === 1; n++, off += PART) {
      const len = Math.min(PART, size - off);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, off);
      parts.push(await call(`/uploads/part?key=${encodeURIComponent(finalKey)}&uploadId=${encodeURIComponent(uploadId)}&part=${n}`, { method: "PUT", body: buf }));
      if (off + PART >= size) break;
    }
  } finally {
    closeSync(fd);
  }
  await call("/uploads/complete", { method: "POST", body: JSON.stringify({ key: finalKey, uploadId, parts }) });
  return finalKey;
}

/** Local word-level transcript, then an .ass caption file sized for the format. file is null when there is no speech. */
export async function captionFile(run, work, media, w, h, lang) {
  const words = join(work, "words.json");
  const args = ["-I", join(VS, "scripts", "transcribe.py"), media, "-o", words];
  if (lang) args.push("--lang", lang);
  await run(join(VS, ".venv", "bin", "python"), args);
  const data = JSON.parse(readFileSync(words, "utf8"));
  if (!data.words || data.words.length < 2) return { file: null, words: 0, language: data.language };
  const ass = join(work, "caps.ass");
  const size = Math.round(Math.min(w, h) * (w > h ? 0.06 : 0.075));
  const y = w > h ? 0.86 : h / w > 1.5 ? 0.68 : 0.74;
  await run("python3", ["-I", join(VS, "scripts", "captions_ass.py"), words, "-o", ass, "--w", String(w), "--h", String(h), "--font", "Lato", "--size", String(size), "--y", String(y), "--max-words", "3", "--upper"]);
  return { file: ass, words: data.words.length, language: data.language };
}

export { dirname, join };
