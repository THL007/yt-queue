import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, IconButton, IconName } from "./Icon";
import { MediaBin, MediaKind, mediaKind } from "./MediaBin";
import {
  api, clipLen, clipStarts, Edit, EditAudio, EditClip, EditText, editLength, fileName, fontFamily, FontId, FORMATS, FormatId, Job,
  TEXT_FONTS, TransitionId, transitionLabel, transitionLengths, TRANSITIONS,
} from "../lib/api";

/* The editor: YT Boy's draft as a multi-track timeline (text, video, sound, music) the user changes until Export.
   Drag and drop works with a finger or a mouse: clips reorder (hold, then drag), edges trim, texts and sounds
   move, files come from the Media tab, transitions from the Transitions tab. Saves itself; undo/redo. */

const FORMAT_RATIO: Record<FormatId, string> = { "short-9x16": "9 / 16", "vlog-16x9": "16 / 9", "square-1x1": "1 / 1", "portrait-4x5": "4 / 5" };
const r2 = (n: number) => Math.round(n * 100) / 100;
const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}`;
const HOLD_MS = 260; // touch: hold this long on a clip before it can be dragged (so swipes still scroll)

export function clock(s: number) {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

type Sel = { kind: "clip" | "text" | "audio" | "cut"; id: string } | null;
type Save = "saved" | "saving" | "unsaved" | "error";
type Tab = "inspect" | "media" | "transitions";
type Payload = { kind: "media"; key: string; media: MediaKind } | { kind: "transition"; id: TransitionId };
type Ghost = { x: number; y: number; label: string } | null;
type ItemDrag = {
  what: "clip" | "text" | "audio" | "ruler"; id: string; mode: "move" | "left" | "right";
  x0: number; y0: number; pid: number; touch: boolean; armed: boolean; active: boolean; timer?: ReturnType<typeof setTimeout>;
  orig: EditClip | EditText | EditAudio | null;
};

/* ---------- transition look (preview and library tiles) */
export function transitionStyle(type: TransitionId, p: number): { media: CSSProperties; veil?: CSSProperties } {
  const q = Math.max(0, Math.min(1, p));
  const mask = (m: string): CSSProperties => ({ maskImage: m, WebkitMaskImage: m } as CSSProperties);
  switch (type) {
    case "fade": case "dissolve": return { media: { opacity: q } };
    case "fadeblack": case "fadewhite":
      return { media: { opacity: q < 0.5 ? 0 : (q - 0.5) * 2 }, veil: { background: type === "fadeblack" ? "#000" : "#fff", opacity: 1 - Math.abs(2 * q - 1) } };
    case "slideleft": return { media: { transform: `translateX(${(1 - q) * 100}%)` } };
    case "slideright": return { media: { transform: `translateX(${-(1 - q) * 100}%)` } };
    case "slideup": return { media: { transform: `translateY(${(1 - q) * 100}%)` } };
    case "slidedown": return { media: { transform: `translateY(${-(1 - q) * 100}%)` } };
    case "squeezeh": return { media: { transform: `scaleX(${Math.max(0.001, q)})` } };
    case "wipeleft": return { media: { clipPath: `inset(0 0 0 ${(1 - q) * 100}%)` } };
    case "wiperight": return { media: { clipPath: `inset(0 ${(1 - q) * 100}% 0 0)` } };
    case "smoothleft": return { media: mask(`linear-gradient(to left, #000 ${q * 130 - 30}%, transparent ${q * 130}%)`) };
    case "circleopen": return { media: { clipPath: `circle(${q * 75}% at 50% 50%)` } };
    case "circleclose": return { media: mask(`radial-gradient(circle at 50% 50%, transparent ${(1 - q) * 72}%, #000 ${(1 - q) * 72 + 0.5}%)`) };
    case "radial": return { media: mask(`conic-gradient(#000 ${q * 360}deg, transparent ${q * 360}deg)`) };
    case "zoomin": return { media: { transform: `scale(${1 + (1 - q) * 0.4})`, opacity: Math.min(1, q * 1.4) } };
    case "hblur": return { media: { filter: `blur(${(1 - q) * 14}px)`, opacity: Math.min(1, q * 1.5) } };
    case "pixelize": return { media: { filter: `blur(${(1 - q) * 8}px) contrast(${1 + (1 - q) * 0.4})`, opacity: q } };
    default: return { media: { opacity: q } };
  }
}

export function Editor({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const [edit, setEdit] = useState<Edit | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<Save>("saved");
  const [sel, setSelState] = useState<Sel>(null);
  const [tab, setTab] = useState<Tab>("inspect");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState(56); // pixels per second
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ghost, setGhost] = useState<Ghost>(null);
  const [hover, setHover] = useState<string | null>(null); // drop target under a dragged file or transition
  const [insertAt, setInsertAt] = useState<number | null>(null); // clip reorder marker (index)
  const [dragOffset, setDragOffset] = useState<{ id: string; px: number } | null>(null);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editRef = useRef<Edit | null>(null);
  editRef.current = edit;

  const setSel = (s: Sel) => { setSelState(s); if (s) setTab("inspect"); };

  // ---- load
  const load = useCallback(async (draft = false) => {
    try {
      const r = await api.getEdit(jobId, draft);
      setEdit({ ...r.edit, audios: r.edit.audios || [] });
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

  // Signed links for every source, its thumbnail, sounds and the music.
  useEffect(() => {
    if (!edit) return;
    const keys = [...new Set([...edit.clips.map((c) => c.key), ...(edit.audios || []).map((a) => a.key)])];
    const want = [...keys, ...edit.clips.map((c) => `thumbs/${c.key}.jpg`), ...(edit.music ? [edit.music.key] : [])].filter((k) => !(k in urls));
    if (!want.length) return;
    api.sign([...new Set(want)]).then((u) => setUrls((prev) => ({ ...prev, ...Object.fromEntries(want.map((k) => [k, u[k] || ""])) }))).catch(() => {});
  }, [edit, urls]);

  const locked = job ? ["exporting", "running", "cancelling"].includes(job.status) : false;

  // ---- autosave + undo/redo
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
  const schedule = useCallback((next: Edit) => {
    dirty.current = true;
    setSave("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flush(next), 900);
  }, [flush]);

  const past = useRef<Edit[]>([]);
  const future = useRef<Edit[]>([]);
  const lastTag = useRef<{ tag: string; at: number } | null>(null);
  const [, bump] = useState(0);
  const change = useCallback((fn: (e: Edit) => Edit, tag?: string) => {
    const prev = editRef.current;
    if (!prev || locked) return;
    const next = fn(structuredClone(prev));
    const now = Date.now();
    // One undo step per gesture: live drags and slider moves share a tag.
    if (!(tag && lastTag.current && lastTag.current.tag === tag && now - lastTag.current.at < 1500)) {
      past.current = [...past.current.slice(-60), prev];
      future.current = [];
    }
    lastTag.current = tag ? { tag, at: now } : null;
    editRef.current = next;
    setEdit(next);
    schedule(next);
    bump((n) => n + 1);
  }, [locked, schedule]);
  const undo = () => {
    const prev = past.current.pop();
    if (!prev || !editRef.current || locked) return;
    future.current.push(editRef.current);
    lastTag.current = null;
    editRef.current = prev; setEdit(prev); schedule(prev); bump((n) => n + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next || !editRef.current || locked) return;
    past.current.push(editRef.current);
    lastTag.current = null;
    editRef.current = next; setEdit(next); schedule(next); bump((n) => n + 1);
  };

  useEffect(() => {
    const warn = (ev: BeforeUnloadEvent) => { if (dirty.current) ev.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // ---- timeline maths
  const starts = useMemo(() => clipStarts(edit?.clips || []), [edit]);
  const trans = useMemo(() => transitionLengths(edit?.clips || []), [edit]);
  const total = edit ? editLength(edit) : 0;
  const at = useCallback((time: number) => {
    if (!edit || !edit.clips.length) return -1;
    for (let i = edit.clips.length - 1; i >= 0; i--) if (time >= starts[i] - 1e-6) return i;
    return 0;
  }, [edit, starts]);
  const cur = at(Math.min(t, Math.max(0, total - 0.001)));

  // ---- playback: one <video> follows the clip under the playhead; sounds and music are <audio> elements.
  const video = useRef<HTMLVideoElement>(null);
  const music = useRef<HTMLAudioElement>(null);
  const sounds = useRef(new Map<string, HTMLAudioElement>());
  const raf = useRef<number | null>(null);
  const last = useRef(0);
  const tRef = useRef(0);
  tRef.current = t;

  const syncSounds = useCallback((time: number, play: boolean) => {
    const e = editRef.current;
    if (!e) return;
    const live = new Set<string>();
    for (const a of e.audios || []) {
      live.add(a.id);
      let el = sounds.current.get(a.id);
      if (!el) { el = new Audio(); el.preload = "auto"; sounds.current.set(a.id, el); }
      const src = urls[a.key];
      if (src && el.dataset.key !== a.key) { el.src = src; el.dataset.key = a.key; }
      const inside = !a.muted && time >= a.start && time < a.start + (a.out - a.in);
      if (!inside) { if (!el.paused) el.pause(); continue; }
      const want = a.in + (time - a.start);
      if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
      el.volume = Math.min(1, a.volume);
      if (play && el.paused) el.play().catch(() => {});
      if (!play && !el.paused) el.pause();
    }
    for (const [id, el] of sounds.current) if (!live.has(id)) { el.pause(); sounds.current.delete(id); }
  }, [urls]);

  const syncMedia = useCallback((time: number, play: boolean) => {
    const e = editRef.current;
    if (!e) return;
    const i = at(Math.min(time, Math.max(0, total - 0.001)));
    const c = e.clips[i];
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
    const m = music.current;
    if (m && e.music && urls[e.music.key]) {
      if (m.dataset.key !== e.music.key) { m.src = urls[e.music.key]; m.dataset.key = e.music.key; }
      m.volume = Math.min(1, e.music.volume);
      const want = e.music.start + time;
      if (Math.abs(m.currentTime - want) > 0.3) m.currentTime = want;
      if (play) m.play().catch(() => {}); else m.pause();
    }
    syncSounds(time, play);
  }, [urls, at, starts, total, syncSounds]);

  const stop = useCallback(() => {
    setPlaying(false);
    if (raf.current) cancelAnimationFrame(raf.current);
    video.current?.pause();
    music.current?.pause();
    for (const el of sounds.current.values()) el.pause();
  }, []);

  const tick = useCallback((now: number) => {
    const e = editRef.current;
    if (!e) return;
    const dt = Math.min(0.1, (now - last.current) / 1000);
    last.current = now;
    let time = tRef.current;
    const i = at(Math.min(time, Math.max(0, total - 0.001)));
    const c = e.clips[i];
    const v = video.current;
    if (c && c.kind === "video" && v && v.dataset.key === c.key && v.readyState >= 2 && !v.seeking) {
      time = Math.max(time, starts[i] + (v.currentTime - c.in));
      if (v.paused) v.play().catch(() => {});
    } else time += dt;
    if (at(time) !== i) syncMedia(time + 0.001, true);
    else syncSounds(time, true);
    if (time >= total) { setT(total); stop(); return; }
    tRef.current = time;
    setT(time);
    raf.current = requestAnimationFrame(tick);
  }, [at, starts, total, syncMedia, syncSounds, stop]);

  const play = () => {
    if (!edit || !edit.clips.length) return;
    let from = tRef.current;
    if (from >= total - 0.05) { from = 0; setT(0); tRef.current = 0; }
    setPlaying(true);
    syncMedia(from, true);
    last.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  };
  const seek = useCallback((time: number) => {
    const x = Math.max(0, Math.min(total, time));
    setT(x);
    tRef.current = x;
    syncMedia(x, playing);
  }, [total, syncMedia, playing]);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); for (const el of sounds.current.values()) el.pause(); }, []);
  useEffect(() => { if (!playing) syncMedia(t, false); }, [cur, urls, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- edit actions
  const selClip = sel?.kind === "clip" || sel?.kind === "cut" ? edit?.clips.find((c) => c.id === sel.id) : undefined;
  const selText = sel?.kind === "text" ? edit?.texts.find((x) => x.id === sel.id) : undefined;
  const selAudio = sel?.kind === "audio" ? edit?.audios?.find((x) => x.id === sel.id) : undefined;
  const updClip = (id: string, patch: Partial<EditClip>, tag?: string) => change((e) => ({ ...e, clips: e.clips.map((c) => (c.id === id ? fixClip({ ...c, ...patch }) : c)) }), tag);
  const updText = (id: string, patch: Partial<EditText>, tag?: string) => change((e) => ({ ...e, texts: e.texts.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), tag);
  const updAudio = (id: string, patch: Partial<EditAudio>, tag?: string) => change((e) => ({ ...e, audios: (e.audios || []).map((x) => (x.id === id ? fixAudio({ ...x, ...patch }) : x)) }), tag);
  const reorder = (id: string, to: number) => change((e) => {
    const clips = [...e.clips];
    const i = clips.findIndex((c) => c.id === id);
    if (i < 0) return e;
    const [c] = clips.splice(i, 1);
    clips.splice(to > i ? to - 1 : to, 0, c);
    return { ...e, clips };
  });
  const moveClip = (id: string, dir: -1 | 1) => {
    if (!edit) return;
    const i = edit.clips.findIndex((c) => c.id === id);
    reorder(id, dir < 0 ? Math.max(0, i - 1) : Math.min(edit.clips.length, i + 2));
  };
  const dupClip = (id: string) => change((e) => {
    const i = e.clips.findIndex((c) => c.id === id);
    if (i < 0) return e;
    return { ...e, clips: [...e.clips.slice(0, i + 1), { ...e.clips[i], id: uid("c") }, ...e.clips.slice(i + 1)] };
  });
  const delClip = (id: string) => { change((e) => ({ ...e, clips: e.clips.filter((c) => c.id !== id), audios: (e.audios || []).filter((a) => a.fromClip !== id) })); setSelState(null); };
  const delText = (id: string) => { change((e) => ({ ...e, texts: e.texts.filter((x) => x.id !== id) })); setSelState(null); };
  const delAudio = (id: string) => { change((e) => ({ ...e, audios: (e.audios || []).filter((x) => x.id !== id) })); setSelState(null); };
  const splitAtPlayhead = () => {
    if (!edit) return;
    const i = cur;
    const c = edit.clips[i];
    if (!c) return;
    const cut = c.in + (t - starts[i]);
    if (cut - c.in < 0.2 || c.out - cut < 0.2) { setNotice("Move the playhead further inside the clip to split it."); return; }
    change((e) => {
      const a = { ...c, out: r2(cut), transition: null };
      const b = { ...c, id: uid("c"), in: r2(cut) };
      return { ...e, clips: [...e.clips.slice(0, i), a, b, ...e.clips.slice(i + 1)] };
    });
  };
  const addText = () => {
    const id = uid("t");
    change((e) => ({ ...e, texts: [...e.texts, { id, text: "New text", start: r2(t), end: r2(t + 3), position: "bottom", size: "m", font: "barlow" }] }));
    setSel({ kind: "text", id });
  };
  // Clip sound to its own item on the sound track (and back).
  const detach = (id: string) => change((e) => {
    const i = e.clips.findIndex((c) => c.id === id);
    const c = e.clips[i];
    if (!c || c.kind !== "video") return e;
    const s = clipStarts(e.clips)[i];
    const a: EditAudio = { id: uid("a"), key: c.key, duration: c.duration, in: c.in, out: c.out, start: r2(s), volume: c.volume, muted: c.muted, fromClip: c.id };
    return { ...e, clips: e.clips.map((x) => (x.id === id ? { ...x, muted: true, detached: true } : x)), audios: [...(e.audios || []), a] };
  });
  const reattach = (clipId: string) => change((e) => {
    const a = (e.audios || []).find((x) => x.fromClip === clipId);
    return { ...e, clips: e.clips.map((x) => (x.id === clipId ? { ...x, detached: false, muted: a ? a.muted : false, volume: a ? a.volume : x.volume } : x)), audios: (e.audios || []).filter((x) => x.fromClip !== clipId) };
  });
  const setTransition = (clipId: string, type: TransitionId | null, duration?: number) => change((e) => ({
    ...e, clips: e.clips.map((c) => (c.id === clipId ? { ...c, transition: type ? { type, duration: duration ?? c.transition?.duration ?? 0.6 } : null } : c)),
  }), duration !== undefined ? `tr-${clipId}` : undefined);
  const setAllTransitions = (type: TransitionId | null, duration = 0.6) => change((e) => ({
    ...e, clips: e.clips.map((c, i) => (i < e.clips.length - 1 ? { ...c, transition: type ? { type, duration } : null } : c)),
  }));

  // Add a library file: videos/photos to the video track (at an index), sounds to the sound track (at a time).
  const addMedia = async (key: string, kind: MediaKind, where: { lane: "video"; index: number } | { lane: "sound"; time: number } | { lane: "music" }) => {
    const signed = urls[key] ? { [key]: urls[key] } : await api.sign([key]).catch(() => ({} as Record<string, string>));
    if (signed[key]) setUrls((u) => ({ ...u, [key]: signed[key] }));
    if (where.lane === "music") {
      change((e) => ({ ...e, music: { key, volume: 0.6, start: 0, duck: true } }));
      setNotice(`Music: ${fileName(key)}.`);
      return;
    }
    if (where.lane === "sound") {
      if (kind === "image") { setNotice("A photo has no sound. Drop it on the video track."); return; }
      const d = signed[key] ? await mediaDuration(signed[key], kind === "audio" ? "audio" : "video") : 0;
      const id = uid("a");
      change((e) => ({ ...e, audios: [...(e.audios || []), { id, key, duration: r2(d), in: 0, out: r2(d ? Math.min(d, 10) : 5), start: r2(where.time), volume: 1, muted: false, fromClip: null }] }));
      setSel({ kind: "audio", id });
      return;
    }
    if (kind === "audio") { setNotice("Sound files go on the sound or music track."); return; }
    const d = kind === "video" && signed[key] ? await mediaDuration(signed[key], "video") : 0;
    const clip: EditClip = kind === "image"
      ? { id: uid("c"), key, kind: "image", duration: 0, in: 0, out: 3, volume: 1, muted: true }
      : { id: uid("c"), key, kind: "video", duration: r2(d), in: 0, out: r2(d ? Math.min(d, 5) : 5), volume: 1, muted: false };
    change((e) => ({ ...e, clips: [...e.clips.slice(0, where.index), clip, ...e.clips.slice(where.index)] }));
    setSel({ kind: "clip", id: clip.id });
  };
  const tapAdd = (key: string, kind: MediaKind) => {
    if (!edit) return;
    if (kind === "audio") addMedia(key, kind, edit.music ? { lane: "sound", time: t } : { lane: "music" });
    else addMedia(key, kind, { lane: "video", index: edit.clips.length });
  };

  // ---- drag from the panels (files, transitions): a ghost follows the finger; drop on a track or a cut.
  const lanes = useRef<HTMLDivElement>(null);
  const payloadDrag = useRef<{ p: Payload; x0: number; y0: number; active: boolean; label: string } | null>(null);
  const item = useRef<ItemDrag | null>(null);
  const justDragged = useRef(false);

  const timeAtX = (x: number) => {
    const el = lanes.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, (x - r.left - LANE_PAD) / zoom);
  };
  const indexAtTime = (time: number, skipId?: string) => {
    const e = editRef.current;
    if (!e) return 0;
    let idx = 0;
    e.clips.forEach((c, i) => { if (c.id !== skipId && time > starts[i] + clipLen(c) / 2) idx = i + 1; });
    return idx;
  };
  const dropTarget = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return el?.closest<HTMLElement>("[data-drop]") || null;
  };

  const grab = (e: React.PointerEvent, p: Payload, label: string) => {
    if (locked) return;
    e.preventDefault();
    payloadDrag.current = { p, x0: e.clientX, y0: e.clientY, active: false, label };
  };
  const startItem = (e: React.PointerEvent, what: ItemDrag["what"], id: string, mode: ItemDrag["mode"], orig: ItemDrag["orig"]) => {
    if (locked && what !== "ruler") return;
    e.stopPropagation();
    const touch = e.pointerType === "touch";
    const d: ItemDrag = { what, id, mode, x0: e.clientX, y0: e.clientY, pid: e.pointerId, touch, armed: !touch || mode !== "move" || what === "ruler", active: false, orig: orig ? structuredClone(orig) : null };
    if (touch && !d.armed) d.timer = setTimeout(() => { if (item.current === d) { d.armed = true; navigator.vibrate?.(8); setDragOffset({ id, px: 0 }); } }, HOLD_MS);
    item.current = d;
    if (what === "ruler") { d.active = true; seek(timeAtX(e.clientX)); }
  };

  useEffect(() => {
    const snapTo = (v: number, skip?: string) => {
      const e = editRef.current;
      if (!e) return v;
      const cands = [0, tRef.current, ...e.clips.flatMap((c, i) => [starts[i], starts[i] + clipLen(c)]), ...e.texts.filter((x) => x.id !== skip).flatMap((x) => [x.start, x.end])];
      for (const c of cands) if (Math.abs(c - v) * zoom < 8) return c;
      return v;
    };
    const move = (ev: PointerEvent) => {
      const pd = payloadDrag.current;
      if (pd) {
        if (!pd.active && Math.hypot(ev.clientX - pd.x0, ev.clientY - pd.y0) > 6) pd.active = true;
        if (pd.active) {
          setGhost({ x: ev.clientX, y: ev.clientY, label: pd.label });
          const tgt = dropTarget(ev.clientX, ev.clientY);
          setHover(tgt ? `${tgt.dataset.drop}:${tgt.dataset.id || ""}` : null);
          if (tgt?.dataset.drop === "video" && pd.p.kind === "media") setInsertAt(indexAtTime(timeAtX(ev.clientX)));
          else setInsertAt(null);
        }
        return;
      }
      const d = item.current;
      if (!d) return;
      const dist = Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0);
      if (!d.armed) { if (dist > 8) { clearTimeout(d.timer); item.current = null; setDragOffset(null); } return; }
      if (!d.active && dist < 3) return;
      d.active = true;
      const dx = (ev.clientX - d.x0) / zoom;
      const tag = `drag-${d.id}-${d.x0}`;
      if (d.what === "ruler") { seek(timeAtX(ev.clientX)); return; }
      if (d.what === "clip") {
        const o = d.orig as EditClip;
        if (d.mode === "move") { setDragOffset({ id: d.id, px: ev.clientX - d.x0 }); setInsertAt(indexAtTime(timeAtX(ev.clientX), d.id)); return; }
        if (o.kind === "image") {
          const len = Math.max(0.5, (o.out - o.in) + (d.mode === "right" ? dx : -dx));
          updClip(d.id, { in: 0, out: r2(len) }, tag);
        } else if (d.mode === "left") updClip(d.id, { in: r2(Math.min(o.out - 0.2, Math.max(0, o.in + dx))) }, tag);
        else updClip(d.id, { out: r2(Math.max(o.in + 0.2, Math.min(o.duration || o.out + dx, o.out + dx))) }, tag);
        return;
      }
      if (d.what === "text") {
        const o = d.orig as EditText;
        if (d.mode === "move") { const s = snapTo(Math.max(0, o.start + dx), d.id); updText(d.id, { start: r2(s), end: r2(s + (o.end - o.start)) }, tag); }
        else if (d.mode === "left") updText(d.id, { start: r2(Math.min(o.end - 0.2, snapTo(Math.max(0, o.start + dx), d.id))) }, tag);
        else updText(d.id, { end: r2(Math.max(o.start + 0.2, snapTo(o.end + dx, d.id))) }, tag);
        return;
      }
      if (d.what === "audio") {
        const o = d.orig as EditAudio;
        if (d.mode === "move") updAudio(d.id, { start: r2(snapTo(Math.max(0, o.start + dx))) }, tag);
        else if (d.mode === "left") {
          const nin = Math.min(o.out - 0.2, Math.max(0, o.in + dx));
          updAudio(d.id, { in: r2(nin), start: r2(Math.max(0, o.start + (nin - o.in))) }, tag);
        } else updAudio(d.id, { out: r2(Math.max(o.in + 0.2, Math.min(o.duration || o.out + dx, o.out + dx))) }, tag);
      }
    };
    const up = (ev: PointerEvent) => {
      const pd = payloadDrag.current;
      if (pd) {
        payloadDrag.current = null;
        setGhost(null); setHover(null); setInsertAt(null);
        if (!pd.active) return;
        const tgt = dropTarget(ev.clientX, ev.clientY);
        const e = editRef.current;
        if (!tgt || !e) return;
        const lane = tgt.dataset.drop;
        if (pd.p.kind === "transition") {
          let clipId = lane === "cut" ? tgt.dataset.id : undefined;
          if (!clipId && lane === "video" && e.clips.length > 1) {
            // Nearest cut to the drop point.
            const time = timeAtX(ev.clientX);
            let best = 0, bestD = Infinity;
            for (let i = 0; i < e.clips.length - 1; i++) { const dd = Math.abs(starts[i + 1] - time); if (dd < bestD) { bestD = dd; best = i; } }
            clipId = e.clips[best].id;
          }
          if (clipId) { setTransition(clipId, pd.p.id); setSel({ kind: "cut", id: clipId }); }
          else setNotice("Drop a transition on a ◆ between two clips.");
          return;
        }
        const time = timeAtX(ev.clientX);
        if (lane === "video") addMedia(pd.p.key, pd.p.media, { lane: "video", index: indexAtTime(time) });
        else if (lane === "sound") addMedia(pd.p.key, pd.p.media, { lane: "sound", time });
        else if (lane === "music") addMedia(pd.p.key, pd.p.media, { lane: "music" });
        return;
      }
      const d = item.current;
      if (!d) return;
      clearTimeout(d.timer);
      item.current = null;
      if (d.what === "clip" && d.mode === "move" && d.active) {
        const to = indexAtTime(timeAtX(ev.clientX), d.id);
        const e = editRef.current;
        const from = e ? e.clips.findIndex((c) => c.id === d.id) : -1;
        if (e && from >= 0 && to !== from && to !== from + 1) reorder(d.id, to > from ? to + 1 : to);
      }
      setDragOffset(null); setInsertAt(null);
      if (d.active) { justDragged.current = true; setTimeout(() => { justDragged.current = false; }, 0); }
    };
    const cancel = () => {
      if (item.current) { clearTimeout(item.current.timer); item.current = null; }
      payloadDrag.current = null;
      setGhost(null); setHover(null); setInsertAt(null); setDragOffset(null);
    };
    // While something is dragged, stop the page and the timeline from scrolling under the finger.
    const block = (ev: TouchEvent) => { if (payloadDrag.current?.active || (item.current && item.current.armed)) ev.preventDefault(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", block, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", block);
    };
  });

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (tag === "BUTTON" && e.code === "Space") return;
      if (e.code === "Space") { e.preventDefault(); playing ? stop() : play(); }
      if (e.key === "ArrowLeft") seek(tRef.current - (e.shiftKey ? 1 : 0.1));
      if (e.key === "ArrowRight") seek(tRef.current + (e.shiftKey ? 1 : 0.1));
      if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) splitAtPlayhead();
      if ((e.key === "Delete" || e.key === "Backspace") && sel && !locked) {
        e.preventDefault();
        if (sel.kind === "clip") delClip(sel.id);
        else if (sel.kind === "text") delText(sel.id);
        else if (sel.kind === "audio") delAudio(sel.id);
        else if (sel.kind === "cut") setTransition(sel.id, null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
  const audios = edit.audios || [];
  const span = Math.max(total, ...audios.map((a) => a.start + (a.out - a.in)), ...edit.texts.map((x) => x.end));
  const width = Math.max(span * zoom + LANE_PAD * 2 + 60, 320);
  // Sound track rows: linked clip sounds on row 0, separate sounds on the first row where they don't overlap.
  const rowEnds: number[] = [];
  const linked = edit.clips.map((c, i) => (c.kind === "video" && !c.detached ? [starts[i], starts[i] + clipLen(c)] : null)).filter(Boolean) as number[][];
  if (linked.length) rowEnds[0] = Infinity;
  const linkedFree = (a0: number, a1: number) => linked.every(([l0, l1]) => a1 <= l0 + 0.01 || a0 >= l1 - 0.01);
  const audioRow: Record<string, number> = {};
  const rowItems: number[][][] = [];
  for (const a of [...audios].sort((x, y) => x.start - y.start)) {
    const a0 = a.start, a1 = a.start + (a.out - a.in);
    let r = 0;
    for (;; r++) {
      const busy = (rowItems[r] || []).some(([b0, b1]) => a0 < b1 - 0.01 && a1 > b0 + 0.01) || (r === 0 && linked.length > 0 && !linkedFree(a0, a1));
      if (!busy) break;
    }
    (rowItems[r] = rowItems[r] || []).push([a0, a1]);
    audioRow[a.id] = r;
  }
  const soundRows = Math.max(1, ...Object.values(audioRow).map((r) => r + 1));
  // Transition under the playhead (preview).
  let fx: { media: CSSProperties; veil?: CSSProperties; under?: string } = { media: {} };
  for (let i = 0; i < edit.clips.length - 1; i++) {
    const d = trans[i];
    if (d > 0 && t >= starts[i + 1] && t < starts[i + 1] + d && edit.clips[i].transition) {
      const look = transitionStyle(edit.clips[i].transition!.type, (t - starts[i + 1]) / d);
      fx = { ...look, under: urls[`thumbs/${edit.clips[i].key}.jpg`] };
    }
  }

  return (
    <div className="editor">
      {/* ---- header */}
      <div className="ed-head">
        <IconButton icon="back" label="Back to the queue" onClick={onBack} />
        <label className="ed-title">
          <span className="visually-hidden">Title</span>
          <input type="text" value={edit.title || ""} placeholder="Untitled" maxLength={140} disabled={locked}
            onChange={(e) => change((x) => ({ ...x, title: e.target.value || null }), "title")} />
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
          <div className={`ed-frame ed-frame--${edit.framing}`} style={{ aspectRatio: FORMAT_RATIO[edit.format], ...(fx.under ? { backgroundImage: `url("${fx.under}")` } : {}) }}>
            {curClip && curClip.kind === "image" && urls[curClip.key] && <img className="ed-media" src={urls[curClip.key]} alt="" style={fx.media} />}
            <video ref={video} className="ed-media" playsInline preload="auto" poster={curClip ? urls[`thumbs/${curClip.key}.jpg`] || undefined : undefined}
              hidden={!curClip || curClip.kind !== "video"} style={fx.media} />
            {fx.veil && <span className="ed-veil" style={fx.veil} aria-hidden="true" />}
            {!edit.clips.length && <p className="ed-empty">The timeline is empty. Open Media and drag clips onto the video track.</p>}
            {textsNow.map((x) => (
              <span key={x.id} className={`ed-text ed-text--${x.position} ed-text--${x.size}`} style={fontFamily(x.font)}>{x.text}</span>
            ))}
          </div>
          <audio ref={music} preload="auto" />
          <div className="ed-transport">
            <button type="button" className="icon-btn" onClick={() => (playing ? stop() : play())} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (space)" : "Play (space)"}>
              <Icon name={playing ? "pause" : "play"} />
            </button>
            <input className="ed-scrub" type="range" min={0} max={Math.max(0.1, total)} step={0.05} value={Math.min(t, total)} onChange={(e) => seek(Number(e.target.value))} aria-label="Playhead" />
            <span className="ed-time num">{clock(Math.min(t, total))} / {clock(total)}</span>
          </div>
        </div>

        {/* ---- side panel: inspector, media, transitions */}
        <aside className="ed-panel" aria-label="Editor panel">
          <div className="segmented ed-tabs" role="tablist" aria-label="Panel">
            {([["inspect", "Inspect", "inspect"], ["media", "Media", "media"], ["transitions", "Transitions", "transition"]] as [Tab, string, IconName][]).map(([id, label, icon]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className="segmented__item" onClick={() => setTab(id)}>
                <Icon name={icon} size={16} /> {label}
              </button>
            ))}
          </div>
          {tab === "media" ? (
            <MediaBin disabled={locked} onAdd={tapAdd} onGrab={(e, key, kind) => grab(e, { kind: "media", key, media: kind }, fileName(key))} />
          ) : tab === "transitions" ? (
            <TransitionLibrary selected={sel?.kind === "cut" && selClip ? selClip.transition?.type ?? null : null} disabled={locked}
              hasCut={sel?.kind === "cut"} cuts={Math.max(0, edit.clips.length - 1)}
              onGrab={(e, id) => grab(e, { kind: "transition", id }, transitionLabel(id))}
              onPick={(id) => { if (sel?.kind === "cut") setTransition(sel.id, id); else setNotice("Tap a ◆ between two clips first, or drag the transition onto one."); }}
              onAll={(id) => setAllTransitions(id)} />
          ) : sel?.kind === "cut" && selClip ? (
            <CutInspector clip={selClip} next={edit.clips[edit.clips.findIndex((c) => c.id === selClip.id) + 1]} disabled={locked}
              length={trans[edit.clips.findIndex((c) => c.id === selClip.id)] || 0}
              set={(type, dur) => setTransition(selClip.id, type, dur)} browse={() => setTab("transitions")} close={() => setSelState(null)} />
          ) : selClip ? (
            <ClipInspector clip={selClip} index={edit.clips.findIndex((c) => c.id === selClip.id)} count={edit.clips.length} disabled={locked}
              playheadSrc={curClip && curClip.id === selClip.id ? selClip.in + (t - starts[cur]) : null}
              update={(p, tag) => updClip(selClip.id, p, tag)} move={(d) => moveClip(selClip.id, d)} dup={() => dupClip(selClip.id)} del={() => delClip(selClip.id)}
              detach={() => detach(selClip.id)} reattach={() => reattach(selClip.id)} close={() => setSelState(null)} />
          ) : selText ? (
            <TextInspector text={selText} t={t} disabled={locked} update={(p, tag) => updText(selText.id, p, tag)} del={() => delText(selText.id)} close={() => setSelState(null)} />
          ) : selAudio ? (
            <AudioInspector audio={selAudio} disabled={locked} canReattach={Boolean(selAudio.fromClip && edit.clips.some((c) => c.id === selAudio.fromClip))}
              update={(p, tag) => updAudio(selAudio.id, p, tag)} del={() => delAudio(selAudio.id)} reattach={() => selAudio.fromClip && reattach(selAudio.fromClip)} close={() => setSelState(null)} />
          ) : (
            <ProjectPanel edit={edit} disabled={locked} change={change}
              reset={() => { if (window.confirm("Replace your changes with YT Boy’s original draft?")) { stop(); setSelState(null); load(true).then((e) => e && flush({ ...e, audios: e.audios || [] })); } }} />
          )}
        </aside>
      </div>

      {/* ---- timeline */}
      <section className="ed-tl" aria-label="Timeline">
        <div className="ed-tools">
          <IconButton icon="undo" label="Undo (Ctrl+Z)" onClick={undo} disabled={locked || !past.current.length} />
          <IconButton icon="redo" label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={locked || !future.current.length} />
          <button type="button" className="btn btn--small" onClick={() => setTab("media")} disabled={locked}><Icon name="plus" size={16} /> Media</button>
          <button type="button" className="btn btn--small" onClick={addText} disabled={locked}><Icon name="text" size={16} /> Text</button>
          <button type="button" className="btn btn--small" onClick={splitAtPlayhead} disabled={locked || !curClip}><Icon name="split" size={16} /> Split</button>
          <button type="button" className="btn btn--small" onClick={() => setTab("transitions")} disabled={locked || edit.clips.length < 2}><Icon name="transition" size={16} /> Transitions</button>
          <label className="ed-zoom">
            <span>Zoom</span>
            <input type="range" min={16} max={200} step={4} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          </label>
        </div>

        <div className="ed-tracks">
          <div className="ed-track-inner" ref={lanes} style={{ width: `${width}px`, ["--pps" as string]: `${zoom}px`, ["--pad" as string]: `${LANE_PAD}px` }}>
            {/* ruler: drag to scrub */}
            <div className="ed-ruler" onPointerDown={(e) => startItem(e, "ruler", "ruler", "move", null)} aria-hidden="true">
              {Array.from({ length: Math.ceil(span) + 2 }, (_, s) => (
                <span key={s} className="ed-tick" style={{ left: `${LANE_PAD + s * zoom}px` }}>{zoom >= 28 || s % 5 === 0 ? clock(s).replace(/\.0$/, "") : ""}</span>
              ))}
            </div>

            {/* text track */}
            <div className={`ed-lane ed-lane--text${hover?.startsWith("text") ? " ed-lane--hot" : ""}`} data-drop="text">
              <span className="ed-lane__label"><Icon name="text" size={14} /> Text</span>
              {edit.texts.map((x) => (
                <div key={x.id} className={`ed-item ed-item--text${sel?.id === x.id ? " ed-item--on" : ""}`}
                  style={{ left: `${LANE_PAD + x.start * zoom}px`, width: `${Math.max(18, (x.end - x.start) * zoom)}px`, ...fontFamily(x.font) }}
                  onPointerDown={(e) => startItem(e, "text", x.id, "move", x)}
                  onClick={() => { if (justDragged.current) return; setSel({ kind: "text", id: x.id }); seek(x.start); }}
                  role="button" tabIndex={0} aria-label={`Text: ${x.text}, ${clock(x.start)} to ${clock(x.end)}`}
                  onKeyDown={(e) => e.key === "Enter" && setSel({ kind: "text", id: x.id })}>
                  <Handle side="left" onDown={(e) => startItem(e, "text", x.id, "left", x)} />
                  <span className="ed-item__label">{x.text}</span>
                  <Handle side="right" onDown={(e) => startItem(e, "text", x.id, "right", x)} />
                </div>
              ))}
            </div>

            {/* video track */}
            <div className={`ed-lane ed-lane--video${hover?.startsWith("video") ? " ed-lane--hot" : ""}`} data-drop="video">
              <span className="ed-lane__label"><Icon name="film" size={14} /> Video</span>
              {edit.clips.map((c, i) => {
                const thumb = urls[`thumbs/${c.key}.jpg`];
                const off = dragOffset?.id === c.id ? dragOffset.px : 0;
                return (
                  <div key={c.id} className={`ed-item ed-item--clip${sel?.kind === "clip" && sel.id === c.id ? " ed-item--on" : ""}${i === cur ? " ed-item--cur" : ""}${off || dragOffset?.id === c.id ? " ed-item--lift" : ""}`}
                    style={{ left: `${LANE_PAD + starts[i] * zoom}px`, width: `${Math.max(8, clipLen(c) * zoom)}px`, transform: off ? `translateX(${off}px)` : undefined, ...(thumb ? { backgroundImage: `url("${thumb}")` } : {}) }}
                    onPointerDown={(e) => startItem(e, "clip", c.id, "move", c)}
                    onClick={(e) => {
                      if (justDragged.current) return;
                      setSel({ kind: "clip", id: c.id });
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      seek(starts[i] + ((e.clientX - r.left) / r.width) * clipLen(c));
                    }}
                    role="button" tabIndex={0} aria-label={`Clip ${i + 1}: ${fileName(c.key)}, ${clipLen(c).toFixed(1)} seconds. Hold and drag to move.`}
                    onKeyDown={(e) => e.key === "Enter" && setSel({ kind: "clip", id: c.id })}>
                    <Handle side="left" onDown={(e) => startItem(e, "clip", c.id, "left", c)} />
                    <span className="ed-item__label">{i + 1}. {fileName(c.key)}</span>
                    <span className="ed-item__len num">{clipLen(c).toFixed(1)}s</span>
                    <Handle side="right" onDown={(e) => startItem(e, "clip", c.id, "right", c)} />
                  </div>
                );
              })}
              {/* cuts: tap to pick a transition, or drop one here */}
              {edit.clips.slice(0, -1).map((c, i) => {
                const x = LANE_PAD + (starts[i + 1] + trans[i] / 2) * zoom;
                const on = sel?.kind === "cut" && sel.id === c.id;
                return (
                  <button key={`cut-${c.id}`} type="button" data-drop="cut" data-id={c.id}
                    className={`ed-cut${c.transition ? " ed-cut--set" : ""}${on ? " ed-cut--on" : ""}${hover === `cut:${c.id}` ? " ed-cut--hot" : ""}`}
                    style={{ left: `${x}px` }} onClick={() => setSel({ kind: "cut", id: c.id })}
                    aria-label={c.transition ? `Transition ${i + 1}: ${transitionLabel(c.transition.type)}` : `Cut ${i + 1}: no transition. Tap to add one.`}
                    title={c.transition ? transitionLabel(c.transition.type) : "Cut: tap or drop a transition"}>
                    <Icon name="transition" size={12} />
                  </button>
                );
              })}
              {insertAt !== null && <span className="ed-insert" style={{ left: `${LANE_PAD + (insertAt < edit.clips.length ? starts[insertAt] : total) * zoom}px` }} aria-hidden="true" />}
            </div>

            {/* sound track: each clip's own sound (linked) plus separate sound items */}
            <div className={`ed-lane ed-lane--sound${hover?.startsWith("sound") ? " ed-lane--hot" : ""}`} data-drop="sound" style={{ height: `${22 + soundRows * 24}px` }}>
              <span className="ed-lane__label"><Icon name="wave" size={14} /> Sound</span>
              {edit.clips.map((c, i) => c.kind === "video" && !c.detached && (
                <div key={`ls-${c.id}`} className={`ed-item ed-item--linked${c.muted ? " ed-item--muted" : ""}`}
                  style={{ left: `${LANE_PAD + starts[i] * zoom}px`, width: `${Math.max(8, clipLen(c) * zoom)}px`, top: "20px", bottom: "auto", height: "22px" }}
                  onClick={() => setSel({ kind: "clip", id: c.id })} role="button" tabIndex={-1}
                  title={`Sound of clip ${i + 1}${c.muted ? " (muted)" : ""}. Select the clip to detach it.`}>
                  <span className="ed-item__label">{c.muted ? "muted" : `clip ${i + 1}`}</span>
                </div>
              ))}
              {audios.map((a) => (
                <div key={a.id} className={`ed-item ed-item--audio${sel?.id === a.id ? " ed-item--on" : ""}${a.muted ? " ed-item--muted" : ""}`}
                  style={{ left: `${LANE_PAD + a.start * zoom}px`, width: `${Math.max(12, (a.out - a.in) * zoom)}px`, top: `${20 + (audioRow[a.id] || 0) * 24}px`, bottom: "auto", height: "22px" }}
                  onPointerDown={(e) => startItem(e, "audio", a.id, "move", a)}
                  onClick={() => { if (justDragged.current) return; setSel({ kind: "audio", id: a.id }); }}
                  role="button" tabIndex={0} aria-label={`Sound: ${fileName(a.key)}, from ${clock(a.start)}`}
                  onKeyDown={(e) => e.key === "Enter" && setSel({ kind: "audio", id: a.id })}>
                  <Handle side="left" onDown={(e) => startItem(e, "audio", a.id, "left", a)} />
                  <span className="ed-item__label"><Icon name={a.fromClip ? "unlink" : "music"} size={12} /> {fileName(a.key)}</span>
                  <Handle side="right" onDown={(e) => startItem(e, "audio", a.id, "right", a)} />
                </div>
              ))}
            </div>

            {/* music track */}
            <div className={`ed-lane ed-lane--music${hover?.startsWith("music") ? " ed-lane--hot" : ""}`} data-drop="music">
              <span className="ed-lane__label"><Icon name="music" size={14} /> Music</span>
              {edit.music ? (
                <div className="ed-item ed-item--music" style={{ left: `${LANE_PAD}px`, width: `${Math.max(40, total * zoom)}px` }}
                  onClick={() => { setSelState(null); setTab("inspect"); }} role="button" tabIndex={0} aria-label={`Music: ${fileName(edit.music.key)}. Open video settings.`}>
                  <span className="ed-item__label"><Icon name="music" size={12} /> {fileName(edit.music.key)}</span>
                </div>
              ) : <span className="ed-lane__empty" style={{ left: `${LANE_PAD + 70}px` }}>Drop a song here</span>}
            </div>

            <span className="ed-playhead" style={{ transform: `translateX(${LANE_PAD + Math.min(t, total) * zoom}px)` }} aria-hidden="true" />
          </div>
        </div>
        <p className="hint">Drag the ruler to scrub. Hold a clip, then drag to move it; drag its edges to trim. Tap ◆ between clips for a transition. Space plays, S splits, Delete removes, Ctrl+Z undoes.</p>
      </section>

      {ghost && <div className="ed-ghost" style={{ transform: `translate(${ghost.x + 12}px, ${ghost.y + 12}px)` }} aria-hidden="true">{ghost.label}</div>}
    </div>
  );
}

const LANE_PAD = 8;

function Handle({ side, onDown }: { side: "left" | "right"; onDown: (e: React.PointerEvent) => void }) {
  return <span className={`ed-handle ed-handle--${side}`} onPointerDown={onDown} aria-hidden="true" />;
}

function fixClip(c: EditClip): EditClip {
  const max = c.kind === "image" ? 600 : c.duration || 36000;
  const inP = Math.max(0, Math.min(c.in, max - 0.1));
  const outP = Math.max(inP + 0.1, Math.min(c.out, max));
  return { ...c, in: r2(inP), out: r2(outP) };
}
function fixAudio(a: EditAudio): EditAudio {
  const max = a.duration || 36000;
  const inP = Math.max(0, Math.min(a.in, max - 0.1));
  const outP = Math.max(inP + 0.1, Math.min(a.out, max));
  return { ...a, in: r2(inP), out: r2(outP), start: r2(Math.max(0, a.start)) };
}

function mediaDuration(src: string, tag: "video" | "audio"): Promise<number> {
  return new Promise((ok) => {
    const v = document.createElement(tag);
    v.preload = "metadata";
    v.muted = true;
    let finished = false;
    const done = (d: number) => { if (finished) return; finished = true; v.removeAttribute("src"); v.load(); ok(d); };
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

function Head({ title, close }: { title: string; close: () => void }) {
  return (
    <div className="ed-insp__head">
      <h3>{title}</h3>
      <button type="button" className="link" onClick={close}>Done</button>
    </div>
  );
}

function ClipInspector({ clip: c, index, count, playheadSrc, disabled, update, move, dup, del, detach, reattach, close }: {
  clip: EditClip; index: number; count: number; playheadSrc: number | null; disabled: boolean;
  update: (p: Partial<EditClip>, tag?: string) => void; move: (d: -1 | 1) => void; dup: () => void; del: () => void; detach: () => void; reattach: () => void; close: () => void;
}) {
  const max = c.kind === "image" ? 60 : c.duration;
  return (
    <div className="ed-insp">
      <Head title={`Clip ${index + 1} of ${count}`} close={close} />
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
          <div className="ed-sub">
            <h4><Icon name="wave" size={14} /> Sound</h4>
            {c.detached ? (
              <>
                <p className="row__meta">This clip’s sound is a separate item on the sound track. Move, trim or mute it there.</p>
                <button type="button" className="btn btn--small" disabled={disabled} onClick={reattach}><Icon name="link" size={16} /> Re-attach sound</button>
              </>
            ) : (
              <>
                <label className="ed-slider">
                  <span>Volume <span className="num">{Math.round(c.volume * 100)}%</span></span>
                  <input type="range" min={0} max={2} step={0.05} value={c.volume} disabled={disabled || c.muted} onChange={(e) => update({ volume: Number(e.target.value) }, `vol-${c.id}`)} />
                </label>
                <label className="toggle"><input type="checkbox" checked={c.muted} disabled={disabled} onChange={(e) => update({ muted: e.target.checked })} /><span>Mute this clip</span></label>
                <button type="button" className="btn btn--small" disabled={disabled} onClick={detach}><Icon name="unlink" size={16} /> Detach sound</button>
              </>
            )}
          </div>
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

function CutInspector({ clip: c, next, length, disabled, set, browse, close }: {
  clip: EditClip; next?: EditClip; length: number; disabled: boolean; set: (type: TransitionId | null, dur?: number) => void; browse: () => void; close: () => void;
}) {
  const tr = c.transition;
  const maxD = next ? Math.max(0.2, Math.min(clipLen(c), clipLen(next)) / 2 - 0.05) : 1;
  return (
    <div className="ed-insp">
      <Head title="Transition" close={close} />
      <p className="row__meta">Between {fileName(c.key)} and {next ? fileName(next.key) : "the end"}.</p>
      <label className="field field--tight">
        <span>Type</span>
        <select value={tr?.type || ""} disabled={disabled} onChange={(e) => set((e.target.value || null) as TransitionId | null)}>
          <option value="">Cut (no transition)</option>
          {(["Fades", "Motion", "Shapes", "Effects"] as const).map((g) => (
            <optgroup key={g} label={g}>{TRANSITIONS.filter((x) => x.group === g).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</optgroup>
          ))}
        </select>
      </label>
      {tr && (
        <label className="ed-slider">
          <span>Length <span className="num">{(length || tr.duration).toFixed(1)} s</span>{length && length < tr.duration ? " (shortened to fit the clips)" : ""}</span>
          <input type="range" min={0.2} max={Math.min(3, Math.max(0.3, maxD))} step={0.1} value={Math.min(tr.duration, Math.max(0.3, maxD))} disabled={disabled} onChange={(e) => set(tr.type, Number(e.target.value))} />
        </label>
      )}
      <div className="ed-row">
        <button type="button" className="btn btn--small" onClick={browse}><Icon name="transition" size={16} /> Browse transitions</button>
        {tr && <IconButton icon="trash" label="Remove transition" danger disabled={disabled} onClick={() => set(null)} />}
      </div>
    </div>
  );
}

function TextInspector({ text: x, t, disabled, update, del, close }: { text: EditText; t: number; disabled: boolean; update: (p: Partial<EditText>, tag?: string) => void; del: () => void; close: () => void }) {
  return (
    <div className="ed-insp">
      <Head title="Text" close={close} />
      <label className="field field--tight">
        <span>Words</span>
        <textarea rows={2} maxLength={200} value={x.text} disabled={disabled} onChange={(e) => update({ text: e.target.value }, `txt-${x.id}`)} style={{ ...fontFamily(x.font), fontSize: "1.1rem" }} />
      </label>
      <div className="ed-choice">
        <span className="ed-choice__label">Font</span>
        <div className="ed-fonts" role="radiogroup" aria-label="Font">
          {TEXT_FONTS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={(x.font || "barlow") === f.id} className="ed-font" disabled={disabled}
              style={fontFamily(f.id as FontId)} onClick={() => update({ font: f.id })}>{f.label}</button>
          ))}
        </div>
      </div>
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

function AudioInspector({ audio: a, disabled, canReattach, update, del, reattach, close }: {
  audio: EditAudio; disabled: boolean; canReattach: boolean; update: (p: Partial<EditAudio>, tag?: string) => void; del: () => void; reattach: () => void; close: () => void;
}) {
  return (
    <div className="ed-insp">
      <Head title="Sound" close={close} />
      <p className="row__meta">{fileName(a.key)}{a.fromClip ? ", detached from its clip" : ""}{a.duration ? `, source ${a.duration.toFixed(1)} s` : ""}</p>
      <div className="ed-row">
        <Num label="Starts at, s" value={a.start} disabled={disabled} onChange={(n) => update({ start: n })} />
      </div>
      <div className="ed-row">
        <Num label="In, s" value={a.in} max={a.duration || undefined} disabled={disabled} onChange={(n) => update({ in: n })} />
        <Num label="Out, s" value={a.out} max={a.duration || undefined} disabled={disabled} onChange={(n) => update({ out: n })} />
      </div>
      <label className="ed-slider">
        <span>Volume <span className="num">{Math.round(a.volume * 100)}%</span></span>
        <input type="range" min={0} max={2} step={0.05} value={a.volume} disabled={disabled || a.muted} onChange={(e) => update({ volume: Number(e.target.value) }, `avol-${a.id}`)} />
      </label>
      <label className="toggle"><input type="checkbox" checked={a.muted} disabled={disabled} onChange={(e) => update({ muted: e.target.checked })} /><span>Mute</span></label>
      <div className="ed-row ed-row--icons">
        {canReattach && <button type="button" className="btn btn--small" disabled={disabled} onClick={reattach}><Icon name="link" size={16} /> Re-attach to clip</button>}
        <IconButton icon="trash" label="Delete sound" danger disabled={disabled} onClick={del} />
      </div>
    </div>
  );
}

/* Library of transitions: each tile plays its effect; drag onto a ◆ or tap with a cut selected. */
function TransitionLibrary({ selected, hasCut, cuts, disabled, onGrab, onPick, onAll }: {
  selected: TransitionId | null; hasCut: boolean; cuts: number; disabled: boolean;
  onGrab: (e: React.PointerEvent, id: TransitionId) => void; onPick: (id: TransitionId) => void; onAll: (id: TransitionId | null) => void;
}) {
  const [p, setP] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      const c = ((now - t0) / 1800) % 1; // 0.25 s hold on A, transition, hold on B
      setP(Math.max(0, Math.min(1, (c - 0.2) / 0.55)));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const [last, setLast] = useState<TransitionId | null>(selected);
  return (
    <div className="ed-insp">
      <p className="hint">{hasCut ? "Tap a transition to use it on the selected cut, or drag it onto any ◆ on the video track." : "Drag a transition onto a ◆ between two clips, or tap a ◆ first and then a transition."}</p>
      {(["Fades", "Motion", "Shapes", "Effects"] as const).map((g) => (
        <div key={g} className="trx">
          <h4>{g}</h4>
          <div className="trx__grid">
            {TRANSITIONS.filter((x) => x.group === g).map((x) => {
              const look = transitionStyle(x.id, p);
              return (
                <button key={x.id} type="button" className={`trx__tile${selected === x.id ? " trx__tile--on" : ""}`} disabled={disabled}
                  onPointerDown={(e) => onGrab(e, x.id)} onClick={() => { setLast(x.id); onPick(x.id); }}
                  aria-label={`${x.label}${selected === x.id ? ", in use" : ""}`} aria-pressed={selected === x.id}>
                  <span className="trx__demo" aria-hidden="true">
                    <span className="trx__a">A</span>
                    <span className="trx__b" style={look.media}>B</span>
                    {look.veil && <span className="trx__veil" style={look.veil} />}
                  </span>
                  <span className="trx__name">{x.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {cuts > 0 && (
        <div className="ed-row ed-row--icons">
          <button type="button" className="btn btn--small" disabled={disabled || !last} onClick={() => last && onAll(last)}>Use {last ? transitionLabel(last) : "it"} on all {cuts} cuts</button>
          <button type="button" className="btn btn--small" disabled={disabled} onClick={() => onAll(null)}>Remove all</button>
        </div>
      )}
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

function ProjectPanel({ edit, change, disabled, reset }: { edit: Edit; change: (fn: (e: Edit) => Edit, tag?: string) => void; disabled: boolean; reset: () => void }) {
  return (
    <div className="ed-insp">
      <div className="ed-insp__head"><h3>Video settings</h3></div>
      <p className="hint">Tap anything on the timeline to change it here.</p>
      <Choice label="Format" value={edit.format} disabled={disabled} options={FORMATS.map((f) => [f.id, f.label.split(" ")[1] || f.label])}
        onChange={(v) => change((e) => ({ ...e, format: v as FormatId }))} />
      <Choice label="Framing" value={edit.framing} disabled={disabled} options={[["fit", "Whole shot"], ["fill", "Fill frame"]]}
        onChange={(v) => change((e) => ({ ...e, framing: v as Edit["framing"] }))} />
      <label className="toggle"><input type="checkbox" checked={edit.captions} disabled={disabled} onChange={(e) => change((x) => ({ ...x, captions: e.target.checked }))} /><span>Burn in captions from speech</span></label>
      <div className="ed-row">
        <Num label="Fade in, s" value={edit.fadeIn} max={5} disabled={disabled} onChange={(n) => change((e) => ({ ...e, fadeIn: n }))} />
        <Num label="Fade out, s" value={edit.fadeOut} max={5} disabled={disabled} onChange={(n) => change((e) => ({ ...e, fadeOut: n }))} />
      </div>
      <div className="ed-sub">
        <h4><Icon name="music" size={14} /> Music</h4>
        {edit.music ? (
          <>
            <p className="row__meta">{fileName(edit.music.key)}</p>
            <label className="ed-slider">
              <span>Volume <span className="num">{Math.round(edit.music.volume * 100)}%</span></span>
              <input type="range" min={0} max={1.5} step={0.05} value={edit.music.volume} disabled={disabled} onChange={(e) => change((x) => ({ ...x, music: x.music && { ...x.music, volume: Number(e.target.value) } }), "music-vol")} />
            </label>
            <div className="ed-row">
              <Num label="Start song at, s" value={edit.music.start} disabled={disabled} onChange={(n) => change((x) => ({ ...x, music: x.music && { ...x.music, start: n } }))} />
            </div>
            <label className="toggle"><input type="checkbox" checked={edit.music.duck} disabled={disabled} onChange={(e) => change((x) => ({ ...x, music: x.music && { ...x.music, duck: e.target.checked } }))} /><span>Lower music under clip sound</span></label>
            <IconButton icon="trash" label="Remove music" danger disabled={disabled} onClick={() => change((x) => ({ ...x, music: null }))} />
          </>
        ) : (
          <p className="quiet">No music. Drag a song from Media onto the music track.</p>
        )}
      </div>
      <button type="button" className="btn btn--small ed-reset" onClick={reset} disabled={disabled}><Icon name="reset" size={16} /> Reset to YT Boy’s draft</button>
    </div>
  );
}
