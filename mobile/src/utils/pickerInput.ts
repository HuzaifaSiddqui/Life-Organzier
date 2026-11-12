/** Converts between a Date and an HTML date / time input's value (web / desktop picker), in local time. */

const pad = (n: number) => String(n).padStart(2, "0");

export function toInputValue(d: Date, mode: "date" | "time"): string {
  return mode === "date" ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The picked value applied to `base` (a date keeps base's time; a time keeps base's day). Null when malformed. */
export function fromInputValue(value: string, mode: "date" | "time", base: Date): Date | null {
  const out = new Date(base.getTime());
  if (mode === "date") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return null;
    out.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return out;
  }
  const m = /^(\d{2}):(\d{2})/.exec(value);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  out.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return out;
}
