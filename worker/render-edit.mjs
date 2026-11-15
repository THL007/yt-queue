#!/usr/bin/env node
// Render a YT Queue job exactly as the user left it in the editor (jobs/<id>/edit.json).
//   node worker/render-edit.mjs <jobId> [--keep]
// Per clip: its in/out, volume or mute, framed to the format ("fit" = whole shot over a blurred copy,
// "fill" = crop). Then: text overlays at their times and positions, music bed (volume, start offset,
// ducked under clip sound), burned captions when asked and there is speech, fades, -14 LUFS.
// Exit codes: 0 done, 1 failed, 3 cancelled (the user deleted the job: stop, don't retry).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { call, captionFile, die, download, FPS, HERE, jobContext, join, PRESETS, probe, upload } from "./lib.mjs";

const jobId = process.argv[2];
if (!jobId || !/^[A-Za-z0-9-]+$/.test(jobId)) die("usage: render-edit.mjs <jobId> [--keep]");
const keep = process.argv.includes("--keep");
const work = join(HERE, "..", "work", jobId);
const ctx = jobContext(jobId, work);
const { run, patch } = ctx;
const FONT = join(HERE, "fonts", "Barlow-SemiBold.ttf");

// Wrap overlay text into lines that fit the frame (drawtext does not wrap).
function wrap(text, maxChars) {
  const out = [];
  for (const para of text.split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && (line + " " + word).length > maxChars) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out.join("\n");
}

try {
  const first = await fetch(`${process.env.YQ_API || "https://yt-queue-api.thl007.workers.dev"}/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${process.env.YQ_TOKEN}` } }).catch(() => null);
  if (first && first.status === 404) await ctx.stopForCancel("deleted");
  const { edit, job } = await call(`/jobs/${jobId}/edit`);
  if (job.status === "cancelling") await ctx.stopForCancel("cancelling");
  ctx.startWatch();
  const preset = PRESETS[edit.format] || PRESETS["vlog-16x9"];
  const { w, h } = preset;
  if (!edit.clips.length) throw new Error("the timeline is empty: add at least one clip in the editor");

  await patch({ status: "running", phase: "export", stage: "downloading clips", progress: 0.04, error: null, logLine: `export started: ${edit.clips.length} clips` });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  // Download each source once.
  const keys = [...new Set([...edit.clips.map((c) => c.key), ...(edit.music ? [edit.music.key] : [])])];
  const files = {};
  for (const [i, key] of keys.entries()) {
    const ext = (key.match(/\.[A-Za-z0-9]{1,5}$/) || [".bin"])[0].toLowerCase();
    files[key] = join(work, `src-${String(i).padStart(3, "0")}${ext}`);
    await download(key, files[key]);
    await patch({ progress: 0.04 + 0.2 * ((i + 1) / keys.length), stage: `downloaded ${i + 1} of ${keys.length}` });
  }

  const tail = `setsar=1,fps=${FPS},format=yuv420p`;
  const fillVf = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},${tail}`;
  const bw = Math.round(w / 4 / 2) * 2, bh = Math.round(h / 4 / 2) * 2;
  const fitVf = `split[a][b];[a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=12:2,eq=brightness=-0.06:saturation=1.1,scale=${w}:${h}[bg];` +
    `[b]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${tail}`;

  const segs = [];
  for (const [i, c] of edit.clips.entries()) {
    const info = await probe(run, files[c.key]);
    const len = Math.max(0.1, c.out - c.in);
    const shapeOk = info.width && Math.abs(info.width / info.height / (w / h) - 1) <= 0.08;
    const frame = edit.framing === "fill" || shapeOk ? fillVf : fitVf;
    const seg = join(work, `seg-${String(i).padStart(3, "0")}.mp4`);
    const args = ["-y", "-hide_banner"];
    if (c.kind === "image" || info.kind === "image") args.push("-loop", "1", "-t", len.toFixed(3), "-i", files[c.key]);
    else args.push("-ss", c.in.toFixed(3), "-t", len.toFixed(3), "-i", files[c.key]);
    args.push("-f", "lavfi", "-t", len.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    const useOwn = info.kind === "video" && info.hasAudio && !c.muted && c.volume > 0;
    const vf = info.kind === "image" ? `${frame},zoompan=z='min(zoom+0.0008,1.08)':d=${Math.ceil(len * FPS)}:s=${w}x${h}:fps=${FPS}` : frame;
    args.push("-map", "0:v:0", "-map", useOwn ? "0:a:0" : "1:a:0", "-vf", vf,
      "-af", `aresample=48000,aformat=channel_layouts=stereo${useOwn ? `,volume=${c.volume}` : ""}`, "-t", len.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", seg);
    await run("ffmpeg", args);
    segs.push(seg);
    await patch({ progress: 0.24 + 0.46 * ((i + 1) / edit.clips.length), stage: `cutting clip ${i + 1} of ${edit.clips.length}` });
  }

  await patch({ stage: "joining", progress: 0.72 });
  const list = join(work, "list.txt");
  writeFileSync(list, segs.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));
  const joined = join(work, "joined.mp4");
  await run("ffmpeg", ["-y", "-hide_banner", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  const dur = (await probe(run, joined)).duration;

  // Video filters: fades, text overlays, captions.
  const vf = [];
  if (edit.fadeIn > 0) vf.push(`fade=t=in:st=0:d=${Math.min(edit.fadeIn, dur / 3).toFixed(2)}`);
  if (edit.fadeOut > 0) vf.push(`fade=t=out:st=${Math.max(0, dur - edit.fadeOut).toFixed(3)}:d=${Math.min(edit.fadeOut, dur / 3).toFixed(2)}`);
  const unit = Math.min(w, h);
  const sizes = { s: 0.045, m: 0.065, l: 0.095 };
  for (const [i, t] of (edit.texts || []).entries()) {
    if (t.start >= dur) continue;
    const size = Math.round(unit * (sizes[t.size] || sizes.m));
    // One drawtext per line (a newline inside drawtext prints a missing-glyph box with some fonts).
    const lines = wrap(t.text, Math.max(8, Math.floor((w * 0.86) / (size * 0.52)))).split("\n");
    const pad = Math.round(size * 0.3);
    const lineH = Math.round(size * 1.2) + pad * 2;
    const blockH = lines.length * lineH;
    const y0 = t.position === "top" ? Math.round(h * 0.08) : t.position === "center" ? Math.round((h - blockH) / 2) : Math.round(h - h * 0.12 - blockH);
    const enable = `between(t,${t.start.toFixed(2)},${Math.min(t.end, dur).toFixed(2)})`;
    lines.forEach((line, j) => {
      const tf = join(work, `text-${i}-${j}.txt`);
      writeFileSync(tf, line);
      vf.push(`drawtext=fontfile='${FONT}':textfile='${tf}':expansion=none:fontsize=${size}:fontcolor=white:` +
        `box=1:boxcolor=black@0.45:boxborderw=${pad}:x=(w-text_w)/2:y=${y0 + j * lineH + pad}:enable='${enable}'`);
    });
  }
  let captionNote = null;
  if (edit.captions) {
    await patch({ stage: "transcribing for captions", progress: 0.75 });
    try {
      const c = await captionFile(run, work, joined, w, h, null);
      if (c.file) { vf.push(`ass=${c.file}`); captionNote = `captions: ${c.words} words (${c.language})`; }
      else captionNote = "captions: no speech found, so none were burned in";
    } catch (e) {
      captionNote = `captions failed: ${String(e.message || e).slice(0, 160)}`;
    }
    await patch({ logLine: captionNote });
  }
  const vchain = vf.length ? vf.join(",") : "null";

  await patch({ stage: "mixing and encoding", progress: 0.8 });
  const out = join(work, "output.mp4");
  const enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
  const afadeOut = edit.fadeOut > 0 ? `,afade=t=out:st=${Math.max(0, dur - edit.fadeOut).toFixed(3)}:d=${edit.fadeOut}` : "";
  if (edit.music) {
    const m = edit.music;
    const duck = m.duck ? `[0:a]asplit=2[c][sc];[m][sc]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=400[md];[c][md]` : `[0:a][m]`;
    await run("ffmpeg", ["-y", "-hide_banner", "-i", joined, "-stream_loop", "-1", "-ss", String(m.start || 0), "-i", files[m.key],
      "-filter_complex",
      `[1:a]atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${m.volume},afade=t=out:st=${Math.max(0, dur - 1.5).toFixed(3)}:d=1.5[m];` +
      `${duck}amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11${afadeOut}[a];[0:v]${vchain}[v]`,
      "-map", "[v]", "-map", "[a]", ...enc, "-t", dur.toFixed(3), out]);
  } else {
    await run("ffmpeg", ["-y", "-hide_banner", "-i", joined, "-vf", vchain, "-af", `loudnorm=I=-14:TP=-1.5:LRA=11${afadeOut}`, ...enc, out]);
  }

  await patch({ stage: "uploading", progress: 0.92 });
  const finalDur = (await probe(run, out)).duration;
  const thumb = join(work, "thumbnail.jpg");
  await run("ffmpeg", ["-y", "-hide_banner", "-ss", String(Math.min(1, finalDur / 2)), "-i", out, "-frames:v", "1", "-vf", `scale=${Math.round(w / 2)}:-2`, "-q:v", "3", thumb]);
  const outKey = await upload(out, `jobs/${jobId}/output.mp4`, "video/mp4");
  const thumbKey = await upload(thumb, `jobs/${jobId}/thumbnail.jpg`, "image/jpeg");
  await patch({ status: "done", stage: "done", progress: 1, output: outKey, thumbnail: thumbKey, durationSeconds: Math.round(finalDur * 10) / 10, logLine: `exported ${finalDur.toFixed(1)}s ${w}x${h}` });
  ctx.stopWatch();
  console.log(JSON.stringify({ ok: true, jobId, title: edit.title, format: edit.format, output: outKey, seconds: finalDur, captions: captionNote }));
  if (!keep) rmSync(work, { recursive: true, force: true });
} catch (e) {
  if (ctx.isCancelled() || e instanceof ctx.Cancelled) await new Promise(() => {});
  await ctx.checkCancel();
  await patch({ status: "failed", stage: "failed", phase: "export", error: String(e.message || e).slice(0, 400), logLine: `export failed: ${String(e.message || e).slice(0, 200)}` });
  console.error(`render-edit failed: ${e.stack || e}`);
  process.exit(1);
}
