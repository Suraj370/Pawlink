// Pure wall-clock arithmetic on an ISO-8601 string that already carries an
// explicit UTC offset (e.g. "2026-10-05T09:00:00+05:30", exactly what the
// availability endpoint returns) — the browser's own timezone is never
// consulted. Date.UTC/getUTC* here are used purely as a calendar
// calculator (treating the string's own local components as if they were
// UTC, for correct hour/day rollover math), not as a real timezone
// conversion — the original offset suffix is re-attached unchanged.
const OFFSET_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function addMinutesToOffsetIso(iso: string, minutes: number): string {
  const match = OFFSET_ISO_RE.exec(iso);
  if (!match) return iso;
  const [, y, mo, d, h, mi, s, offset] = match;
  const totalMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi) + minutes, Number(s));
  const result = new Date(totalMs);
  return (
    `${result.getUTCFullYear()}-${pad2(result.getUTCMonth() + 1)}-${pad2(result.getUTCDate())}` +
    `T${pad2(result.getUTCHours())}:${pad2(result.getUTCMinutes())}:${pad2(result.getUTCSeconds())}${offset}`
  );
}

export function offsetIsoTime(iso: string): string {
  return iso.slice(11, 16);
}
