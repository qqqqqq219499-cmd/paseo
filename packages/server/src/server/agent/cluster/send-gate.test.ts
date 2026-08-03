import { expect, test, vi } from "vitest";

import {
  CLUSTER_RUNTIME_NOT_CONFIGURED_ERROR,
  CLUSTER_TOOLS_DISABLED_ERROR,
  startClusterRun,
} from "./orchestrator.js";
import {
  ClusterSendGateError,
  buildClusterSkipNotice,
  resolveClusterSendGate,
} from "./send-gate.js";
import type { ClusterRunState } from "./types.js";

test("send gate OFF → continue single without calling orchestrator", async () => {
  const runCluster = vi.fn(async () => {
    throw new Error("orchestrator should not be called when cluster mode is off");
  });

  const decision = await resolveClusterSendGate({
    clusterModeEnabled: false,
    prompt: "帮我排查登录接口 500 报错的原因",
    paseoToolsEnabled: true,
    runCluster,
  });

  expect(decision).toEqual({ action: "continue_single" });
  expect(runCluster).not.toHaveBeenCalled();
});

test("send gate ON skip → write notice + continue single", async () => {
  const decision = await resolveClusterSendGate({
    clusterModeEnabled: true,
    prompt: "hello!!!!",
    paseoToolsEnabled: true,
    runCluster: startClusterRun,
  });

  expect(decision.action).toBe("continue_single_with_notice");
  if (decision.action === "continue_single_with_notice") {
    expect(decision.reason).toBe("greeting only");
    expect(decision.notice).toBe(buildClusterSkipNotice("greeting only"));
    expect(decision.notice).toMatch(/single agent/i);
  }
});

test("send gate ON failed → throw, do not continue", async () => {
  await expect(
    resolveClusterSendGate({
      clusterModeEnabled: true,
      prompt: "帮我排查登录接口 500 报错的原因",
      paseoToolsEnabled: true,
      runCluster: startClusterRun,
    }),
  ).rejects.toBeInstanceOf(ClusterSendGateError);

  await expect(
    resolveClusterSendGate({
      clusterModeEnabled: true,
      prompt: "帮我排查登录接口 500 报错的原因",
      paseoToolsEnabled: true,
      runCluster: startClusterRun,
    }),
  ).rejects.toThrow(CLUSTER_RUNTIME_NOT_CONFIGURED_ERROR);
});

test("send gate ON tools off → throw tools error", async () => {
  await expect(
    resolveClusterSendGate({
      clusterModeEnabled: true,
      prompt: "帮我排查登录接口 500 报错的原因",
      paseoToolsEnabled: false,
      runCluster: startClusterRun,
    }),
  ).rejects.toThrow(CLUSTER_TOOLS_DISABLED_ERROR);
});

test("send gate ON done → handled without continue_single", async () => {
  const done: ClusterRunState = { phase: "done", workerIds: ["w1"] };
  const decision = await resolveClusterSendGate({
    clusterModeEnabled: true,
    prompt: "anything long enough",
    paseoToolsEnabled: true,
    runCluster: async () => done,
  });

  expect(decision).toEqual({ action: "handled", state: done });
});

test("send gate ON running → handled with real worker ids", async () => {
  const running: ClusterRunState = {
    phase: "running",
    workerIds: ["agent-real-1", "agent-real-2"],
  };
  const decision = await resolveClusterSendGate({
    clusterModeEnabled: true,
    prompt: "anything long enough",
    paseoToolsEnabled: true,
    runCluster: async () => running,
  });

  expect(decision).toEqual({ action: "handled", state: running });
});
