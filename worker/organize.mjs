#!/usr/bin/env node
// YT Boy's B-roll sorter.
//   node worker/organize.mjs inspect [key ...]   (no keys = everything in broll/_inbox/)
//     -> makes a 3-frame contact sheet per clip in work/organize/, fills missing thumbnails,
//        prints JSON: existing folders + each clip's kind, duration and sheet path.
//   node worker/organize.mjs move plan.json
//     -> plan.json = [{ "key": "broll/_inbox/ab12cd-x.mp4", "folder": "Lisbon/Street" }, ...]
//        moves each clip (and its thumbnail) to broll/<folder>/<name without the random prefix>.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const envFile = join(HERE, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const API = (process.env.YQ_API || "https://yt-queue-api.thl007.workers.dev").replace(/\/+$/, "");
const TOKEN = process.env.YQ_TOKEN;
if (!TOKEN) fail("YQ_TOKEN missing (worker/.env)");

function fail(msg) {
  console.error(`organize: ${msg}`);
  process.exit(1);
}
async function call(path, init = {}) {
  const res = await fetch(`${API}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${data.error || res.status}`);
  return data;
}
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.split("\n").slice(-4).join(" ")))));
  });
}
async function listAll(prefix, acc = { folders: new Set(), files: [] }) {
  const r = await call(`/broll?prefix=${encodeURIComponent(prefix)}`);
  for (const f of r.files) acc.files.push(f);
  for (const f of r.folders) {
    acc.folders.add(f.prefix.slice("broll/".length, -1));
    await listAll(f.prefix, acc);
  }
  return acc;
}
const cleanFolder = (f) =>
  String(f).split("/").map((s) => s.replace(/[^A-Za-z0-9 ._\-()]/g, "").trim()).filter(Boolean).join("/").slice(0, 120);

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "inspect") {
  const all = await listAll("broll/");
  const keys = rest.length ? rest : all.files.filter((f) => f.key.startsWith("broll/_inbox/")).map((f) => f.key);
  const out = join(HERE, "..", "work", "organize");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const { urls } = keys.length ? await call("/sign", { method: "POST", body: JSON.stringify({ keys }) }) : { urls: {} };
  const clips = [];
  for (const [i, key] of keys.entries()) {
    const url = urls[key];
    const meta = all.files.find((f) => f.key === key);
    const info = { key, kind: "unknown", duration: 0, sheet: null, thumb: Boolean(meta?.thumb) };
    try {
      const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", url])).toString());
      const v = probe.streams.find((s) => s.codec_type === "video");
      const dur = Number(probe.format.duration) || 0;
      info.duration = Math.round(dur * 10) / 10;
      info.kind = v ? (["png", "mjpeg", "webp", "bmp", "tiff"].includes(v.codec_name) && dur < 1 ? "image" : "video") : probe.streams.some((s) => s.codec_type === "audio") ? "audio" : "unknown";
      if (info.kind === "video" || info.kind === "image") {
        const sheet = join(out, `${String(i).padStart(3, "0")}.jpg`);
        const pts = info.kind === "video" ? [0.15, 0.5, 0.85].map((f) => (dur * f).toFixed(2)) : ["0"];
        const frames = [];
        for (const [j, t] of pts.entries()) {
          const f = join(out, `${i}-${j}.jpg`);
          await run("ffmpeg", ["-y", "-v", "error", "-ss", t, "-i", url, "-frames:v", "1", "-vf", "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2", f]);
          frames.push(f);
        }
        const inputs = frames.flatMap((f) => ["-i", f]);
        await run("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", frames.length > 1 ? `hstack=inputs=${frames.length}` : "null", sheet]);
        frames.forEach((f) => rmSync(f, { force: true }));
        info.sheet = sheet;
        if (!info.thumb) {
          const jpg = await run("ffmpeg", ["-v", "error", "-ss", info.kind === "video" ? Math.min(1, dur / 3).toFixed(2) : "0", "-i", url, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "pipe:1"]);
          await fetch(`${API}/api/thumbs?key=${encodeURIComponent(key)}`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/jpeg" }, body: jpg });
          info.thumb = true;
        }
      }
    } catch (e) {
      info.error = String(e.message || e).slice(0, 200);
    }
    clips.push(info);
  }
  console.log(JSON.stringify({ folders: [...all.folders].filter((f) => f !== "_inbox").sort(), clips }, null, 2));
} else if (cmd === "move") {
  const plan = JSON.parse(readFileSync(rest[0], "utf8"));
  const moves = plan.map(({ key, folder }) => {
    const name = key.split("/").pop().replace(/^[a-f0-9]{6}-/, "");
    const f = cleanFolder(folder);
    if (!f || f === "_inbox") throw new Error(`bad folder for ${key}`);
    return { from: key, to: `broll/${f}/${name}` };
  });
  // Avoid overwriting an existing clip with the same name.
  const existing = new Set((await listAll("broll/")).files.map((f) => f.key));
  for (const m of moves) {
    let to = m.to;
    for (let n = 2; existing.has(to); n++) to = m.to.replace(/(\.[^./]+)?$/, `-${n}$1`);
    m.to = to;
    existing.add(to);
  }
  const r = await call("/broll/move", { method: "POST", body: JSON.stringify({ moves }) });
  console.log(JSON.stringify({ moved: r.moved, moves }, null, 2));
} else {
  fail("usage: organize.mjs inspect [key ...] | move plan.json");
}
