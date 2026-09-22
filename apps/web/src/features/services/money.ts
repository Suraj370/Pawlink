// Converts a user-typed major-unit price string (e.g. "799.5") to an
// integer minor-unit amount (79950) without ever multiplying a decimal
// float — the string is split on "." and combined with integer
// arithmetic only, so this can't introduce the rounding bugs float math
// would. Returns null for an empty string, NaN for anything unparsable
// (left for Zod's coercion to reject downstream).
export function priceMajorToMinor(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return NaN;

  const [, major, minorRaw = ""] = match;
  const minor = minorRaw.padEnd(2, "0");
  return Number(major) * 100 + Number(minor);
}

// Integer division/modulo only — exact for integer inputs, no float
// precision concerns.
export function priceMinorToMajor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const majorPart = Math.floor(abs / 100);
  const minorPart = abs % 100;
  return `${sign}${majorPart}.${String(minorPart).padStart(2, "0")}`;
}
