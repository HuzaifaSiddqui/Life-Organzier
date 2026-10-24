const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Every other day, starting 25 Oct" / "Every 3 days, starting 25 Oct". Display only: which days count is
 * decided on the server (routineMatchesDay), never on the phone.
 */
export function intervalRepeatLabel(intervalDays: number, anchorYmd: string): string {
  const [, m, d] = anchorYmd.split("-").map(Number);
  const start = m && d ? ` starting ${d} ${MONTHS[m - 1]}` : "";
  return `${intervalDays === 2 ? "Every other day" : `Every ${intervalDays} days`},${start}`.replace(/,$/, "");
}

/** Choices offered in the routine form; the server accepts 2..30. */
export const INTERVAL_CHOICES = [2, 3, 4, 5, 6, 7];
