import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, IconButton } from "./Icon";
import { Library } from "./Library";
import { api, clipLen, Edit, EditClip, EditText, editLength, fileName, FORMATS, FormatId, Job } from "../lib/api";

/* The editor: YT Boy's draft, as a timeline the user can change until Export. Saves itself. */

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|gif|bmp|tiff?)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const FORMAT_RATIO: Record<FormatId, string> = { "short-9x16": "9 / 16", "vlog-16x9": "16 / 9", "square-1x1": "1 / 1", "portrait-4x5": "4 / 5" };
const r2 = (n: number) => Math.round(n * 100) / 100;
const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}`;

export function clock(s: number) {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

type Sel = { kind: "clip" | "text"; id: string } | null;
type Save = "saved" | "saving" | "unsaved" | "error";

export function Editor({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const [edit, setEdit] = useState<Edit | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<Save>("saved");
  const [sel, setSel] = useState<Sel>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState(48); // pixels per second
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- load
  const load = useCallback(async (draft = false) => {
    try {
      const r = await api.getEdit(jobId, draft);
      setEdit(r.edit);
      setJob(r.job);
      setError(null);
      if (draft) { dirty.current = true; setSave("unsaved"); }
      return r.edit;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [jobId]);
  useEffect(() => { load(); }, [load]);

  // Signed links for every source, its thumbnail and the music.
  useEffect(() => {
    if (!edit) return;
    const keys = [...new Set(edit.clips.map((c) => c.key))];
    const want = [...keys, ...keys.map((k) => `thumbs/${k}.jpg`), ...(edit.music ? [edit.music.key] : [])].filter((k) => !urls[k]);
    if (!want.length) return;
    api.sign(want).then((u) => setUrls((prev) => ({ ...prev, ...u }))).catch(() => {});
  }, [edit, urls]);

  const locked = job ? ["exporting", "running", "cancelling"].includes(job.status) : false;

  // ---- autosave
  const flush = useCallback(async (e: Edit) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSave("saving");
    try {
      const r = await api.saveEdit(jobId, e);
      setJob(r.job);
      dirty.current = false;
      setSave("saved");
      return true;
    } catch (err) {
      setSave("error");
      setNotice((err as Error).message);
      return false;
    }
  }, [jobId]);

  const change = useCallback((fn: (e: Edit) => Edit) => {
    setEdit((prev) => {
      if (!prev || locked) return prev;
      const next = fn(structuredClone(prev));
      dirty.current = true;
      setSave("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => flush(next), 900);
      return next;
    });
  }, [flush, locked]);

  useEffect(() => {
    const warn = (ev: BeforeUnloadEvent) => { if (dirty.current) { ev.preventDefault(); } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // ---- timeline maths
  const starts = useMemo(() => {
    const s: number[] = [];
    let acc = 0;
    for (const c of edit?.clips || []) { s.push(acc); acc += clipLen(c); }
    return s;
  }, [edit]);
  const total = edit ? editLength(edit) : 0;
  const at = useCallback((time: number) => {
    if (!edit || !edit.clips.length) return -1;
    for (let i = edit.clips.length - 1; i >= 0; i--) if (time >= starts[i] - 1e-6) return i;
    return 0;
  }, [edit, starts]);
  const cur = at(Math.min(t, Math.max(0, total - 0.001)));

  // ---- playback
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const raf = useRef<number | null>(null);
  const last = useRef<number>(0);
  const tRef = useRef(0);
  tRef.current = t;

  const syncMedia = useCallback((time: number, play: boolean) => {
    if (!edit) return;
    const i = at(Math.min(time, Math.max(0, total - 0.001)));
    const c = edit.clips[i];
    const v = video.current;
    if (v && c && c.kind === "video") {
      const src = urls[c.key];
      if (src && v.dataset.key !== c.key) { v.src = src; v.dataset.key = c.key; }
      const want = c.in + (time - starts[i]);
      if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
      v.volume = Math.min(1, c.muted ? 0 : c.volume);
      v.muted = c.muted || c.volume === 0;
      if (play) v.play().catch(() => {}); else v.pause();
    } else if (v) v.pause();
    const a = audio.current;
    if (a && edit.music && urls[edit.music.key]) {
      if (a.dataset.key !== edit.music.key) { a.src = urls[edit.music.key]; a.dataset.key = edit.music.key; }
      a.volume = Math.min(1, edit.music.volume);
      const want = edit.music.start + time;
      if (Math.abs(a.currentTime - want) > 0.3) a.currentTime = want;
      if (play) a.play().catch(() => {}); else a.pause();
    }
  }, [edit, urls, at, starts, total]);

  const stop = useCallback(() => {
    setPlaying(false);
    if (raf.current) cancelAnimationFrame(raf.current);
    video.current?.pause();
    audio.current?.pause();
  }, []);

  const tick = useCallback((now: number) => {
    if (!edit) return;
    const dt = Math.min(0.1, (now - last.current) / 1000);
    last.current = now;
    let time = tRef.current;
    const i = at(Math.min(time, Math.max(0, total - 0.001)));
    const c = edit.clips[i];
    const v = video.current;
    if (c && c.kind === "video" && v) {
      // Follow the video's own clock; hold the playhead while the next clip loads or seeks.
      if (v.dataset.key === c.key && v.readyState >= 2 && !v.seeking) time = Math.max(time, starts[i] + (v.currentTime - c.in));
      if (v.paused && v.readyState >= 2) v.play().catch(() => {});
    } else time += dt;
    if (c && time >= starts[i] + clipLen(c) - 0.02) {
      time = starts[i] + clipLen(c);
      if (i + 1 < edit.clips.length) { tRef.current = time; setT(time); syncMedia(time + 0.001, true); }
    }
    if (time >= total) { setT(total); stop(); return; }
    tRef.current = time;
    setT(time);
    raf.current = requestAnimationFrame(tick);
  }, [edit, at, starts, total, syncMedia, stop]);

  const play = () => {
    if (!edit || !edit.clips.length) return;
    let from = tRef.current;
    if (from >= total - 0.05) { from = 0; setT(0); tRef.current = 0; }
    setPlaying(true);
    syncMedia(from, true);
    last.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  };
  const seek = (time: number) => {
    const x = Math.max(0, Math.min(total, time));
    setT(x);
    tRef.current = x;
    syncMedia(x, playing);
  };
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);
  // Show the right frame when paused and the clip under the playhead changes.
  useEffect(() => { if (!playing) syncMedia(t, false); }, [cur, urls, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- keyboard: space plays, arrows nudge the playhead
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag)) return;
      if (e.code === "Space") { e.preventDefault(); playing ? stop() : play(); }
      if (e.key === "ArrowLeft") seek(tRef.current - (e.shiftKey ? 1 : 0.1));
      if (e.key === "ArrowRight") seek(tRef.current + (e.shiftKey ? 1 : 0.1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- clip actions
  const selClip = sel?.kind === "clip" ? edit?.clips.find((c) => c.id === sel.id) : undefined;
  const selText = sel?.kind === "text" ? edit?.texts.find((x) => x.id === sel.id) : undefined;
  const updClip = (id: string, patch: Partial<EditClip>) => change((e) => ({ ...e, clips: e.clips.map((c) => (c.id === id ? fixClip({ ...c, ...patch }) : c)) }));
  const updText = (id: string, patch: Partial<EditText>) => change((e) => ({ ...e, texts: e.texts.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const moveClip = (id: string, dir: -1 | 1) => change((e) => {
    const i = e.clips.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= e.clips.length) return e;
    const clips = [...e.clips];
    [clips[i], clips[j]] = [clips[j], clips[i]];
    return { ...e, clips };
  });
  const dropClip = (from: string, to: string) => change((e) => {
    const clips = [...e.clips];
    const i = clips.findIndex((c) => c.id === from);
    const j = clips.findIndex((c) => c.id === to);
    if (i < 0 || j < 0 || i === j) return e;
    const [c] = clips.splice(i, 1);
    clips.splice(j, 0, c);
    return { ...e, clips };
  });
  const dupClip = (id: string) => change((e) => {
    const i = e.clips.findIndex((c) => c.id === id);
    if (i < 0) return e;
    const copy = { ...e.clips[i], id: uid("c") };
    return { ...e, clips: [...e.clips.slice(0, i + 1), copy, ...e.clips.slice(i + 1)] };
  });
  const delClip = (id: string) => { change((e) => ({ ...e, clips: e.clips.filter((c) => c.id !== id) })); setSel(null); };
  const splitAtPlayhead = () => {
    if (!edit) return;
    const i = cur;
    const c = edit.clips[i];
    if (!c) return;
    const cut = c.in + (t - starts[i]);
    if (cut - c.in < 0.2 || c.out - cut < 0.2) { setNotice("Move the playhead further inside the clip to split it."); return; }
    change((e) => {
      const a = { ...c, out: r2(cut) };
      const b = { ...c, id: uid("c"), in: r2(cut) };
      return { ...e, clips: [...e.clips.slice(0, i), a, b, ...e.clips.slice(i + 1)] };
    });
  };
  const addText = () => {
    const id = uid("t");
    change((e) => ({ ...e, texts: [...e.texts, { id, text: "New text", start: r2(t), end: r2(Math.min(t + 3, Math.max(total, t + 3))), position: "bottom", size: "m" }] }));
    setSel({ kind: "text", id });
  };

  // Add clips picked in the library: videos get their real length, stills 3 s, audio becomes the music.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [addBusy, setAddBusy] = useState(false);
  const addPicked = async () => {
    if (!picked.size) return;
    setAddBusy(true);
    const keys = [...picked];
    const signed = await api.sign(keys).catch(() => ({} as Record<string, string>));
    const added: EditClip[] = [];
    let music: string | null = null;
    for (const key of keys) {
      if (AUDIO_EXT.test(key)) { music = key; continue; }
      if (IMAGE_EXT.test(key)) { added.push({ id: uid("c"), key, kind: "image", duration: 0, in: 0, out: 3, volume: 1, muted: true }); continue; }
      const d = signed[key] ? await videoDuration(signed[key]) : 0;
      added.push({ id: uid("c"), key, kind: "video", duration: r2(d), in: 0, out: r2(d ? Math.min(d, 5) : 5), volume: 1, muted: false });
    }
    setUrls((u) => ({ ...u, ...signed }));
    change((e) => ({ ...e, clips: [...e.clips, ...added], music: music ? { key: music, volume: 0.6, start: 0, duck: true } : e.music }));
    setPicked(new Set());
    setAdding(false);
    setAddBusy(false);
    setNotice(`${added.length} clip${added.length === 1 ? "" : "s"} added at the end${music ? ", music set" : ""}.`);
  };

  const doExport = async () => {
    if (!edit) return;
    if (!edit.clips.length) { setNotice("Add at least one clip before exporting."); return; }
    stop();
    setExporting(true);
    if (dirty.current && !(await flush(edit))) { setExporting(false); return; }
    try {
      await api.exportJob(jobId);
      onBack();
    } catch (e) {
      setNotice((e as Error).message);
      setExporting(false);
    }
  };

  // ---- states
  if (error)
    return (
      <section className="state" role="alert">
        <h2>Can’t open this draft</h2>
        <p>{error}</p>
        <div className="sheet__actions">
          <button type="button" className="btn" onClick={onBack}>Back to the queue</button>
          <button type="button" className="btn btn--primary" onClick={() => load()}>Try again</button>
        </div>
      </section>
    );
  if (!edit || !job)
    return (
      <div aria-busy="true" aria-label="Loading the editor">
        <div className="sheet sheet--skeleton" />
        <div className="row row--skeleton" />
      </div>
    );

  const curClip = edit.clips[cur];
  const textsNow = edit.texts.filter((x) => t >= x.start && t < x.end);
  const saveLabel = { saved: "Saved", saving: "Saving…", unsaved: "Unsaved changes", error: "Not saved" }[save];

  return (
    <div className="editor">
      {/* ---- header */}
      <div className="ed-head">
        <IconButton icon="back" label="Back to the queue" onClick={onBack} />
        <label className="ed-title">
          <span className="visually-hidden">Title</span>
          <input type="text" value={edit.title || ""} placeholder="Untitled" maxLength={140} disabled={locked}
            onChange={(e) => change((x) => ({ ...x, title: e.target.value || null }))} />
        </label>
        <span className={`ed-save${save === "error" ? " hint--error" : ""}`} role="status">{locked ? "Exporting: locked" : saveLabel}</span>
        <button type="button" className="btn btn--primary" onClick={doExport} disabled={locked || exporting || !edit.clips.length}>
          {exporting ? "Exporting…" : "Export"}
        </button>
      </div>
      {notice && (
        <p className="notice" role="status">
          {notice} <button type="button" className="link" onClick={() => setNotice(null)}>Dismiss</button>
        </p>
      )}

      <div className="ed-main">
        {/* ---- preview */}
        <div className="ed-stage">
          <div className={`ed-frame ed-frame--${edit.framing}`} style={{ aspectRatio: FORMAT_RATIO[edit.format] }}>
            {curClip && curClip.kind === "image" && urls[curClip.key] && <img className="ed-media" src={urls[curClip.key]} alt="" />}
            <video ref={video} className="ed-media" playsInline preload="auto" poster={curClip ? urls[`thumbs/${curClip.key}.jpg`] : undefined} hidden={!curClip || curClip.kind !== "video"} />
            {!edit.clips.length && <p className="ed-empty">The timeline is empty. Add clips below.</p>}
            {textsNow.map((x) => (
              <span key={x.id} className={`ed-text ed-text--${x.position} ed-text--${x.size}`}>{x.text}</span>
            ))}
          </div>
          <audio ref={audio} preload="auto" />
          <div className="ed-transport">
            <button type="button" className="icon-btn" onClick={() => (playing ? stop() : play())} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (space)" : "Play (space)"}>
              <Icon name={playing ? "pause" : "play"} />
            </button>
            <input className="ed-scrub" type="range" min={0} max={Math.max(0.1, total)} step={0.05} value={Math.min(t, total)} onChange={(e) => seek(Number(e.target.value))} aria-label="Playhead" />
            <span className="ed-time num">{clock(Math.min(t, total))} / {clock(total)}</span>
          </div>
        </div>

        {/* ---- inspector */}
        <aside className="ed-panel" aria-label="Inspector">
          {selClip ? (
            <ClipInspector clip={selClip} index={edit.clips.findIndex((c) => c.id === selClip.id)} count={edit.clips.length} disabled={locked}
              playheadSrc={curClip && curClip.id === selClip.id ? selClip.in + (t - starts[cur]) : null}
              update={(p) => updClip(selClip.id, p)} move={(d) => moveClip(selClip.id, d)} dup={() => dupClip(selClip.id)} del={() => delClip(selClip.id)} close={() => setSel(null)} />
          ) : selText ? (
            <TextInspector text={selText} t={t} disabled={locked} update={(p) => updText(selText.id, p)}
              del={() => { change((e) => ({ ...e, texts: e.texts.filter((x) => x.id !== selText.id) })); setSel(null); }} close={() => setSel(null)} />
          ) : (
            <ProjectPanel edit={edit} disabled={locked} change={change} urls={urls}
              reset={() => { if (window.confirm("Replace your changes with YT Boy’s original draft?")) { stop(); setSel(null); load(true).then((e) => e && flush(e)); } }} />
          )}
        </aside>
      </div>

      {/* ---- timeline */}
      <section className="ed-tl" aria-label="Timeline">
        <div className="ed-tools">
          <button type="button" className="btn btn--small" onClick={() => setAdding((a) => !a)} disabled={locked} aria-expanded={adding}><Icon name="plus" size={16} /> Add clips</button>
          <button type="button" className="btn btn--small" onClick={addText} disabled={locked}><Icon name="text" size={16} /> Add text</button>
          <button type="button" className="btn btn--small" onClick={splitAtPlayhead} disabled={locked || !curClip}><Icon name="split" size={16} /> Split at playhead</button>
          <label className="ed-zoom">
            <span>Zoom</span>
            <input type="range" min={16} max={160} step={4} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          </label>
        </div>

        {adding && (
          <div className="ed-add">
            <p className="hint">Pick clips from the library. Videos and photos go to the end of the timeline; a music file becomes the music track.</p>
            <Library picked={picked} onToggle={(k) => setPicked((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; })} refresh={0} />
            <div className="sheet__actions">
              <button type="button" className="btn" onClick={() => { setAdding(false); setPicked(new Set()); }}>Cancel</button>
              <button type="button" className="btn btn--primary" onClick={addPicked} disabled={!picked.size || addBusy}>{addBusy ? "Adding…" : `Add ${picked.size || ""} to the timeline`}</button>
            </div>
          </div>
        )}

        <div className="ed-tracks" style={{ ["--pps" as string]: `${zoom}px` }}>
          <div className="ed-track-inner" style={{ width: `${Math.max(total * zoom + 40, 300)}px` }}
            onClick={(e) => {
              if (e.target !== e.currentTarget) return;
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              seek((e.clientX - r.left) / zoom);
            }}>
            <ol className="ed-clips" aria-label="Clips">
              {edit.clips.map((c, i) => (
                <li key={c.id} style={{ width: `${Math.max(4, clipLen(c) * zoom)}px` }}>
                  <button type="button" className={`ed-clip${sel?.id === c.id ? " ed-clip--on" : ""}${i === cur ? " ed-clip--cur" : ""}`}
                    draggable={!locked}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", c.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); dropClip(e.dataTransfer.getData("text/plain"), c.id); }}
                    onClick={(e) => {
                      setSel({ kind: "clip", id: c.id });
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      seek(starts[i] + ((e.clientX - r.left) / r.width) * clipLen(c));
                    }}
                    style={urls[`thumbs/${c.key}.jpg`] ? { backgroundImage: `url("${urls[`thumbs/${c.key}.jpg`]}")` } : undefined}
                    aria-label={`Clip ${i + 1}: ${fileName(c.key)}, ${clipLen(c).toFixed(1)} seconds`}>
                    <span className="ed-clip__label">{i + 1}. {fileName(c.key)}</span>
                    <span className="ed-clip__len num">{clipLen(c).toFixed(1)}s{c.muted ? ", muted" : ""}</span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="ed-texts" aria-label="Text overlays">
              {edit.texts.map((x) => (
                <button key={x.id} type="button" className={`ed-tchip${sel?.id === x.id ? " ed-clip--on" : ""}`}
                  style={{ left: `${x.start * zoom}px`, width: `${Math.max(16, (x.end - x.start) * zoom)}px` }}
                  onClick={() => { setSel({ kind: "text", id: x.id }); seek(x.start); }} aria-label={`Text: ${x.text}`}>
                  {x.text}
                </button>
              ))}
            </div>
            {edit.music && (
              <div className="ed-music" style={{ width: `${total * zoom}px` }} aria-label="Music track">
                <Icon name="music" size={14} /> {fileName(edit.music.key)}
              </div>
            )}
            <span className="ed-playhead" style={{ transform: `translateX(${Math.min(t, total) * zoom}px)` }} aria-hidden="true" />
          </div>
        </div>
        <p className="hint">Click a clip to select it and move the playhead. Drag clips to reorder. Space plays, arrows nudge the playhead.</p>
      </section>
    </div>
  );
}

function fixClip(c: EditClip): EditClip {
  const max = c.kind === "image" ? 600 : c.duration || 36000;
  const inP = Math.max(0, Math.min(c.in, max - 0.1));
  const outP = Math.max(inP + 0.1, Math.min(c.out, max));
  return { ...c, in: r2(inP), out: r2(outP) };
}

function videoDuration(src: string): Promise<number> {
  return new Promise((ok) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = (d: number) => { v.removeAttribute("src"); v.load(); ok(d); };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => done(0);
    setTimeout(() => done(0), 15000);
    v.src = src;
  });
}

function Num({ label, value, onChange, min = 0, max, step = 0.1, disabled }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; disabled?: boolean }) {
  return (
    <label className="ed-num">
      <span>{label}</span>
      <input type="number" inputMode="decimal" value={r2(value)} min={min} max={max} step={step} disabled={disabled} onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))} />
    </label>
  );
}

function ClipInspector({ clip: c, index, count, playheadSrc, disabled, update, move, dup, del, close }: {
  clip: EditClip; index: number; count: number; playheadSrc: number | null; disabled: boolean;
  update: (p: Partial<EditClip>) => void; move: (d: -1 | 1) => void; dup: () => void; del: () => void; close: () => void;
}) {
  const max = c.kind === "image" ? 60 : c.duration;
  return (
    <div className="ed-insp">
      <div className="ed-insp__head">
        <h3>Clip {index + 1} of {count}</h3>
        <button type="button" className="link" onClick={close}>Done</button>
      </div>
      <p className="row__meta">{fileName(c.key)}{c.kind === "video" && c.duration ? `, source ${c.duration.toFixed(1)} s` : ", photo"}</p>
      {c.kind === "video" ? (
        <>
          <div className="ed-row">
            <Num label="In, s" value={c.in} max={max} disabled={disabled} onChange={(n) => update({ in: n })} />
            <Num label="Out, s" value={c.out} max={max} disabled={disabled} onChange={(n) => update({ out: n })} />
          </div>
          <div className="ed-row">
            <button type="button" className="btn btn--small" disabled={disabled || playheadSrc == null} onClick={() => playheadSrc != null && update({ in: playheadSrc })}>In at playhead</button>
            <button type="button" className="btn btn--small" disabled={disabled || playheadSrc == null} onClick={() => playheadSrc != null && update({ out: playheadSrc })}>Out at playhead</button>
          </div>
          <label className="ed-slider">
            <span>Volume <span className="num">{Math.round(c.volume * 100)}%</span></span>
            <input type="range" min={0} max={2} step={0.05} value={c.volume} disabled={disabled || c.muted} onChange={(e) => update({ volume: Number(e.target.value) })} />
          </label>
          <label className="toggle"><input type="checkbox" checked={c.muted} disabled={disabled} onChange={(e) => update({ muted: e.target.checked })} /><span>Mute this clip</span></label>
        </>
      ) : (
        <Num label="Show for, s" value={c.out - c.in} min={0.5} max={60} disabled={disabled} onChange={(n) => update({ in: 0, out: n })} />
      )}
      <div className="ed-row ed-row--icons">
        <IconButton icon="left" label="Move earlier" disabled={disabled || index === 0} onClick={() => move(-1)} />
        <IconButton icon="right" label="Move later" disabled={disabled || index === count - 1} onClick={() => move(1)} />
        <IconButton icon="copy" label="Duplicate" disabled={disabled} onClick={dup} />
        <IconButton icon="trash" label="Remove from timeline" danger disabled={disabled} onClick={del} />
      </div>
    </div>
  );
}

function TextInspector({ text: x, t, disabled, update, del, close }: { text: EditText; t: number; disabled: boolean; update: (p: Partial<EditText>) => void; del: () => void; close: () => void }) {
  return (
    <div className="ed-insp">
      <div className="ed-insp__head">
        <h3>Text</h3>
        <button type="button" className="link" onClick={close}>Done</button>
      </div>
      <label className="field field--tight">
        <span>Words</span>
        <textarea rows={2} maxLength={200} value={x.text} disabled={disabled} onChange={(e) => update({ text: e.target.value })} />
      </label>
      <div className="ed-row">
        <Num label="Start, s" value={x.start} disabled={disabled} onChange={(n) => update({ start: n, end: Math.max(n + 0.2, x.end) })} />
        <Num label="End, s" value={x.end} disabled={disabled} onChange={(n) => update({ end: Math.max(x.start + 0.2, n) })} />
      </div>
      <div className="ed-row">
        <button type="button" className="btn btn--small" disabled={disabled} onClick={() => update({ start: r2(t), end: r2(Math.max(t + 0.2, x.end)) })}>Start at playhead</button>
        <button type="button" className="btn btn--small" disabled={disabled} onClick={() => update({ end: r2(Math.max(x.start + 0.2, t)) })}>End at playhead</button>
      </div>
      <Choice label="Position" value={x.position} options={[["top", "Top"], ["center", "Middle"], ["bottom", "Bottom"]]} disabled={disabled} onChange={(v) => update({ position: v as EditText["position"] })} />
      <Choice label="Size" value={x.size} options={[["s", "Small"], ["m", "Medium"], ["l", "Large"]]} disabled={disabled} onChange={(v) => update({ size: v as EditText["size"] })} />
      <div className="ed-row ed-row--icons"><IconButton icon="trash" label="Delete text" danger disabled={disabled} onClick={del} /></div>
    </div>
  );
}

function Choice({ label, value, options, onChange, disabled }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="ed-choice">
      <span className="ed-choice__label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className="segmented__item" disabled={disabled} onClick={() => onChange(v)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

function ProjectPanel({ edit, change, disabled, reset, urls }: { edit: Edit; change: (fn: (e: Edit) => Edit) => void; disabled: boolean; reset: () => void; urls: Record<string, string> }) {
  void urls;
  return (
    <div className="ed-insp">
      <div className="ed-insp__head"><h3>Video settings</h3></div>
      <Choice label="Format" value={edit.format} disabled={disabled} options={FORMATS.map((f) => [f.id, f.label.split(" ")[1] || f.label])}
        onChange={(v) => change((e) => ({ ...e, format: v as FormatId }))} />
      <Choice label="Framing" value={edit.framing} disabled={disabled} options={[["fit", "Whole shot"], ["fill", "Fill frame"]]}
        onChange={(v) => change((e) => ({ ...e, framing: v as Edit["framing"] }))} />
      <label className="toggle"><input type="checkbox" checked={edit.captions} disabled={disabled} onChange={(e) => change((x) => ({ ...x, captions: e.target.checked }))} /><span>Burn in captions from speech</span></label>
      <div className="ed-row">
        <Num label="Fade in, s" value={edit.fadeIn} max={5} disabled={disabled} onChange={(n) => change((e) => ({ ...e, fadeIn: n }))} />
        <Num label="Fade out, s" value={edit.fadeOut} max={5} disabled={disabled} onChange={(n) => change((e) => ({ ...e, fadeOut: n }))} />
      </div>
      <div className="ed-music-set">
        <h3>Music</h3>
        {edit.music ? (
          <>
            <p className="row__meta">{fileName(edit.music.key)}</p>
            <label className="ed-slider">
              <span>Volume <span className="num">{Math.round(edit.music.volume * 100)}%</span></span>
              <input type="range" min={0} max={1.5} step={0.05} value={edit.music.volume} disabled={disabled} onChange={(e) => change((x) => ({ ...x, music: x.music && { ...x.music, volume: Number(e.target.value) } }))} />
            </label>
            <div className="ed-row">
              <Num label="Start song at, s" value={edit.music.start} disabled={disabled} onChange={(n) => change((x) => ({ ...x, music: x.music && { ...x.music, start: n } }))} />
            </div>
            <label className="toggle"><input type="checkbox" checked={edit.music.duck} disabled={disabled} onChange={(e) => change((x) => ({ ...x, music: x.music && { ...x.music, duck: e.target.checked } }))} /><span>Lower music under clip sound</span></label>
            <button type="button" className="btn btn--small" disabled={disabled} onClick={() => change((x) => ({ ...x, music: null }))}>Remove music</button>
          </>
        ) : (
          <p className="quiet">No music. Use Add clips and pick a music file.</p>
        )}
      </div>
      <button type="button" className="btn btn--small ed-reset" onClick={reset} disabled={disabled}><Icon name="reset" size={16} /> Reset to YT Boy’s draft</button>
    </div>
  );
}
