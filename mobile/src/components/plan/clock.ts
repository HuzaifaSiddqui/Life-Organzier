/** "9:30 AM" (or the phone's 24-hour style) for minutes from midnight; used on the Plan timeline. */
export function clockLabel(minutes: number): string {
  const d = new Date(2000, 0, 1, 0, Math.round(minutes));
  try {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    const h = d.getHours();
    return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
}

/** "9 AM" for an hour row label. */
export function hourLabel(hour: number): string {
  const d = new Date(2000, 0, 1, hour, 0);
  try {
    return d.toLocaleTimeString([], { hour: "numeric" });
  } catch {
    return `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
  }
}
