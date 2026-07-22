/**
 * Display-only translation of agent reasoning to Simplified Chinese.
 * Uses free public MT endpoints (MyMemory primary, Google gtx fallback).
 * No API key. Failures keep the original text.
 */

import {
  chunkTextForTranslation,
  needsChineseTranslation,
  parseGoogleTranslateResponse,
} from "./reasoning-translate";

export type TranslateFn = (text: string, signal?: AbortSignal) => Promise<string>;
export type TranslateFetch = (input: string, init?: RequestInit) => Promise<Response>;

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

/** MyMemory free tier prefers shorter chunks. */
const CHUNK_MAX = 450;

let injectTranslate: TranslateFn | null = null;

export function setReasoningTranslateImpl(fn: TranslateFn | null): void {
  injectTranslate = fn;
}

async function translateChunkMyMemory(
  chunk: string,
  fetchImpl: TranslateFetch,
  signal?: AbortSignal,
): Promise<string | null> {
  const url =
    "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(chunk) +
    "&langpair=en|zh-CN";
  const response = await fetchImpl(url, { method: "GET", signal });
  if (!response.ok) return null;
  const payload: unknown = await response.json();
  if (
    typeof payload === "object" &&
    payload !== null &&
    "responseData" in payload &&
    typeof (payload as { responseData?: { translatedText?: unknown } }).responseData
      ?.translatedText === "string"
  ) {
    const text = (payload as { responseData: { translatedText: string } }).responseData
      .translatedText;
    if (!text || text === chunk) return null;
    // Reject obvious quota / error echoes
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(text)) return null;
    return text;
  }
  return null;
}

async function translateChunkGoogle(
  chunk: string,
  fetchImpl: TranslateFetch,
  signal?: AbortSignal,
): Promise<string | null> {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=" +
    encodeURIComponent(chunk);
  const response = await fetchImpl(url, { method: "GET", signal });
  if (!response.ok) return null;
  const payload: unknown = await response.json();
  return parseGoogleTranslateResponse(payload);
}

async function translateChunk(
  chunk: string,
  fetchImpl: TranslateFetch,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const primary = await translateChunkMyMemory(chunk, fetchImpl, signal);
    if (primary) return primary;
  } catch {
    // fall through
  }
  try {
    const fallback = await translateChunkGoogle(chunk, fetchImpl, signal);
    if (fallback) return fallback;
  } catch {
    // fall through
  }
  return chunk;
}

export async function translateReasoningToZh(
  text: string,
  options?: { signal?: AbortSignal; translateImpl?: TranslateFn; fetchImpl?: TranslateFetch },
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || !needsChineseTranslation(trimmed)) {
    return text;
  }

  const key = trimmed;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const existing = inflight.get(key);
  if (existing) return existing;

  const impl = options?.translateImpl ?? injectTranslate;
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const promise = (async () => {
    try {
      if (impl) {
        const translated = await impl(trimmed, options?.signal);
        if (!translated || translated === trimmed) return text;
        cache.set(key, translated);
        return translated;
      }
      const parts: string[] = [];
      for (const chunk of chunkTextForTranslation(trimmed, CHUNK_MAX)) {
        parts.push(await translateChunk(chunk, fetchImpl, options?.signal));
      }
      const joined = parts.join("\n\n");
      if (!joined || joined === trimmed) return text;
      cache.set(key, joined);
      return joined;
    } catch {
      return text;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export function clearReasoningTranslateCache(): void {
  cache.clear();
  inflight.clear();
}
