import { useCallback, useEffect, useState } from "react";
import { Icon, IconButton } from "./Icon";
import { api, bytes, Clip, fileName, Folder, folderLabel, Listing, when } from "../lib/api";

type Props = { picked: Set<string>; onToggle: (key: string) => void; refresh: number };
type Tools = { bump: () => void; allFolders: string[]; setError: (m: string | null) => void };
type NodeProps = Props & Tools;

const pathLabel = (prefix: string) => prefix.replace(/^broll\//, "").replace(/\/$/, "").split("/").map(folderLabel).join(" / ");

async function newFolder(parent: string, t: Tools) {
  const name = window.prompt(parent === "broll/" ? "New folder name" : `New subfolder in ${pathLabel(parent)}`);
  if (!name || !name.trim()) return;
  try {
    await api.createFolder(parent, name);
    t.setError(null);
    t.bump();
  } catch (e) {
    t.setError((e as Error).message);
  }
}

/** B-roll library as collapsible folders. Each folder lists its contents only when opened. */
export function Library({ picked, onToggle, refresh: outer }: Props) {
  const [root, setRoot] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ver, setVer] = useState(0);
  const [allFolders, setAllFolders] = useState<string[]>([]);
  const refresh = outer * 1000 + ver;
  const bump = useCallback(() => setVer((v) => v + 1), []);
  useEffect(() => {
    api.folders().then(setAllFolders).catch(() => {});
  }, [refresh]);
  const tools: Tools = { bump, allFolders, setError: setActionError };

  const load = useCallback(async () => {
    try {
      setRoot(await api.broll("broll/"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, refresh]);

  const toolbar = (
    <div className="lib-bar">
      <IconButton icon="folderPlus" label="New folder" onClick={() => newFolder("broll/", tools)} />
      {actionError && <span className="hint hint--error" role="alert">{actionError}</span>}
    </div>
  );

  if (error)
    return (
      <div className="state state--inline" role="alert">
        <p>{error}</p>
        <button type="button" className="btn btn--small" onClick={load}>Try again</button>
      </div>
    );
  if (!root) return <Skeleton label="Loading the library" />;
  if (!root.folders.length && !root.files.length)
    return (
      <>
        {toolbar}
        <p className="quiet">Your bucket has no B-roll yet. Upload clips above.</p>
      </>
    );

  return (
    <>
      {toolbar}
      <div className="tree">
        {root.folders.map((f) => (
          <FolderNode key={f.prefix} folder={f} picked={picked} onToggle={onToggle} refresh={refresh} defaultOpen={f.name === "_inbox"} {...tools} />
        ))}
        {root.files.length > 0 && <Files files={root.files} here="broll/" picked={picked} onToggle={onToggle} {...tools} />}
      </div>
    </>
  );
}

function FolderNode({ folder, picked, onToggle, refresh, defaultOpen = false, ...tools }: { folder: Folder; defaultOpen?: boolean } & NodeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.broll(folder.prefix));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [folder.prefix]);

  useEffect(() => {
    if (open) load(); // lazy: nothing is fetched until the folder is opened
  }, [open, load, refresh]);

  const pickedHere = data ? data.files.filter((f) => picked.has(f.key)).length : 0;
  const inbox = folder.prefix.startsWith("broll/_inbox/");

  const [sorting, setSorting] = useState(false);
  const [sortNote, setSortNote] = useState<string | null>(null);
  const sortNow = async () => {
    if (!data?.files.length) return;
    setSorting(true);
    try {
      const r = await api.organize(data.files.map((f) => f.key));
      setSortNote(r.webhook.sent ? "YT Boy is sorting these. Refresh in a few minutes." : "Couldn’t reach YT Boy: check the webhook secret in Settings.");
    } catch (e) {
      setSortNote((e as Error).message);
    } finally {
      setSorting(false);
    }
  };

  const removeFolder = async () => {
    if (!window.confirm(`Delete the folder “${pathLabel(folder.prefix)}” and everything in it? This can’t be undone.`)) return;
    try {
      await api.deleteFolder(folder.prefix);
      for (const k of [...picked]) if (k.startsWith(folder.prefix)) onToggle(k);
      tools.setError(null);
      tools.bump();
    } catch (e) {
      tools.setError((e as Error).message);
    }
  };

  return (
    <details className="folder" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="folder__head">
        <svg className="folder__chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        <span className="folder__name">{folderLabel(folder.name)}</span>
        {folder.name === "_inbox" && <span className="row__meta">YT Boy sorts these</span>}
        {data && (
          <span className="row__meta num">
            {[
              data.folders.length ? `${data.folders.length} folder${data.folders.length === 1 ? "" : "s"}` : "",
              data.files.length || !data.folders.length ? `${data.files.length} clip${data.files.length === 1 ? "" : "s"}` : "",
              pickedHere ? `${pickedHere} picked` : "",
            ].filter(Boolean).join(", ")}
          </span>
        )}
      </summary>
      {open && (
        <div className="folder__body">
          <div className="lib-bar lib-bar--folder">
            {inbox ? (
              <IconButton icon="sort" label={sorting ? "Sorting…" : "Sort now: YT Boy files these clips into folders"} disabled={sorting || !data?.files.length} onClick={sortNow} />
            ) : (
              <IconButton icon="folderPlus" label={`New subfolder in ${pathLabel(folder.prefix)}`} onClick={() => newFolder(folder.prefix, tools)} />
            )}
            <IconButton icon="trash" danger label={inbox ? "Empty inbox" : `Delete folder ${pathLabel(folder.prefix)}`} onClick={removeFolder} />
            {sortNote && <span className="hint" role="status">{sortNote}</span>}
          </div>
          {error ? (
            <div className="state state--inline" role="alert">
              <p>{error}</p>
              <button type="button" className="btn btn--small" onClick={load}>Try again</button>
            </div>
          ) : !data ? (
            <Skeleton label={`Loading ${folderLabel(folder.name)}`} />
          ) : !data.folders.length && !data.files.length ? (
            <p className="quiet">Empty.</p>
          ) : (
            <>
              {data.folders.map((f) => (
                <FolderNode key={f.prefix} folder={f} picked={picked} onToggle={onToggle} refresh={refresh} {...tools} />
              ))}
              {data.files.length > 0 && <Files files={data.files} here={folder.prefix} picked={picked} onToggle={onToggle} {...tools} />}
            </>
          )}
        </div>
      )}
    </details>
  );
}

function Files({ files, here, picked, onToggle, bump, allFolders, setError }: { files: Clip[]; here: string; picked: Set<string>; onToggle: (k: string) => void } & Tools) {
  const [busy, setBusy] = useState<string | null>(null);
  const targets = allFolders.filter((f) => f !== here && !f.startsWith("broll/_inbox/"));
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      if (picked.has(key)) onToggle(key);
      setError(null);
      bump();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = (c: Clip) => {
    if (!window.confirm(`Delete “${fileName(c.key)}”? This can’t be undone.`)) return;
    act(c.key, () => api.deleteClip(c.key));
  };
  return (
    <ul className="clips">
      {files.map((c) => (
        <li key={c.key} className="clip" aria-busy={busy === c.key}>
          <label className="clip__pick">
            <input type="checkbox" checked={picked.has(c.key)} onChange={() => onToggle(c.key)} />
            <span className="clip__thumb">
              {c.thumb ? <img src={c.thumb} alt="" loading="lazy" decoding="async" width={96} height={54} /> : <Glyph name={c.key} />}
            </span>
            <span className="clip__text">
              <span className="row__title">{fileName(c.key)}</span>
              <span className="row__meta num">{bytes(c.size)}, {when(c.uploaded)}</span>
            </span>
          </label>
          <span className="clip__actions">
            {targets.length > 0 && (
              <span className="icon-btn icon-btn--sm icon-btn--select" title="Move to folder">
                <Icon name="move" />
                <select value="" disabled={busy === c.key} aria-label={`Move ${fileName(c.key)} to a folder`}
                  onChange={(e) => e.target.value && act(c.key, () => api.moveClip(c.key, e.target.value))}>
                  <option value="">Move to…</option>
                  {targets.map((f) => <option key={f} value={f}>{pathLabel(f)}</option>)}
                </select>
              </span>
            )}
            <IconButton icon="trash" danger label={`Delete ${fileName(c.key)}`} disabled={busy === c.key} onClick={() => remove(c)} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Glyph({ name }: { name: string }) {
  const audio = /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(name);
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      {audio ? <path d="M9 18V6l10-2v12M9 18a2 2 0 11-4 0 2 2 0 014 0zm10-2a2 2 0 11-4 0 2 2 0 014 0z" fill="none" stroke="currentColor" strokeWidth="1.5" /> : <path d="M4 6h12v12H4zM16 10l4-2v8l-4-2" fill="none" stroke="currentColor" strokeWidth="1.5" />}
    </svg>
  );
}

function Skeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="row row--skeleton" />
      ))}
    </div>
  );
}
