import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Small stroke icons drawn for this app (24-unit grid). */
const PATHS: Record<string, ReactNode> = {
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  retry: <><path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.5" /><path d="M20 3.5v5h-5" /><path d="M20 12a8 8 0 0 1-13.66 5.66L4 15.5" /><path d="M4 20.5v-5h5" /></>,
  download: <><path d="M12 4v11M7 10.5l5 5 5-5" /><path d="M5 20h14" /></>,
  share: <><path d="M12 15V3.5M8 7.5l4-4 4 4" /><path d="M7 11H5.5A1.5 1.5 0 0 0 4 12.5v6A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5H17" /></>,
  folderPlus: <><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" /><path d="M12 11.5v5M9.5 14h5" /></>,
  move: <><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" /><path d="M9 14h6M12.5 11.5L15 14l-2.5 2.5" /></>,
  sort: <><path d="M5 19l9.5-9.5M13 5l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM18.5 12.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" /><path d="M14.5 9.5l1 1" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></>,
  edit: <><path d="M3 17h7M3 21h12M14 17h7" /><path d="M14.5 3.5l3 3L10 14H7v-3z" /></>,
  play: <path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  left: <path d="M15 5l-7 7 7 7" />,
  right: <path d="M9 5l7 7-7 7" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="1" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  text: <><path d="M5 6V4h14v2M12 4v16M9 20h6" /></>,
  music: <><path d="M9 18V5l11-2v13" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></>,
  split: <><path d="M12 3v18" /><path d="M4 8h5v8H4zM15 8h5v8h-5z" /></>,
  back: <><path d="M10 6l-6 6 6 6" /><path d="M4 12h16" /></>,
  reset: <><path d="M4 12a8 8 0 1 0 2.34-5.66" /><path d="M4 4v5h5" /></>,
};
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; danger?: boolean };
/** Icon-only button: the label is read by screen readers and shown as a tooltip. */
export function IconButton({ icon, label, danger, className, ...rest }: Props) {
  return (
    <button type="button" className={`icon-btn icon-btn--sm${danger ? " icon-btn--danger" : ""}${className ? ` ${className}` : ""}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

/** Icon-only link (download). */
export function IconLink({ icon, label, href, download }: { icon: IconName; label: string; href: string; download?: boolean }) {
  return (
    <a className="icon-btn icon-btn--sm" href={href} download={download} aria-label={label} title={label}>
      <Icon name={icon} />
    </a>
  );
}
