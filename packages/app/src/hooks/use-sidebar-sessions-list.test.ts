import { describe, expect, it } from "vitest";
import {
  buildSidebarSessionsList,
  isSidebarTopLevelSessionAgent,
  type SidebarSessionEntry,
} from "./use-sidebar-sessions-list";
import type { AgentDirectoryEntry } from "@/types/agent-directory";

const BASE_TIME = new Date("2026-07-20T12:00:00.000Z");

function historyAgent(
  input: Partial<AgentDirectoryEntry> & Pick<AgentDirectoryEntry, "id">,
): AgentDirectoryEntry {
  return {
    id: input.id,
    serverId: input.serverId ?? "server-1",
    title: input.title ?? input.id,
    status: input.status ?? "idle",
    lastActivityAt: input.lastActivityAt ?? BASE_TIME,
    cwd: input.cwd ?? "/repo",
    workspaceId: input.workspaceId ?? "ws-1",
    provider: input.provider ?? "codex",
    pendingPermissionCount: input.pendingPermissionCount ?? 0,
    requiresAttention: input.requiresAttention ?? false,
    attentionReason: input.attentionReason ?? null,
    attentionTimestamp: input.attentionTimestamp ?? null,
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt ?? BASE_TIME,
    labels: input.labels ?? {},
    projectPlacement: input.projectPlacement ?? null,
    parentAgentId: input.parentAgentId ?? null,
  };
}

function liveAgent(
  input: Partial<{
    id: string;
    parentAgentId: string | null;
    archivedAt: Date | null;
    lastUserMessageAt: Date | null;
    title: string | null;
  }> & { id: string },
) {
  return {
    id: input.id,
    serverId: "server-1",
    title: input.title ?? input.id,
    status: "idle" as const,
    lastActivityAt: BASE_TIME,
    lastUserMessageAt: input.lastUserMessageAt ?? null,
    cwd: "/repo",
    workspaceId: "ws-1",
    provider: "codex" as const,
    pendingPermissions: [] as const,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ?? null,
    createdAt: BASE_TIME,
    labels: {},
    projectPlacement: null,
    parentAgentId: input.parentAgentId ?? null,
  };
}

function ids(sessions: SidebarSessionEntry[]): string[] {
  return sessions.map((session) => session.id);
}

describe("isSidebarTopLevelSessionAgent", () => {
  it("treats null parent as top-level", () => {
    expect(isSidebarTopLevelSessionAgent({ parentAgentId: null })).toBe(true);
  });

  it("hides child agents with a parentAgentId", () => {
    expect(isSidebarTopLevelSessionAgent({ parentAgentId: "parent-1" })).toBe(false);
  });
});

describe("buildSidebarSessionsList", () => {
  it("keeps top-level agents and drops subagents from history", () => {
    const sessions = buildSidebarSessionsList({
      historyAgents: [
        historyAgent({ id: "parent", parentAgentId: null }),
        historyAgent({ id: "child", parentAgentId: "parent" }),
      ],
    });
    expect(ids(sessions)).toEqual(["parent"]);
  });

  it("drops live subagents and removes a history row once live marks it a child", () => {
    const sessions = buildSidebarSessionsList({
      historyAgents: [
        historyAgent({ id: "parent", parentAgentId: null }),
        // Stale history row before labels/parent hydrated
        historyAgent({ id: "child", parentAgentId: null }),
      ],
      liveAgents: [
        liveAgent({ id: "parent", parentAgentId: null }),
        liveAgent({ id: "child", parentAgentId: "parent" }),
      ],
    });
    expect(ids(sessions)).toEqual(["parent"]);
  });

  it("keeps archived agents out of the list", () => {
    const sessions = buildSidebarSessionsList({
      historyAgents: [
        historyAgent({ id: "alive", parentAgentId: null }),
        historyAgent({
          id: "archived",
          parentAgentId: null,
          archivedAt: new Date("2026-07-21T00:00:00.000Z"),
        }),
      ],
      liveAgents: [
        liveAgent({ id: "alive", parentAgentId: null }),
        liveAgent({
          id: "archived",
          parentAgentId: null,
          archivedAt: new Date("2026-07-21T00:00:00.000Z"),
        }),
      ],
    });
    expect(ids(sessions)).toEqual(["alive"]);
  });

  it("count-style length matches only top-level non-archived agents", () => {
    const sessions = buildSidebarSessionsList({
      historyAgents: [
        historyAgent({ id: "a", parentAgentId: null }),
        historyAgent({ id: "b", parentAgentId: null }),
        historyAgent({ id: "c-child", parentAgentId: "a" }),
      ],
      liveAgents: [
        liveAgent({ id: "a", parentAgentId: null }),
        liveAgent({ id: "b", parentAgentId: null }),
        liveAgent({ id: "c-child", parentAgentId: "a" }),
        liveAgent({ id: "d-child", parentAgentId: "b" }),
      ],
    });
    // Host/project badge uses sessions.length — must exclude both children.
    expect(sessions).toHaveLength(2);
    expect(ids(sessions).sort()).toEqual(["a", "b"]);
  });

  it("promotes a detached former child back into the list", () => {
    const sessions = buildSidebarSessionsList({
      historyAgents: [historyAgent({ id: "former-child", parentAgentId: "parent" })],
      liveAgents: [liveAgent({ id: "former-child", parentAgentId: null })],
    });
    expect(ids(sessions)).toEqual(["former-child"]);
  });
});
