export type JobStatus = "queued" | "preparing" | "editing" | "exporting" | "running" | "cancelling" | "done" | "failed";

/** The timeline YT Boy drafts and the user edits (jobs/<id>/edit.json). Times are seconds. */
export type EditClip = { id: string; key: string; kind: "video" | "image"; duration: number; in: number; out: number; volume: number; muted: boolean };
export type EditText = { id: string; text: string; start: number; end: number; position: "top" | "center" | "bottom"; size: "s" | "m" | "l" };
export type Edit = {
  version: 1;
  format: FormatId;
  framing: "fit" | "fill";
  title: string | null;
  captions: boolean;
  fadeIn: number;
  fadeOut: number;
  clips: EditClip[];
  texts: EditText[];
  music: { key: string; volume: number; start: number; duck: boolean } | null;
  notes?: string;
};
export const clipLen = (c: EditClip) => Math.max(0, c.out - c.in);
export const editLength = (e: Edit) => e.clips.reduce((a, c) => a + clipLen(c), 0);

export type Job = {
  id: string;
  title: string | null;
  notes: string;
  format: FormatId;
  type: VideoType | null;
  customType?: string | null;
  maxSeconds: number | null;
  captions: boolean;
  framing?: "fit" | "fill";
  clips: string[];
  status: JobStatus;
  stage?: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  output: string | null;
  thumbnail: string | null;
  durationSeconds?: number;
  error: string | null;
  log: string[];
  phase?: "draft" | "export";
  editedAt?: string;
  webhook?: { sent: boolean; status?: number; reason?: string };
};

export type Clip = { key: string; size: number; uploaded: string; thumb: string | null };
export type Folder = { prefix: string; name: string };
export type Listing = { prefix: string; folders: Folder[]; files: Clip[] };

export type FormatId = "short-9x16" | "vlog-16x9" | "square-1x1" | "portrait-4x5";

export const FORMATS: { id: FormatId; label: string; size: string; where: string }[] = [
  { id: "short-9x16", label: "Short 9:16", size: "1080 × 1920", where: "Shorts, Reels, TikTok" },
  { id: "vlog-16x9", label: "Vlog 16:9", size: "1920 × 1080", where: "YouTube" },
  { id: "square-1x1", label: "Square 1:1", size: "1080 × 1080", where: "Feed posts" },
  { id: "portrait-4x5", label: "Portrait 4:5", size: "1080 × 1350", where: "Instagram feed" },
];

export type VideoType = string;

type TypeDef = { id: string; label: string; hint: string; pace: number | null };

/** Shown first. */
export const TYPES: TypeDef[] = [
  { id: "montage", label: "Montage", hint: "Quick cuts on the beat, a recap", pace: 1.6 },
  { id: "day-in-life", label: "Day in the life", hint: "Morning to night, in order", pace: 2.8 },
  { id: "travel", label: "Travel", hint: "Places, arrivals, wide shots", pace: 3.2 },
  { id: "food", label: "Food", hint: "Close-ups, cooking, the first bite", pace: 2.4 },
  { id: "grwm", label: "Get ready with me", hint: "Steps in order, a reveal at the end", pace: 2.6 },
  { id: "tutorial", label: "How-to", hint: "Step by step, numbered titles", pace: null },
  { id: "cinematic", label: "Cinematic", hint: "Long, slow shots and a mood", pace: 5.5 },
  { id: "talking", label: "Talking head", hint: "Your voice leads, B-roll covers cuts", pace: null },
];

/** Behind "More types". */
export const MORE_TYPES: TypeDef[] = [
  { id: "explainer", label: "Illustrated explainer", hint: "Animated titles and diagrams over B-roll", pace: 4 },
  { id: "product", label: "Product or unboxing", hint: "Details, hands, the product in use", pace: 3 },
  { id: "vlog", label: "Classic vlog", hint: "A story with you in it, start to finish", pace: 3.5 },
  { id: "story", label: "Story time", hint: "One story told over matching shots", pace: 3.5 },
  { id: "bts", label: "Behind the scenes", hint: "How it was made, raw and close", pace: 2.8 },
  { id: "event", label: "Event recap", hint: "Arrival, the highlights, the crowd", pace: 2.2 },
  { id: "city-walk", label: "City walk", hint: "Streets and sounds, walking pace", pace: 4.5 },
  { id: "nature", label: "Nature", hint: "Landscapes, light, slow pans", pace: 5 },
  { id: "workout", label: "Workout", hint: "Sets and reps, energy, a timer feel", pace: 2 },
  { id: "haul", label: "Haul", hint: "One item after another, a reaction each", pace: 2.6 },
  { id: "home-tour", label: "Room or home tour", hint: "Room by room, details and corners", pace: 3.2 },
  { id: "review", label: "Review", hint: "The thing, the good, the bad, a verdict", pace: 3 },
  { id: "before-after", label: "Before and after", hint: "The start, the work, the reveal", pace: 2.4 },
  { id: "timelapse", label: "Timelapse", hint: "Sped-up clips, time passing", pace: 3 },
  { id: "sports", label: "Sports highlights", hint: "The best moments, fast and loud", pace: 1.8 },
  { id: "music-video", label: "Music video", hint: "Cut to the song you upload", pace: 1.8 },
  { id: "pets", label: "Pets", hint: "Close, funny, at their eye level", pace: 2.4 },
  { id: "family", label: "Family and kids", hint: "Warm, simple, the small moments", pace: 3 },
  { id: "qna", label: "Q and A", hint: "Question cards, your answers", pace: null },
  { id: "comedy", label: "Comedy skit", hint: "Setup, beat, punchline", pace: 2.2 },
  { id: "trailer", label: "Trailer or announcement", hint: "Build-up, title, date", pace: 1.8 },
  { id: "interview", label: "Interview", hint: "Someone talks, B-roll shows what they mean", pace: null },
];

/** Blank: a plain cut, clips in order, no styling. Custom: you describe the type. */
export const BLANK_TYPE = "blank";
export const CUSTOM_TYPE = "custom";

export function typeLabel(id: string | null | undefined, custom?: string | null) {
  if (!id) return "YT Boy picks";
  if (id === BLANK_TYPE) return "Blank";
  if (id === CUSTOM_TYPE) return custom ? `Custom: ${custom}` : "Custom";
  return [...TYPES, ...MORE_TYPES].find((t) => t.id === id)?.label ?? id;
}

export const DEFAULT_API = "https://yt-queue-api.thl007.workers.dev";

const LS_API = "yq.api";
const LS_TOKEN = "yq.token";

export function getSettings() {
  if (typeof window === "undefined") return { api: DEFAULT_API, token: "" };
  return {
    api: localStorage.getItem(LS_API) || DEFAULT_API,
    token: localStorage.getItem(LS_TOKEN) || "",
  };
}

export function saveSettings(api: string, token: string) {
  localStorage.setItem(LS_API, api.replace(/\/+$/, ""));
  localStorage.setItem(LS_TOKEN, token);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { api, token } = getSettings();
  if (!token) throw new ApiError("Add your access token in Settings.", 401);
  let res: Response;
  try {
    res = await fetch(`${api}/api${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
    });
  } catch {
    throw new ApiError("Can't reach the API. Check the URL in Settings or your connection.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data as T;
}

export async function status(apiBase: string) {
  const res = await fetch(`${apiBase.replace(/\/+$/, "")}/api/status`).catch(() => null);
  if (!res || !res.ok) throw new ApiError("Can’t reach the API. Check the URL.", res?.status ?? 0);
  return (await res.json()) as { ready: boolean; appTokenSet: boolean; webhook: boolean };
}

export async function setupApp(apiBase: string, body: { appToken?: string; webhookSecret?: string }, currentToken?: string) {
  const res = await fetch(`${apiBase.replace(/\/+$/, "")}/api/setup/app`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(currentToken ? { authorization: `Bearer ${currentToken}` } : {}) },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) throw new ApiError("Can’t reach the API. Check the URL.", 0);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Setup failed (${res.status})`, res.status);
  return data as { ok: boolean; webhook: boolean };
}

export const api = {
  health: () => call<{ ok: boolean; webhook: boolean }>("/health"),
  jobs: () => call<{ jobs: Job[] }>("/jobs").then((r) => r.jobs),
  createJob: (body: { title: string | null; notes: string; format: FormatId; type: VideoType | null; customType: string | null; clips: string[]; maxSeconds: number | null; captions: boolean; framing: "fit" | "fill" }) =>
    call<{ job: Job }>("/jobs", { method: "POST", body: JSON.stringify(body) }).then((r) => r.job),
  deleteJob: (id: string) => call<{ deleted?: boolean; cancelling?: boolean; job?: Job }>(`/jobs/${id}`, { method: "DELETE" }),
  retry: (id: string) => call<{ job: Job }>(`/jobs/${id}?action=retry`, { method: "POST" }).then((r) => r.job),
  broll: (prefix = "broll/") => call<Listing>(`/broll?prefix=${encodeURIComponent(prefix)}`),
  organize: (keys: string[]) => call<{ webhook: { sent: boolean } }>("/broll/organize", { method: "POST", body: JSON.stringify({ keys }) }),
  putThumb: (key: string, jpeg: Blob) => call(`/thumbs?key=${encodeURIComponent(key)}`, { method: "PUT", body: jpeg, headers: { "content-type": "image/jpeg" } }),
  folders: () => call<{ folders: string[] }>("/broll/folders").then((r) => r.folders),
  createFolder: (parent: string, name: string) => call<{ folder: Folder }>("/broll/folder", { method: "POST", body: JSON.stringify({ parent, name }) }).then((r) => r.folder),
  deleteFolder: (prefix: string) => call<{ deleted: number }>(`/broll/folder?prefix=${encodeURIComponent(prefix)}`, { method: "DELETE" }),
  moveClip: (from: string, toFolder: string) => call<{ moved: number }>("/broll/move", { method: "POST", body: JSON.stringify({ moves: [{ from, to: toFolder + from.split("/").pop() }] }) }),
  clearMaterials: () => call<{ deleted: number }>("/broll/all?confirm=DELETE", { method: "DELETE" }),
  deleteClip: (key: string) => call(`/broll?key=${encodeURIComponent(key)}`, { method: "DELETE" }),
  getEdit: (id: string, draft = false) => call<{ edit: Edit; job: Job }>(`/jobs/${id}/edit${draft ? "?draft=1" : ""}`),
  saveEdit: (id: string, edit: Edit) => call<{ edit: Edit; job: Job }>(`/jobs/${id}/edit`, { method: "PUT", body: JSON.stringify(edit) }),
  exportJob: (id: string) => call<{ job: Job }>(`/jobs/${id}/export`, { method: "POST" }).then((r) => r.job),
  sign: (keys: string[]) => call<{ urls: Record<string, string> }>("/sign", { method: "POST", body: JSON.stringify({ keys }) }).then((r) => r.urls),
};

const PART = 10 * 1024 * 1024;

/** Chunked upload through the Worker into R2. Calls onProgress with 0..1. */
export async function uploadFile(file: File, onProgress: (p: number) => void, signal?: AbortSignal): Promise<string> {
  const { key, uploadId } = await call<{ key: string; uploadId: string }>("/uploads", {
    method: "POST",
    body: JSON.stringify({ name: file.name, contentType: file.type }),
  });
  const total = Math.max(1, Math.ceil(file.size / PART));
  const parts: { partNumber: number; etag: string }[] = [];
  let done = 0;
  const queue = Array.from({ length: total }, (_, i) => i + 1);
  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) throw new ApiError("Upload cancelled", 0);
      const n = queue.shift()!;
      const blob = file.slice((n - 1) * PART, n * PART);
      let attempt = 0;
      for (;;) {
        try {
          const r = await call<{ partNumber: number; etag: string }>(
            `/uploads/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${n}`,
            { method: "PUT", body: blob, signal },
          );
          parts.push(r);
          break;
        } catch (e) {
          if (++attempt >= 3 || signal?.aborted) throw e;
        }
      }
      done++;
      onProgress(done / total);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
  } catch (e) {
    await call("/uploads/abort", { method: "POST", body: JSON.stringify({ key, uploadId }) }).catch(() => {});
    throw e;
  }
  parts.sort((a, b) => a.partNumber - b.partNumber);
  await call("/uploads/complete", { method: "POST", body: JSON.stringify({ key, uploadId, parts }) });
  return key;
}

export function fileName(key: string) {
  return key.split("/").pop()!.replace(/^[a-f0-9]{6}-/, "");
}

export function bytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function when(iso: string) {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function duration(s?: number) {
  if (!s && s !== 0) return "";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Grab a small JPEG from a local video or image file, in the browser, for an instant thumbnail. */
export async function makeThumb(file: File): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    let source: HTMLVideoElement | HTMLImageElement;
    let w: number, h: number;
    if (file.type.startsWith("image/")) {
      const img = new Image();
      img.src = url;
      await img.decode();
      source = img;
      w = img.naturalWidth;
      h = img.naturalHeight;
    } else if (file.type.startsWith("video/")) {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "metadata";
      v.src = url;
      await new Promise<void>((ok, bad) => { v.onloadedmetadata = () => ok(); v.onerror = () => bad(new Error("no metadata")); });
      v.currentTime = Math.min(1, (v.duration || 0) / 3);
      await new Promise<void>((ok, bad) => { v.onseeked = () => ok(); v.onerror = () => bad(new Error("seek failed")); });
      source = v;
      w = v.videoWidth;
      h = v.videoHeight;
    } else return null;
    const scale = 320 / Math.max(w, 1);
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext("2d")!.drawImage(source, 0, 0, c.width, c.height);
    return await new Promise((ok) => c.toBlob((b) => ok(b), "image/jpeg", 0.72));
  } catch {
    return null; // YT Boy fills missing thumbnails when it sorts the inbox
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function folderLabel(name: string) {
  return name === "_inbox" ? "Inbox" : name;
}
