import { expect, test, vi } from "vitest";

import type { ClusterRole } from "./types.js";
import type { GateWorkerMeta, ReviewPacketWorker } from "./review.js";
import {
  assembleReviewPacket,
  buildEvidenceBouncePrompt,
  buildMainReviewPrompt,
  evaluateWorkerEvidence,
  evidenceBandForRole,
  gateOneWorker,
} from "./review.js";

function makeWorker(overrides: Partial<GateWorkerMeta> = {}): GateWorkerMeta {
  return {
    nodeId: "w-1",
    agentId: "uuid-1111-2222-3333",
    title: "Impl Worker",
    role: "impl",
    ...overrides,
  };
}

function makePacketWorker(overrides: Partial<ReviewPacketWorker> = {}): ReviewPacketWorker {
  return {
    nodeId: "w-1",
    agentId: "uuid-1111-2222-3333",
    title: "Impl Worker",
    role: "impl",
    terminalStatus: "done",
    scopeAllow: ["packages/server/src/server/agent/cluster"],
    scopeDeny: [],
    successCriteria: ["Tests pass"],
    finalText: "Changed review.ts and ran vitest — passed.",
    verdict: { ok: true, band: "write", bounceOnce: false },
    bounced: false,
    ...overrides,
  };
}

test("evidenceBandForRole maps roles to bands", () => {
  expect(evidenceBandForRole("impl")).toBe("write");
  expect(evidenceBandForRole("ui")).toBe("write");
  expect(evidenceBandForRole("research")).toBe("research");
  expect(evidenceBandForRole("planning")).toBe("research");
  expect(evidenceBandForRole("audit")).toBe("research");
});

test("null/empty messages fail as empty", () => {
  const verdict = evaluateWorkerEvidence("impl", null, 0);
  expect(verdict.ok).toBe(false);
  expect(verdict.band).toBe("write");
  expect(verdict.reason).toBe("empty");
  expect(verdict.bounceOnce).toBe(true);
  expect(evaluateWorkerEvidence("impl", "   ", 0).reason).toBe("empty");
});

test("bare done phrases fail as bare_done in Chinese and English", () => {
  for (const message of [
    "Done",
    "done!",
    "Completed.",
    "Finished",
    "OK",
    "完成",
    "已完成",
    "搞定！",
    "好了",
  ]) {
    const verdict = evaluateWorkerEvidence("impl", message, 0);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("bare_done");
    expect(verdict.bounceOnce).toBe(true);
  }
});

test("attempt=1 never allows bounce across every failure mode", () => {
  const cases: Array<[ClusterRole, string | null]> = [
    ["impl", null],
    ["impl", "Done"],
    ["impl", "too short"],
    [
      "impl",
      "Everything is implemented and working now. All the requested changes have been made and confirmed working.",
    ],
    [
      "research",
      "I looked into the question thoroughly and everything checks out. Nothing to worry about, it all makes sense now.",
    ],
  ];
  for (const [role, message] of cases) {
    const verdict = evaluateWorkerEvidence(role, message, 1);
    expect(verdict.ok).toBe(false);
    expect(verdict.bounceOnce).toBe(false);
  }
});

test("messages under 40 chars are too_short", () => {
  const message = "I changed the file and ran tests.";
  expect(message).toHaveLength(33);
  const verdict = evaluateWorkerEvidence("impl", message, 0);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("too_short");
  expect(verdict.bounceOnce).toBe(true);
});

test("impl without any evidence fails", () => {
  const message =
    "Everything is implemented and working now. All the requested changes have been made and confirmed working.";
  const verdict = evaluateWorkerEvidence("impl", message, 0);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("no_evidence");
  expect(verdict.bounceOnce).toBe(true);
});

test("impl with file paths but no verification fails", () => {
  const message =
    "Changed src/feature/impl.ts and also updated packages/server/src/server/agent/cluster/review.ts.";
  const verdict = evaluateWorkerEvidence("impl", message, 0);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("missing_verification_evidence");
  expect(verdict.bounceOnce).toBe(true);
});

test("impl with verification but no file paths fails", () => {
  const message =
    "I ran npm test and everything passed. All checks are green now and the build works fine.";
  const verdict = evaluateWorkerEvidence("impl", message, 0);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("missing_file_evidence");
  expect(verdict.bounceOnce).toBe(true);
});

test("impl with file paths and test results passes", () => {
  const message = [
    "Changed src/feature/impl.ts and ran npm test — all 12 tests passed.",
    "Files: packages/server/src/server/agent/cluster/review.ts, review.test.ts",
    "Verification: vitest run passed, typecheck exit 0.",
  ].join("\n");
  const verdict = evaluateWorkerEvidence("impl", message, 0);
  expect(verdict.ok).toBe(true);
  expect(verdict.band).toBe("write");
  expect(verdict.bounceOnce).toBe(false);
});

test("research with paths/conclusions passes without requiring a diff", () => {
  const message = [
    "Conclusion: the session hook lives at packages/server/src/server/session.ts,",
    "handleSendAgentMessageRequest (line 214).",
    "Evidence: the label constant is defined in packages/protocol/src/agent-labels.ts.",
  ].join("\n");
  const verdict = evaluateWorkerEvidence("research", message, 0);
  expect(verdict.ok).toBe(true);
  expect(verdict.band).toBe("research");
  expect(verdict.bounceOnce).toBe(false);
});

test("research without verifiable signals fails", () => {
  const message =
    "I looked into the question thoroughly and everything checks out. Nothing to worry about, it all makes sense now.";
  const verdict = evaluateWorkerEvidence("research", message, 0);
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe("no_verifiable_findings");
  expect(verdict.bounceOnce).toBe(true);
});

test("gateOneWorker passes without bounce when evidence is good", async () => {
  const message = "Changed src/impl.ts and ran vitest — passed.\nVerification: npm test green.";
  const bounce = vi.fn(async () => "should not be called");
  const result = await gateOneWorker({ worker: makeWorker(), initialMessage: message, bounce });
  expect(result.verdict.ok).toBe(true);
  expect(result.bounced).toBe(false);
  expect(result.finalText).toBe(message);
  expect(bounce).not.toHaveBeenCalled();
});

test("gateOneWorker bounces once and accepts the second attempt", async () => {
  const second = "Changed src/impl.ts and ran npm test — all green.\nVerification: vitest passed.";
  const bounce = vi.fn(async (prompt: string) => {
    expect(prompt).toContain("w-1");
    expect(prompt).toContain("uuid-1111-2222-3333");
    expect(prompt).toContain("Impl Worker");
    expect(prompt).toContain("impl");
    expect(prompt).toContain("bare_done");
    expect(prompt).toContain("2/2");
    return second;
  });
  const result = await gateOneWorker({
    worker: makeWorker(),
    initialMessage: "Done",
    bounce,
  });
  expect(bounce).toHaveBeenCalledTimes(1);
  expect(result.bounced).toBe(true);
  expect(result.verdict.ok).toBe(true);
  expect(result.finalText).toBe(second);
  expect(result.bouncePrompt).toContain("uuid-1111-2222-3333");
});

test("gateOneWorker terminates after one bounce when the second attempt still fails", async () => {
  const bounce = vi.fn(async () => "Still done, nothing to add.");
  const result = await gateOneWorker({ worker: makeWorker(), initialMessage: "OK", bounce });
  expect(bounce).toHaveBeenCalledTimes(1);
  expect(result.bounced).toBe(true);
  expect(result.verdict.ok).toBe(false);
  expect(result.verdict.bounceOnce).toBe(false);
});

test("gateOneWorker without a bounce inject never bounces", async () => {
  const result = await gateOneWorker({ worker: makeWorker(), initialMessage: "Done" });
  expect(result.bounced).toBe(false);
  expect(result.verdict.ok).toBe(false);
  expect(result.verdict.bounceOnce).toBe(true);
});

test("buildEvidenceBouncePrompt carries nodeId, agentId, title, role, reason, 2/2", () => {
  const prompt = buildEvidenceBouncePrompt({
    nodeId: "w-1",
    agentId: "uuid-abc-123",
    title: "Impl A",
    role: "impl",
    reason: "bare_done",
    attempt: 2,
  });
  expect(prompt).toContain("w-1");
  expect(prompt).toContain("uuid-abc-123");
  expect(prompt).toContain("Impl A");
  expect(prompt).toContain("impl");
  expect(prompt).toContain("bare_done");
  expect(prompt).toContain("2/2");
});

test("assembleReviewPacket reports allOk=false and failedAgentIds on one pass one fail", () => {
  const packet = assembleReviewPacket([
    makePacketWorker(),
    makePacketWorker({
      nodeId: "w-2",
      agentId: "uuid-fail-9999",
      title: "Research B",
      role: "research",
      finalText: "Done",
      verdict: { ok: false, band: "research", reason: "bare_done", bounceOnce: false },
    }),
  ]);
  expect(packet.allOk).toBe(false);
  expect(packet.failedAgentIds).toEqual(["uuid-fail-9999"]);
  expect(packet.workers).toHaveLength(2);
});

test("assembleReviewPacket is allOk when every worker passes", () => {
  const packet = assembleReviewPacket([
    makePacketWorker(),
    makePacketWorker({ nodeId: "w-2", agentId: "uuid-ok-2222" }),
  ]);
  expect(packet.allOk).toBe(true);
  expect(packet.failedAgentIds).toEqual([]);
});

test("buildMainReviewPrompt includes request, goal, UUIDs, scope, criteria, failedAgentIds, hard rules", () => {
  const packet = assembleReviewPacket([
    makePacketWorker(),
    makePacketWorker({
      nodeId: "w-2",
      agentId: "uuid-fail-9999",
      title: "Research B",
      role: "research",
      finalText: "Conclusion: hook at packages/server/src/server/session.ts (line 214).",
      verdict: {
        ok: false,
        band: "research",
        reason: "no_verifiable_findings",
        bounceOnce: false,
      },
    }),
  ]);
  const prompt = buildMainReviewPrompt({
    originalUserRequest: "Implement the review gate",
    planGoal: "Ship evidence-based review",
    packet,
  });

  expect(prompt).toContain("Implement the review gate");
  expect(prompt).toContain("Ship evidence-based review");
  expect(prompt).toContain("uuid-1111-2222-3333");
  expect(prompt).toContain("uuid-fail-9999");
  expect(prompt).toContain("packages/server/src/server/agent/cluster");
  expect(prompt).toContain("Tests pass");
  expect(prompt).toContain("allOk: false");
  expect(prompt).toContain("failedAgentIds: uuid-fail-9999");
  expect(prompt).toContain("single outward voice");
  expect(prompt).toContain("Do NOT create, spawn");
  expect(prompt).toContain("Never invent");
});

test("buildMainReviewPrompt truncates worker final text to maxWorkerChars", () => {
  const long = "x".repeat(5000);
  const packet = assembleReviewPacket([makePacketWorker({ finalText: long })]);
  const prompt = buildMainReviewPrompt({
    originalUserRequest: "r",
    planGoal: "g",
    packet,
    maxWorkerChars: 100,
  });
  expect(prompt).not.toContain(long);
  expect(prompt).toContain("truncated");
});

test("buildMainReviewPrompt default cap is 4000 chars", () => {
  const long = "y".repeat(5000);
  const packet = assembleReviewPacket([makePacketWorker({ finalText: long })]);
  const prompt = buildMainReviewPrompt({ originalUserRequest: "r", planGoal: "g", packet });
  expect(prompt).toContain("truncated from 5000 chars");
  expect(prompt.indexOf("truncated from 5000 chars")).toBeGreaterThan(4000);
  expect(prompt).not.toContain(long);
});
