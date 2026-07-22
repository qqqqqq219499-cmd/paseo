/**
 * Detect whether agent reasoning text should be auto-translated to Chinese
 * for display. Pure helpers — no React.
 */

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
const LATIN_LETTER_RE = /[A-Za-z]/g;
const MIN_LATIN_LETTERS = 24;

export function needsChineseTranslation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_LATIN_LETTERS) return false;
  const latin = trimmed.match(LATIN_LETTER_RE)?.length ?? 0;
  if (latin < MIN_LATIN_LETTERS) return false;
  const cjk = trimmed.match(CJK_RE)?.length ?? 0;
  if (cjk > 0 && cjk * 2 >= latin) return false;
  return true;
}

export function chunkTextForTranslation(text: string, maxChars = 3500): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n\n", maxChars);
    if (cut < maxChars * 0.4) cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.4) cut = remaining.lastIndexOf(" ", maxChars);
    if (cut < maxChars * 0.4) cut = maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function parseGoogleTranslateResponse(payload: unknown): string | null {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return null;
  const parts: string[] = [];
  for (const segment of payload[0]) {
    if (Array.isArray(segment) && typeof segment[0] === "string") {
      parts.push(segment[0]);
    }
  }
  const joined = parts.join("");
  return joined.length > 0 ? joined : null;
}
