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
      syncCalls: [] as Array<unknown[]>,
      openCalls: [] as Array<SwarmCardViewModel>,
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
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${Object.values(options).join("|")})` : key,
  }),
}));

vi.mock("zustand/react/shallow", () => ({
  useShallow: (selector: unknown) => selector,
}));

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: () => () => null,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (value: unknown) => unknown) =>
    selector({
      sessions: {
        "server-1": {
          client: { listProviderSubagents: async () => ({ subagents: [] }) },
          serverInfo: { features: { providerSubagents: true } },
          agents: new Map(),
          agentStreamTail: new Map(),
        },
      },
    }),
}));

vi.mock("@/subagents/provider-store", () => ({
  useProviderSubagentStore: (selector: (value: unknown) => unknown) =>
    selector({ descriptors: new Map(), timelines: new Map() }),
  refreshProviderSubagents: () => Promise.resolve(),
}));

vi.mock("@/subagents/paseo-history-store", () => ({
  usePaseoSubagentHistoryStore: (selector: (value: unknown) => unknown) =>
    selector({ entries: new Map() }),
  syncPaseoSubagentHistory: (...args: unknown[]) => {
    state.syncCalls.push(args);
    return null;
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

import { InlineSwarmBlock } from "@/subagents/inline-swarm-block";

function makeCard(overrides: Partial<SwarmCardViewModel>): Record<string, unknown> {
  return {
    key: "paseo:sub-1",
    kind: "paseo",
    subagentId: "sub-1",
    parentAgentId: "parent-1",
    provider: "claude",
    title: "First agent",
    description: null,
    status: "completed",
    displayState: "completed",
    toolCallCount: 3,
    lastActivityPreview: "Done",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    durationMs: 60_000,
    ...overrides,
  };
}

function handleOpenCard(card: SwarmCardViewModel) {
  state.openCalls.push(card);
}

describe("InlineSwarmBlock", () => {
  beforeEach(() => {
    state.cards = [];
    state.syncCalls = [];
    state.openCalls = [];
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when the parent has no subagents", () => {
    render(
      React.createElement(InlineSwarmBlock, {
        serverId: "server-1",
        parentAgentId: "parent-1",
        onOpenCard: handleOpenCard,
      }),
    );

    expect(screen.queryByTestId("inline-swarm-block")).toBeNull();
  });

  it("shows a collapsed header with count and the first subagent title", () => {
    state.cards = [
      makeCard({
        key: "paseo:sub-2",
        subagentId: "sub-2",
        title: "Second agent",
        createdAt: "2026-01-01T00:02:00.000Z",
      }),
      makeCard({}),
    ];

    render(
      React.createElement(InlineSwarmBlock, {
        serverId: "server-1",
        parentAgentId: "parent-1",
        onOpenCard: handleOpenCard,
      }),
    );

    const header = screen.getByTestId("inline-swarm-block-header");
    expect(header.textContent).toContain("swarmBoard.inlineHeader(2|First agent)");
    // Collapsed by default: the grid is hidden behind the header toggle.
    expect(screen.queryByTestId("inline-swarm-block-grid")).toBeNull();
  });

  it("expands to numbered cards ordered by createdAt and forwards presses", () => {
    state.cards = [
      makeCard({
        key: "paseo:sub-2",
        subagentId: "sub-2",
        title: "Second agent",
        createdAt: "2026-01-01T00:02:00.000Z",
      }),
      makeCard({}),
    ];

    render(
      React.createElement(InlineSwarmBlock, {
        serverId: "server-1",
        parentAgentId: "parent-1",
        onOpenCard: handleOpenCard,
      }),
    );
    fireEvent.click(screen.getByTestId("inline-swarm-block-header"));

    expect(screen.getByTestId("inline-swarm-block-grid")).toBeTruthy();
    expect(screen.getByTestId("swarm-board-card-index-sub-1").textContent).toBe("01");
    expect(screen.getByTestId("swarm-board-card-index-sub-2").textContent).toBe("02");

    fireEvent.click(screen.getByTestId("swarm-board-card-sub-2"));
    expect(state.openCalls).toEqual([state.cards[0]]);
  });

  it("syncs persisted history for paseo cards with their running flag", () => {
    state.cards = [
      makeCard({}),
      makeCard({
        key: "paseo:sub-2",
        subagentId: "sub-2",
        status: "running",
        displayState: "working",
        createdAt: "2026-01-01T00:02:00.000Z",
      }),
      makeCard({
        key: "server-1\0parent-1\0sub-3",
        kind: "provider",
        subagentId: "sub-3",
        createdAt: "2026-01-01T00:03:00.000Z",
      }),
    ];

    render(
      React.createElement(InlineSwarmBlock, {
        serverId: "server-1",
        parentAgentId: "parent-1",
        onOpenCard: handleOpenCard,
      }),
    );

    expect(state.syncCalls).toEqual([
      [expect.anything(), "server-1", "sub-1", false],
      [expect.anything(), "server-1", "sub-2", true],
    ]);
  });
});
