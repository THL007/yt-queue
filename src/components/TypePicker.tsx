import { useRef } from "react";
import { BLANK_TYPE, CUSTOM_TYPE, MORE_TYPES, typeLabel, TYPES } from "../lib/api";

type Props = {
  value: string; // "" = YT Boy picks
  custom: string;
  onChange: (value: string) => void;
  onCustom: (text: string) => void;
};

/** Video type: the common ones shown, the rest behind "More types", plus Blank and Custom. */
export function TypePicker({ value, custom, onChange, onCustom }: Props) {
  const customRef = useRef<HTMLInputElement>(null);
  const inMore = MORE_TYPES.some((t) => t.id === value);

  const pick = (id: string) => {
    onChange(id);
    if (id === CUSTOM_TYPE) setTimeout(() => customRef.current?.focus(), 0);
  };
  const opt = (t: { id: string; label: string; hint: string }) => <Option key={t.id || "auto"} {...t} on={value === t.id} onPick={pick} />;

  return (
    <fieldset className="typepick" aria-labelledby="type-h">
      <div className="types">
        {opt({ id: "", label: "YT Boy picks", hint: "From the clips and your notes" })}
        {opt({ id: BLANK_TYPE, label: "Blank", hint: "A plain cut: clips in order, no styling" })}
        {TYPES.map(opt)}
      </div>

      <details className="more" open={inMore || undefined}>
        <summary className="more__head">
          <svg className="folder__chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
          <span>More types</span>
          <span className="count num">{inMore ? typeLabel(value) : MORE_TYPES.length}</span>
        </summary>
        <div className="types more__body">
          {MORE_TYPES.map(opt)}
        </div>
      </details>

      <div className={`custom${value === CUSTOM_TYPE ? " custom--on" : ""}`}>
        {opt({ id: CUSTOM_TYPE, label: "Custom", hint: "Describe your own kind of video" })}
        {value === CUSTOM_TYPE && (
          <div className="field field--tight">
            <label htmlFor="custom-type">Your type, in a few words</label>
            <input
              ref={customRef}
              id="custom-type"
              name="custom-type"
              type="text"
              autoComplete="off"
              maxLength={200}
              value={custom}
              onChange={(e) => onCustom(e.target.value)}
              placeholder="Slow desk-setup ASMR, no music"
            />
          </div>
        )}
      </div>
    </fieldset>
  );
}

function Option({ id, label, hint, on, onPick }: { id: string; label: string; hint: string; on: boolean; onPick: (id: string) => void }) {
  return (
    <label className={`type${on ? " type--on" : ""}`}>
      <input type="radio" name="type" value={id} checked={on} onChange={() => onPick(id)} />
      <span className="type__label">{label}</span>
      <span className="type__hint">{hint}</span>
    </label>
  );
}
