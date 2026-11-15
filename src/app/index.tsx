import { useEffect, useState } from "react";
import { Editor } from "../components/Editor";
import { NewVideo } from "../components/NewVideo";
import { Queue } from "../components/Queue";
import { Settings } from "../components/Settings";
import { RefreshButton, RefreshLayer } from "../components/Refresh";
import { getSettings } from "../lib/api";

type View = "queue" | "new" | "settings" | "edit";
const TABS: { id: View; label: string }[] = [
  { id: "queue", label: "Queue" },
  { id: "new", label: "New video" },
  { id: "settings", label: "Settings" },
];

function readView(): View {
  if (typeof window === "undefined") return "queue";
  const v = new URLSearchParams(window.location.search).get("view");
  return v === "new" || v === "settings" || v === "edit" ? v : "queue";
}
function readJob() {
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("job");
}

export default function Home() {
  const [view, setViewState] = useState<View>("queue");
  const [ready, setReady] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  useEffect(() => {
    const initial = getSettings().token ? readView() : "settings";
    setViewState(initial === "edit" && !readJob() ? "queue" : initial);
    setJobId(readJob());
    setReady(true);
    const onPop = () => { setViewState(readView()); setJobId(readJob()); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setView = (v: View, job?: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", v);
    if (job) url.searchParams.set("job", job);
    else url.searchParams.delete("job");
    setJobId(job || null);
    window.history.pushState({}, "", url);
    setViewState(v);
  };

  return (
    <div className="shell">
      <RefreshLayer />
      <header className="bar">
        <div className="bar__inner">
          <div className="bar__brand">
            <a className="wordmark" href="./" aria-label="YT Queue, home" onClick={(e) => { e.preventDefault(); setView("queue"); }}>
              YT Queue
            </a>
            <RefreshButton />
          </div>
          <nav aria-label="Sections">
            <ul className="tabs" role="list">
              {TABS.map((t) => (
                <li key={t.id}>
                  <a href={`?view=${t.id}`} className="tab" aria-current={view === t.id || (view === "edit" && t.id === "queue") ? "page" : undefined} onClick={(e) => { e.preventDefault(); setView(t.id); }}>
                    {t.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main className={`main${view === "edit" ? " main--wide" : ""}`}>
        {!ready ? null : view === "edit" && jobId ? (
          <>
            <h1 className="visually-hidden">Editor</h1>
            <Editor key={jobId} jobId={jobId} onBack={() => setView("queue")} />
          </>
        ) : view === "queue" ? (
          <>
            <h1 className="page-title">Your videos</h1>
            <Queue onNew={() => setView("new")} onEdit={(id) => setView("edit", id)} />
          </>
        ) : view === "new" ? (
          <>
            <h1 className="page-title">New video</h1>
            <NewVideo onQueued={() => setView("queue")} />
          </>
        ) : (
          <>
            <h1 className="page-title">Settings</h1>
            <Settings onSaved={() => {}} />
          </>
        )}
      </main>
    </div>
  );
}
