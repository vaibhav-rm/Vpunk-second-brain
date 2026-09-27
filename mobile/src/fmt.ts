// Tiny formatting helpers. Manual (no Intl): Hermes on Android does not
// reliably support toLocaleTimeString options, so we format by hand.

export function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** "HH:MM" 24h wall-clock for the OLED CLOCK page (device has no RTC). */
export function fmtTime(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** e.g. "Sun 28 Sep" — matches the website's short date style. */
export function fmtDate(d: Date = new Date()): string {
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Word-boundary clip with ellipsis (server-side OLED budget). */
export function clip(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
