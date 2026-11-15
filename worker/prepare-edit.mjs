#!/usr/bin/env node
// YT Boy's first pass: place the job's clips on a timeline and open it in the app's editor.
//   node worker/prepare-edit.mjs <jobId> [--type <id>] [--title "<title>"] [--max <seconds>] [--pace <s>] [--title-card]
//     Probes every clip straight from the bucket (no download), trims to the pace or the target length
//     (keeping the middle of each clip), turns an audio clip into the music bed, then saves the draft:
//     the job becomes "editing" and the user sees it in the editor.
//   node worker/prepare-edit.mjs <jobId> --get            print the current edit JSON (to refine it)
//   node worker/prepare-edit.mjs <jobId> --save <file>    save a refined edit JSON as the draft
// Exit codes: 0 ok, 1 failed, 3 cancelled (the user deleted the job: stop, don't retry).
import { readFileSync } from "node:fs";
import { argVal, call, die, jobContext, join, HERE, PACE, PRESETS, probe, sign, STILL_SECONDS } from "./lib.mjs";

const jobId = process.argv[2];
if (!jobId || !/^[A-Za-z0-9-]+$/.test(jobId)) die("usage: prepare-edit.mjs <jobId> [--get | --save <file> | options]");
const work = join(HERE, "..", "work", jobId);
const ctx = jobContext(jobId, work);

if (process.argv.includes("--get")) {
  const { edit } = await call(`/jobs/${jobId}/edit`);
  console.log(JSON.stringify(edit, null, 2));
  process.exit(0);
}
const saveFile = argVal("--save");
if (saveFile) {
  const edit = JSON.parse(readFileSync(saveFile, "utf8"));
  const r = await call(`/jobs/${jobId}/edit?draft=1`, { method: "PUT", body: JSON.stringify(edit) });
  console.log(JSON.stringify({ ok: true, jobId, status: r.job.status, clips: r.edit.clips.length, texts: r.edit.texts.length }));
  process.exit(0);
}

const argMax = Number(argVal("--max")) || null;
const argTitle = argVal("--title") || null;
const argType = argVal("--type") || null;
const argPace = Number(argVal("--pace")) || null;
const titleCard = process.argv.includes("--title-card");

try {
  const { job } = await call(`/jobs/${jobId}`);
  if (job.status === "cancelling") await ctx.stopForCancel("cancelling");
  ctx.startWatch();
  const preset = PRESETS[job.format] || PRESETS["vlog-16x9"];
  const title = job.title || argTitle || null;
  const type = job.type || argType || null;
  const target = job.maxSeconds || argMax || null;
  await ctx.patch({ status: "preparing", stage: "placing clips", progress: 0.1, phase: "draft", error: null, logLine: "draft started",
    ...(title && !job.title ? { title } : {}), ...(type && !job.type ? { type } : {}), ...(target && !job.maxSeconds ? { maxSeconds: target } : {}) });

  const urls = await sign(job.clips);
  const items = [];
  for (const [i, key] of job.clips.entries()) {
    if (!urls[key]) throw new Error(`clip not found: ${key}`);
    const info = await probe(ctx.run, urls[key]).catch((e) => { throw new Error(`can’t read ${key.split("/").pop()}: ${e.message.slice(0, 120)}`); });
    items.push({ key, ...info });
    await ctx.patch({ progress: 0.1 + 0.7 * ((i + 1) / job.clips.length), stage: `reading clip ${i + 1} of ${job.clips.length}` });
  }
  const visuals = items.filter((x) => x.kind === "video" || x.kind === "image");
  const audio = items.find((x) => x.kind === "audio");
  if (!visuals.length) throw new Error("no video or image clips in this job");

  // Length per clip: a set length is the target (trim in proportion); otherwise the type's pace.
  const own = visuals.map((v) => (v.kind === "image" ? STILL_SECONDS : Math.max(0.5, v.duration)));
  let lens;
  if (target) {
    const total = own.reduce((a, b) => a + b, 0);
    const k = total > target ? target / total : 1;
    lens = own.map((d) => Math.max(0.8, d * k));
  } else {
    const pace = argPace || (type ? PACE[type] ?? null : null);
    lens = visuals.map((v, i) => (pace ? Math.min(own[i], v.kind === "image" ? Math.min(STILL_SECONDS, pace + 0.6) : pace) : own[i]));
    const cap = preset.defaultMax;
    const total = lens.reduce((a, b) => a + b, 0);
    if (cap && total > cap) lens = lens.map((d) => Math.max(0.8, d * (cap / total)));
  }
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const clips = visuals.map((v, i) => {
    const len = lens[i];
    const start = v.kind === "video" && len < v.duration ? Math.max(0, (v.duration - len) / 2) : 0;
    return { id: `c${i + 1}`, key: v.key, kind: v.kind, duration: r3(v.duration), in: r3(start), out: r3(start + len), volume: 1, muted: !v.hasAudio };
  });
  const total = clips.reduce((a, c) => a + (c.out - c.in), 0);
  const texts = titleCard && title ? [{ id: "t1", text: title, start: 0, end: r3(Math.min(2.5, total)), position: "center", size: "l" }] : [];
  const edit = {
    version: 1, format: job.format, framing: job.framing || "fit", title, captions: Boolean(job.captions),
    fadeIn: 0.5, fadeOut: 0.6, clips, texts,
    music: audio ? { key: audio.key, volume: 0.6, start: 0, duck: true } : null,
    notes: type === "blank" ? "Blank: plain cut" : "",
  };
  const r = await call(`/jobs/${jobId}/edit?draft=1`, { method: "PUT", body: JSON.stringify(edit) });
  ctx.stopWatch();
  console.log(JSON.stringify({ ok: true, jobId, status: r.job.status, clips: clips.length, seconds: r3(total), music: Boolean(audio), title }));
} catch (e) {
  if (ctx.isCancelled() || e instanceof ctx.Cancelled) await new Promise(() => {});
  await ctx.checkCancel();
  await ctx.patch({ status: "failed", stage: "failed", phase: "draft", error: String(e.message || e).slice(0, 400), logLine: `draft failed: ${String(e.message || e).slice(0, 200)}` });
  console.error(`prepare-edit failed: ${e.stack || e}`);
  process.exit(1);
}
