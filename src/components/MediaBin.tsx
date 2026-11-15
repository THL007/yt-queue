import { useCallback, useEffect, useState } from "react";
import { Icon, IconButton } from "./Icon";
import { api, Clip, fileName, Folder, folderLabel, Listing } from "../lib/api";

/* Library for the editor: drag a file by its grip onto a track, or tap + to add it. */

export type MediaKind = "video" | "image" | "audio";
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|gif|bmp|tiff?)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
export const mediaKind = (key: string): MediaKind => (AUDIO_EXT.test(key) ? "audio" : IMAGE_EXT.test(key) ? "image" : "video");

type Props = {
  onGrab: (e: React.PointerEvent, key: string, kind: MediaKind) => void;
  onAdd: (key: string, kind: MediaKind) => void;
  disabled?: boolean;
};

export function MediaBin(props: Props) {
  const [root, setRoot] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.broll("broll/").then((r) => { setRoot(r); setError(null); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <p className="hint hint--error" role="alert">{error}</p>;
  if (!root) return <p className="quiet">Loading the library…</p>;
  if (!root.folders.length && !root.files.length) return <p className="quiet">The library is empty. Upload clips from New video.</p>;
  return (
    <div className="bin">
      <p className="hint">Drag a file by <Icon name="grip" size={14} /> onto the video, sound or music track, or tap + to add it.</p>
      {root.folders.map((f) => <BinFolder key={f.prefix} folder={f} {...props} open={f.name === "_inbox"} />)}
      {root.files.length > 0 && <BinFiles files={root.files} {...props} />}
    </div>
  );
}

function BinFolder({ folder, open: initial, ...props }: { folder: Folder; open?: boolean } & Props) {
  const [open, setOpen] = useState(Boolean(initial));
  const [data, setData] = useState<Listing | null>(null);
  useEffect(() => { if (open && !data) api.broll(folder.prefix).then(setData).catch(() => {}); }, [open, data, folder.prefix]);
  return (
    <details className="folder" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="folder__head">
        <svg className="folder__chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        <span className="folder__name">{folderLabel(folder.name)}</span>
        {data && <span className="row__meta num">{data.files.length || ""}</span>}
      </summary>
      {open && (
        <div className="folder__body">
          {!data ? <p className="quiet">Loading…</p> : (
            <>
              {data.folders.map((f) => <BinFolder key={f.prefix} folder={f} {...props} />)}
              {data.files.length ? <BinFiles files={data.files} {...props} /> : !data.folders.length && <p className="quiet">Empty.</p>}
            </>
          )}
        </div>
      )}
    </details>
  );
}

function BinFiles({ files, onGrab, onAdd, disabled }: { files: Clip[] } & Props) {
  return (
    <ul className="bin__list">
      {files.map((c) => {
        const kind = mediaKind(c.key);
        return (
          <li key={c.key} className="bin__item">
            <span className="bin__grip" role="button" tabIndex={-1} aria-label={`Drag ${fileName(c.key)} to the timeline`} title="Drag onto a track"
              onPointerDown={(e) => !disabled && onGrab(e, c.key, kind)}>
              <Icon name="grip" size={16} />
            </span>
            <span className="bin__thumb">{c.thumb ? <img src={c.thumb} alt="" loading="lazy" width={64} height={36} /> : <Icon name={kind === "audio" ? "music" : kind === "image" ? "media" : "film"} size={16} />}</span>
            <span className="bin__name">{fileName(c.key)}</span>
            <IconButton icon="plus" label={kind === "audio" ? `Add ${fileName(c.key)} as sound` : `Add ${fileName(c.key)} at the end`} disabled={disabled} onClick={() => onAdd(c.key, kind)} />
          </li>
        );
      })}
    </ul>
  );
}
