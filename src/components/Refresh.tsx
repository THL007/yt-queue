import { useEffect, useRef, useState } from "react";

/** True when running as an installed home-screen app (no browser reload button). */
export function isStandalone() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

const reload = () => window.location.reload();
const PULL = 72; // px to pull before a release reloads

/** Pull-to-refresh (home-screen app only), plus a banner when a newer build is live. */
export function RefreshLayer() {
  const [pull, setPull] = useState(0);
  const [loading, setLoading] = useState(false);
  const [update, setUpdate] = useState(false);
  const start = useRef<number | null>(null);
  const pullRef = useRef(0);

  useEffect(() => {
    if (!isStandalone()) return;
    const skip = (t: EventTarget | null) => t instanceof Element && Boolean(t.closest("input, textarea, select, video, [data-no-pull]"));
    const onStart = (e: TouchEvent) => {
      start.current = window.scrollY <= 0 && e.touches.length === 1 && !skip(e.target) ? e.touches[0].clientY : null;
    };
    const onMove = (e: TouchEvent) => {
      if (start.current === null) return;
      const dy = e.touches[0].clientY - start.current;
      if (dy <= 0 || window.scrollY > 0) { pullRef.current = 0; setPull(0); return; }
      pullRef.current = Math.min(dy * 0.5, PULL * 1.5);
      setPull(pullRef.current);
    };
    const onEnd = () => {
      if (start.current !== null && pullRef.current >= PULL) {
        setLoading(true);
        reload();
      } else setPull(0);
      start.current = null;
      pullRef.current = 0;
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  // New build check: version.json is written at build time; compare with the one this page loaded with.
  useEffect(() => {
    let mine: string | null = null;
    const get = () => fetch(`version.json?t=${Date.now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.version) || null).catch(() => null);
    const check = async () => {
      const v = await get();
      if (!v) return;
      if (mine === null) mine = v;
      else if (v !== mine) setUpdate(true);
    };
    check();
    const onVis = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(check, 5 * 60 * 1000);
    return () => { document.removeEventListener("visibilitychange", onVis); clearInterval(t); };
  }, []);

  const ready = pull >= PULL;
  return (
    <>
      {(pull > 0 || loading) && (
        <div className="ptr" style={{ transform: `translate(-50%, ${loading ? PULL * 0.6 : pull * 0.6}px)` }} role="status" aria-live="polite">
          <svg className={`ptr__icon${loading ? " ptr__icon--spin" : ""}`} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style={{ transform: loading ? undefined : `rotate(${pull * 4}deg)` }}>
            <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{loading ? "Refreshing…" : ready ? "Release to refresh" : "Pull to refresh"}</span>
        </div>
      )}
      {update && (
        <div className="update" role="status">
          <span>A new version of YT Queue is ready.</span>
          <button type="button" className="btn btn--small btn--primary" onClick={reload}>Reload</button>
        </div>
      )}
    </>
  );
}

/** Header reload button, shown only in the home-screen app. */
export function RefreshButton() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setShow(isStandalone()), []);
  if (!show) return null;
  return (
    <button type="button" className="icon-btn" aria-label="Refresh" disabled={busy} onClick={() => { setBusy(true); reload(); }}>
      <svg className={busy ? "ptr__icon--spin" : undefined} viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
