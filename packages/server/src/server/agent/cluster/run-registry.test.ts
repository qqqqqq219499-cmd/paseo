import { expect, test } from "vitest";

import { tryAcquireClusterRun } from "./run-registry.js";

test("first acquire returns a release function", () => {
  const owner = {};
  const release = tryAcquireClusterRun(owner, "agent-1");
  expect(release).toBeTypeOf("function");
});

test("same owner + same agent acquires only once", () => {
  const owner = {};
  expect(tryAcquireClusterRun(owner, "agent-1")).not.toBeNull();
  expect(tryAcquireClusterRun(owner, "agent-1")).toBeNull();
});

test("release allows re-acquire", () => {
  const owner = {};
  const release = tryAcquireClusterRun(owner, "agent-1");
  expect(release).not.toBeNull();
  release?.();
  expect(tryAcquireClusterRun(owner, "agent-1")).not.toBeNull();
});

test("different owners or different agents do not block each other", () => {
  const ownerA = {};
  const ownerB = {};
  expect(tryAcquireClusterRun(ownerA, "agent-1")).not.toBeNull();
  expect(tryAcquireClusterRun(ownerB, "agent-1")).not.toBeNull();
  expect(tryAcquireClusterRun(ownerA, "agent-2")).not.toBeNull();
});

test("release is idempotent", () => {
  const owner = {};
  const release = tryAcquireClusterRun(owner, "agent-1");
  expect(release).not.toBeNull();
  release?.();
  release?.();
  expect(tryAcquireClusterRun(owner, "agent-1")).not.toBeNull();
});

test("lock held through review rejects a second run; release re-enables acquire", () => {
  const owner = {};
  // The lock spans planning → spawn → fan-in → main review; while it is held
  // a second run for the same agent must be rejected.
  const release = tryAcquireClusterRun(owner, "agent-1");
  expect(release).not.toBeNull();
  expect(tryAcquireClusterRun(owner, "agent-1")).toBeNull();
  // After the review finishes (release), a new run may start.
  release?.();
  expect(tryAcquireClusterRun(owner, "agent-1")).not.toBeNull();
});
