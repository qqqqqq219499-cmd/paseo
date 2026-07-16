import type { ProviderApiFetch } from "../quota-fetcher/provider.js";

// Reads the WEEKLY SuperGrok usage that grok.com's own Usage page shows
// ("每周 SuperGrok 限额 N% 已用" + per-product breakdown + weekly reset), which
// the monthly `/v1/billing` reader (grok-billing.ts) does NOT expose. The data
// lives behind a gRPC-web endpoint on grok.com; it is reachable with the grok
// CLI bearer token (verified 2026-07-11 — no browser cookie needed). See
// .trellis/tasks/07-11-grok-oauth-account-switching/research/weekly-quota-endpoint.md
// for the wire format this decoder is built against.
//
// Endpoint discovered via steipete/CodexBar. Credential types stay server-only.

const WEEKLY_QUOTA_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

// gRPC-web frame carrying an EMPTY protobuf message: 1 flag byte + 4-byte
// big-endian length (0). This is the whole request body.
const EMPTY_GRPC_WEB_FRAME = new Uint8Array([0, 0, 0, 0, 0]);

// Per-product category enum inside the breakdown (field #7). Mapped by matching
// grok.com's own labels against the observed percentages.
const CATEGORY_LABELS: Record<number, GrokWeeklyCategory> = {
  1: "api",
  2: "build",
  4: "chat",
};

export type GrokWeeklyCategory = "build" | "api" | "chat" | "other";

export interface GrokWeeklyBreakdownEntry {
  category: GrokWeeklyCategory;
  percentUsed: number;
}

export interface GrokWeeklyQuota {
  // Whole-account weekly usage, 0-100.
  percentUsed: number;
  // ISO timestamp when the weekly window resets, or null if absent.
  resetsAt: string | null;
  // Per-product split; sums to ~percentUsed.
  breakdown: GrokWeeklyBreakdownEntry[];
}

export class GrokWeeklyQuotaError extends Error {
  constructor(
    readonly kind: "http_error" | "grpc_error" | "decode_error" | "network",
    message: string,
  ) {
    super(message);
    this.name = "GrokWeeklyQuotaError";
  }
}

export async function fetchGrokWeeklyQuota(
  fetchApi: ProviderApiFetch,
  token: string,
): Promise<GrokWeeklyQuota> {
  let res: Awaited<ReturnType<ProviderApiFetch>>;
  try {
    res = await fetchApi(WEEKLY_QUOTA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/grpc-web+proto",
        accept: "application/grpc-web+proto",
        "x-grpc-web": "1",
      },
      body: EMPTY_GRPC_WEB_FRAME,
    });
  } catch (error) {
    throw new GrokWeeklyQuotaError(
      "network",
      error instanceof Error ? error.message : "network error",
    );
  }

  if (!res.ok) {
    throw new GrokWeeklyQuotaError("http_error", `weekly quota HTTP ${res.status}`);
  }
  // A gRPC error can ride an HTTP 200 via the grpc-status header/trailer.
  const grpcStatus = res.headers.get("grpc-status");
  if (grpcStatus !== null && grpcStatus !== "0") {
    throw new GrokWeeklyQuotaError("grpc_error", `weekly quota grpc-status ${grpcStatus}`);
  }

  const raw = new Uint8Array(await res.arrayBuffer());
  const message = firstGrpcWebMessage(raw);
  if (message === null) {
    throw new GrokWeeklyQuotaError("decode_error", "no gRPC-web message frame in response");
  }
  const quota = decodeCreditsConfig(message);
  if (quota === null) {
    throw new GrokWeeklyQuotaError("decode_error", "credits config not found in response");
  }
  return quota;
}

// --- gRPC-web framing --------------------------------------------------------

// Returns the payload of the first data frame (flag bit 0x80 clear); trailer
// frames (flag 0x80, carrying grpc-status text) are skipped.
function firstGrpcWebMessage(buf: Uint8Array): Uint8Array | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  while (i + 5 <= buf.length) {
    const flag = buf[i];
    const len = view.getUint32(i + 1, false);
    const start = i + 5;
    const end = start + len;
    if (end > buf.length) return null;
    if ((flag & 0x80) === 0) {
      return buf.subarray(start, end);
    }
    i = end;
  }
  return null;
}

// --- minimal protobuf reader (only the wire types this message uses) ---------

interface ProtoField {
  field: number;
  wire: number;
  varint?: bigint;
  fixed32?: number; // interpreted as float32
  bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, i: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = i;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, pos];
}

function* readFields(buf: Uint8Array): Generator<ProtoField> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  while (i < buf.length) {
    const [tag, next] = readVarint(buf, i);
    i = next;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const [v, nj] = readVarint(buf, i);
      i = nj;
      yield { field, wire, varint: v };
    } else if (wire === 5) {
      if (i + 4 > buf.length) return;
      yield { field, wire, fixed32: view.getFloat32(i, true) };
      i += 4;
    } else if (wire === 1) {
      i += 8; // fixed64 unused here
    } else if (wire === 2) {
      const [len, nj] = readVarint(buf, i);
      i = nj;
      const n = Number(len);
      if (i + n > buf.length) return;
      yield { field, wire, bytes: buf.subarray(i, i + n) };
      i += n;
    } else {
      return; // unknown wire type: stop defensively
    }
  }
}

// Outer response wraps the config in field #1; decode that inner message.
function decodeCreditsConfig(message: Uint8Array): GrokWeeklyQuota | null {
  let inner: Uint8Array | null = null;
  for (const f of readFields(message)) {
    if (f.field === 1 && f.bytes) {
      inner = f.bytes;
      break;
    }
  }
  const config = inner ?? message; // tolerate an unwrapped shape too
  let percentUsed: number | null = null;
  let resetsAt: string | null = null;
  const breakdown: GrokWeeklyBreakdownEntry[] = [];

  for (const f of readFields(config)) {
    if (f.field === 1 && f.fixed32 !== undefined) {
      percentUsed = f.fixed32;
    } else if (f.field === 5 && f.bytes) {
      resetsAt = decodeTimestamp(f.bytes);
    } else if (f.field === 7 && f.bytes) {
      const entry = decodeBreakdownEntry(f.bytes);
      if (entry) breakdown.push(entry);
    }
  }

  if (percentUsed === null) return null;
  return { percentUsed: roundPercent(percentUsed), resetsAt, breakdown };
}

// A { #1 = unix seconds (varint), #2 = nanos (varint) } timestamp → ISO string.
function decodeTimestamp(bytes: Uint8Array): string | null {
  let seconds: bigint | null = null;
  for (const f of readFields(bytes)) {
    if (f.field === 1 && f.varint !== undefined) seconds = f.varint;
  }
  if (seconds === null) return null;
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

// A { #1 = category enum (varint), #2 = percent (fixed32 float) } entry.
function decodeBreakdownEntry(bytes: Uint8Array): GrokWeeklyBreakdownEntry | null {
  let category: number | null = null;
  let percent: number | null = null;
  for (const f of readFields(bytes)) {
    if (f.field === 1 && f.varint !== undefined) category = Number(f.varint);
    else if (f.field === 2 && f.fixed32 !== undefined) percent = f.fixed32;
  }
  if (percent === null) return null;
  return {
    category: (category !== null && CATEGORY_LABELS[category]) || "other",
    percentUsed: roundPercent(percent),
  };
}

function roundPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}
