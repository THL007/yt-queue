import { useEffect, useState } from "react";
import { api, getSettings, saveSettings, setupApp, status } from "../lib/api";

type Remote = { ready: boolean; appTokenSet: boolean; webhook: boolean } | null;

export function Settings({ onSaved }: { onSaved: () => void }) {
  const initial = getSettings();
  const [url, setUrl] = useState(initial.api);
  const [token, setToken] = useState(initial.token);
  const [secret, setSecret] = useState("");
  const [remote, setRemote] = useState<Remote>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [state, setState] = useState<{ kind: "idle" | "testing" | "ok" | "error"; msg?: string }>({ kind: "idle" });

  const check = async (base = url) => {
    try {
      setRemote(await status(base));
      setRemoteError(null);
    } catch (e) {
      setRemote(null);
      setRemoteError((e as Error).message);
    }
  };
  useEffect(() => {
    check(initial.api);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const firstRun = remote ? !remote.appTokenSet : false;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const base = url.trim().replace(/\/+$/, "");
    const t = token.trim();
    setState({ kind: "testing" });
    try {
      if (firstRun) {
        if (t.length < 12) throw new Error("Use at least 12 characters for the token.");
        await setupApp(base, { appToken: t, webhookSecret: secret.trim() || undefined });
      } else if (secret.trim()) {
        await setupApp(base, { webhookSecret: secret.trim() }, t);
      }
      saveSettings(base, t);
      const h = await api.health();
      setSecret("");
      await check(base);
      setState({ kind: "ok", msg: h.webhook ? "Connected. New videos go straight to YT Boy." : "Connected. Paste the webhook signing secret so new videos reach YT Boy." });
      onSaved();
    } catch (err) {
      setState({ kind: "error", msg: (err as Error).message });
    }
  };

  return (
    <>
    <form className="settings" onSubmit={submit} noValidate>
      <h2>{firstRun ? "Set up" : "Connection"}</h2>
      <p className="quiet">
        {remoteError
          ? remoteError
          : !remote
            ? "Checking the API…"
            : !remote.ready
              ? "The API is waiting for the render server to claim it. Try again in a minute."
              : firstRun
                ? "First run: choose the access token for this app. It stays on this device and in your API."
                : remote.webhook
                  ? "Sign in with your access token. The webhook to YT Boy is set."
                  : "Sign in with your access token, and paste the webhook signing secret."}
      </p>
      <div className="field">
        <label htmlFor="api">API URL</label>
        <input id="api" name="url" type="url" inputMode="url" autoComplete="url" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => check()} />
      </div>
      <div className="field">
        <label htmlFor="token">{firstRun ? "New access token, 12+ characters" : "Access token"}</label>
        <input id="token" name="password" type="password" autoComplete={firstRun ? "new-password" : "current-password"} value={token} onChange={(e) => setToken(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="secret">Webhook signing secret{remote?.webhook ? ", leave empty to keep" : ""}</label>
        <input id="secret" name="webhook-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
        <p className="hint">From OpenBot: Routines, YT Queue: drafts and exports, signing secret.</p>
      </div>
      <div className="send">
        <button type="submit" className="btn btn--primary" disabled={state.kind === "testing" || (remote !== null && !remote.ready)}>
          {state.kind === "testing" ? "Checking…" : firstRun ? "Create and connect" : "Save and test"}
        </button>
        <p className={`hint${state.kind === "error" ? " hint--error" : ""}`} role="status">
          {state.msg || ""}
        </p>
      </div>
    </form>
    {!firstRun && remote?.ready && <ClearMaterials />}
    </>
  );
}

function ClearMaterials() {
  const [state, setState] = useState<{ kind: "idle" | "busy" | "ok" | "error"; msg?: string }>({ kind: "idle" });
  const clear = async () => {
    const typed = window.prompt("This deletes every clip, photo, music file and folder in your library. Finished videos in the queue stay. Type DELETE to confirm.");
    if (typed === null) return;
    if (typed.trim() !== "DELETE") {
      setState({ kind: "error", msg: "Nothing deleted: type DELETE in capitals to confirm." });
      return;
    }
    setState({ kind: "busy" });
    try {
      const r = await api.clearMaterials();
      setState({ kind: "ok", msg: `Deleted ${r.deleted} file${r.deleted === 1 ? "" : "s"}. The library is empty.` });
    } catch (e) {
      setState({ kind: "error", msg: (e as Error).message });
    }
  };
  return (
    <section className="settings settings--danger" aria-labelledby="materials">
      <h2 id="materials">Materials</h2>
      <p className="quiet">Remove everything in the library at once. Videos that are still waiting to render will fail if their clips are gone.</p>
      <div className="send">
        <button type="button" className="btn btn--danger" onClick={clear} disabled={state.kind === "busy"}>
          {state.kind === "busy" ? "Deleting…" : "Clear all materials"}
        </button>
        <p className={`hint${state.kind === "error" ? " hint--error" : ""}`} role="status">{state.msg || ""}</p>
      </div>
    </section>
  );
}
