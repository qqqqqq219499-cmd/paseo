import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSharedContextStatus } from "./desktop-daemon";

const invokeDesktopCommand = vi.hoisted(() => vi.fn());

vi.mock("@/desktop/electron/invoke", () => ({ invokeDesktopCommand }));

describe("shared context desktop contract", () => {
  beforeEach(() => {
    invokeDesktopCommand.mockReset();
  });

  it("parses generic provider capability status", async () => {
    invokeDesktopCommand.mockResolvedValue({
      state: "ready",
      canonical: { promptExists: true, skillsExist: true },
      mcpProxyReachable: true,
      providers: [
        {
          id: "codex",
          label: "Codex",
          detected: true,
          prompt: "synced",
          skills: "synced",
          mcp: "synced",
        },
        {
          id: "cursor",
          label: "Cursor Agent",
          detected: true,
          prompt: "unsupported",
          skills: "synced",
          mcp: "drift",
        },
      ],
    });

    await expect(getSharedContextStatus()).resolves.toEqual({
      state: "ready",
      canonical: { promptExists: true, skillsExist: true },
      mcpProxyReachable: true,
      providers: [
        {
          id: "codex",
          label: "Codex",
          detected: true,
          prompt: "synced",
          skills: "synced",
          mcp: "synced",
        },
        {
          id: "cursor",
          label: "Cursor Agent",
          detected: true,
          prompt: "unsupported",
          skills: "synced",
          mcp: "drift",
        },
      ],
    });
  });
});
