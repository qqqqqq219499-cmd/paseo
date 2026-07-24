/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmCardViewModel } from "@/subagents/swarm-cards";

const { state, theme } = vi.hoisted(() => {
  const testTheme = {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6, lg: 8, "2xl": 16, full: 9999 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      border: "#444",
      borderAccent: "#555",
      palette: {
        blue: { 500: "#3b82f6" },
        green: { 500: "#22c55e" },
        red: { 500: "#ef4444" },
        amber: { 500: "#f59e0b" },
      },
    },
  };
  return {
    theme: testTheme,
    state: {
      cards: [] as Array<Record<string, unknown>>,
      descriptors: new Map<string, unknown>(),
      timelines: new Map<string, unknown>(),
      supported: true,
      serverInfoLoaded: true,
      openTabCalls: [] as Array<Record<string, unknown>>,
      refreshCalls: [] as Array<unknown[]>,
    },
  };
});

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (Component: React.ComponentType) => Component,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options && typeof options.count === "number" ? `${key}(${options.count})` : key,
  }),
}));

vi.mock("zustand/react/shallow", () => ({
  useShallow: (selector: unknown) => selector,
}));

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: () => () => null,
}));

vi.mock("@/panels/pane-context", () => ({
  usePaneContext: () => ({
    serverId: "server-1",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    target: { kind: "swarm_board", parentAgentId: "parent-1" },
    openTab: (target: Record<string, unknown>) => {
      state.openTabCalls.push(target);
    },
    closeCurrentTab: () => undefined,
    retargetCurrentTab: () => undefined,
    openFileInWorkspace: () => undefined,
    openImportSheet: () => undefined,
  }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (value: unknown) => unknown) =>
    selector({
      sessions: {
        "server-1": {
          client: { listProviderSubagents: async () => ({ subagents: [] }) },
          serverInfo: state.serverInfoLoaded
            ? { features: { providerSubagents: state.supported } }
            : null,
          agents: new Map(),
          agentDetails: new Map(),
        },
      },
    }),
}));

vi.mock("@/subagents/provider-store", () => ({
  useProviderSubagentStore: (selector: (value: unknown) => unknown) =>
    selector({ descriptors: state.descriptors, timelines: state.timelines }),
  refreshProviderSubagents: (...args: unknown[]) => {
    state.refreshCalls.push(args);
    return Promise.resolve();
  },
}));

vi.mock("@/subagents/swarm-cards", () => ({
  buildSwarmCardViewModels: () => state.cards,
  summarizeSwarmCards: (cards: Array<{ status: string }>) => ({
    total: cards.length,
    running: cards.filter((card) => card.status === "running").length,
    completed: cards.filter((card) => card.status === "completed").length,
    failed: cards.filter((card) => card.status === "failed").length,
    canceled: cards.filter((card) => card.status === "canceled").length,
  }),
}));

import { swarmBoardPanelRegistration } from "@/panels/swarm-board-panel";

const SwarmBoardPanel = swarmBoardPanelRegistration.component;

function makeCard(overrides: Partial<SwarmCardViewModel>): Record<string, unknown> {
  return {
    key: "server-1\0parent-1\0sub-1",
    kind: "provider",
    subagentId: "sub-1",
    parentAgentId: "parent-1",
    provider: "claude",
    title: "Research agent",
    description: null,
    status: "completed",
    displayState: "completed",
    toolCallCount: 3,
    lastActivityPreview: "Edited src/app.tsx",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:23.000Z",
    durationMs: 83_000,
    ...overrides,
  };
}

describe("SwarmBoardPanel", () => {
  beforeEach(() => {
    state.cards = [];
    state.supported = true;
    state.serverInfoLoaded = true;
    state.openTabCalls = [];
    state.refreshCalls = [];
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the empty state when there are no subagents", () => {
    render(React.createElement(SwarmBoardPanel));

    expect(screen.getByTestId("swarm-board-empty")).toBeTruthy();
    expect(screen.getByTestId("swarm-board-summary-total").textContent).toContain("0");
    expect(screen.getByText("swarmBoard.empty")).toBeTruthy();
  });

  it("refreshes provider subagents on mount", () => {
    render(React.createElement(SwarmBoardPanel));

    expect(state.refreshCalls).toHaveLength(1);
    expect(state.refreshCalls[0]?.[1]).toBe("server-1");
    expect(state.refreshCalls[0]?.[2]).toBe("parent-1");
  });

  it("renders a card per subagent with status, tool calls, and activity", () => {
    state.cards = [
      makeCard({}),
      makeCard({
        key: "server-1\0parent-1\0sub-2",
        subagentId: "sub-2",
        title: "Runner agent",
        status: "running",
        displayState: "working",
        toolCallCount: 5,
        lastActivityPreview: null,
      }),
    ];

    render(React.createElement(SwarmBoardPanel));

    expect(screen.getByTestId("swarm-board-card-sub-1")).toBeTruthy();
    expect(screen.getByTestId("swarm-board-card-sub-2")).toBeTruthy();
    expect(screen.getByText("Research agent")).toBeTruthy();
    expect(screen.getByText("Runner agent")).toBeTruthy();
    expect(screen.getByText("swarmBoard.displayState.completed")).toBeTruthy();
    expect(screen.getByText("swarmBoard.displayState.working")).toBeTruthy();
    expect(screen.getByText("swarmBoard.toolCalls(3)")).toBeTruthy();
    expect(screen.getByText("swarmBoard.toolCalls(5)")).toBeTruthy();
    expect(screen.getByText("Edited src/app.tsx")).toBeTruthy();
    expect(screen.getByText("swarmBoard.lastActivityNone")).toBeTruthy();
    expect(screen.queryByTestId("swarm-board-empty")).toBeNull();
    // Completed card shows its formatted duration (83s -> 1m 23s).
    expect(screen.getByText("1m 23s")).toBeTruthy();
  });

  it("opens the provider_subagent detail tab when a card is pressed", () => {
    state.cards = [makeCard({})];

    render(React.createElement(SwarmBoardPanel));
    fireEvent.click(screen.getByTestId("swarm-board-card-sub-1"));

    expect(state.openTabCalls).toEqual([
      { kind: "provider_subagent", parentAgentId: "parent-1", subagentId: "sub-1" },
    ]);
  });

  it("opens the agent tab when a paseo card is pressed", () => {
    state.cards = [
      makeCard({
        key: "paseo:paseo-1",
        kind: "paseo",
        subagentId: "paseo-1",
        title: "Paseo child",
      }),
    ];

    render(React.createElement(SwarmBoardPanel));
    fireEvent.click(screen.getByTestId("swarm-board-card-paseo-1"));

    expect(state.openTabCalls).toEqual([{ kind: "agent", agentId: "paseo-1" }]);
  });

  it("shows the unsupported state when the daemon lacks provider subagents", () => {
    state.supported = false;

    render(React.createElement(SwarmBoardPanel));

    expect(screen.getByTestId("swarm-board-unsupported")).toBeTruthy();
    expect(screen.queryByTestId("swarm-board-empty")).toBeNull();
    expect(state.refreshCalls).toHaveLength(0);
  });

  it("renders a progress bar on each card without crashing", () => {
    state.cards = [
      makeCard({ status: "completed", displayState: "completed" }),
      makeCard({
        key: "server-1\0parent-1\0sub-2",
        subagentId: "sub-2",
        status: "running",
        displayState: "working",
        lastActivityPreview: null,
      }),
      makeCard({
        key: "paseo:paseo-1",
        kind: "paseo",
        subagentId: "paseo-1",
        status: "running",
        displayState: "waiting",
      }),
    ];

    render(React.createElement(SwarmBoardPanel));

    const bars = screen.getAllByTestId("swarm-board-progress");
    expect(bars).toHaveLength(3);
    expect(screen.getAllByTestId("swarm-board-progress-fill")).toHaveLength(3);
    expect(screen.getByText("swarmBoard.displayState.waiting")).toBeTruthy();
  });
});
