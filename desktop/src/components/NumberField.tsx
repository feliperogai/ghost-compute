import { useEffect, useState } from 'react';

interface Props {
  value: number;
  min: number;
  max: number;
  onChange(v: number): void;
  'aria-label': string;
  className?: string;
}

/** Lets the user clear and retype freely; commits valid values, normalizes on blur. */
export function NumberField({ value, min, max, onChange, className, ...rest }: Props) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  return (
    <input
      {...rest}
      className={className}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isInteger(n) && n >= min && n <= max) onChange(n);
      }}
      onBlur={() => {
        const n = Number(text);
        const v = text === '' || !Number.isFinite(n) ? value : clamp(Math.round(n));
        setText(String(v));
        if (v !== value) onChange(v);
      }}
    />
  );
}
