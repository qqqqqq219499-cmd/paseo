import type { AgentMode } from "../../agent-sdk-types.js";
import type { SessionStateResponse } from "../acp-agent.js";

/**
 * Grok CLI permission / session modes for the composer control.
 *
 * Grok ACP `session/new` currently returns `modes: null`, but
 * `session/set_mode` accepts the same ids the CLI documents
 * (`--permission-mode` / Shift+Tab / `/plan` / `/always-approve` / `/auto`).
 * We therefore advertise these as `defaultModes` so Paseo can sync the
 * settable surface the same way Claude does.
 *
 * Ids match Claude-style names where they overlap so existing UI localization
 * (`alwaysAsk`, `autoMode`, `acceptFileEdits`, `planMode`, `bypass`) applies.
 */
export const GROK_MODES: AgentMode[] = [
  {
    id: "default",
    label: "Always Ask",
    description: "Prompt for tool approval when not pre-approved (CLI default)",
  },
  {
    id: "auto",
    label: "Auto mode",
    description: "LLM classifier auto-approves safe tools; risky actions may still prompt",
  },
  {
    id: "acceptEdits",
    label: "Accept File Edits",
    description: "Auto-approve file edits; other tools may still prompt",
  },
  {
    id: "plan",
    label: "Plan Mode",
    description: "Plan first without implementing (CLI /plan)",
  },
  {
    id: "bypassPermissions",
    label: "Bypass",
    description: "Skip permission prompts (CLI /always-approve, --always-approve)",
  },
  {
    id: "dontAsk",
    label: "Don't Ask",
    description: "Deny tools that are not pre-approved without prompting",
  },
];

/** Normalize CLI aliases to the single mode id shown in the UI. */
export function normalizeGrokModeId(modeId: string): string | null {
  const compact = modeId
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (!compact) {
    return null;
  }
  switch (compact) {
    case "default":
    case "normal":
    case "ask":
      return "default";
    case "auto":
      return "auto";
    case "acceptedits":
      return "acceptEdits";
    case "plan":
    case "planmode":
      return "plan";
    case "bypasspermissions":
    case "bypass":
    case "alwaysapprove":
    case "yolo":
      return "bypassPermissions";
    case "dontask":
      return "dontAsk";
    default:
      // Unknown ids pass through so future Grok modes still work.
      return modeId.trim();
  }
}

/**
 * Grok ACP returns `modes: null` but accepts `session/set_mode` for CLI modes.
 * Inject the advertised mode list so catalog + session state expose them.
 */
export function enrichGrokSessionModes(response: SessionStateResponse): SessionStateResponse {
  if (response.modes?.availableModes?.length) {
    return response;
  }

  return {
    ...response,
    modes: {
      availableModes: GROK_MODES.map((mode) => ({
        id: mode.id,
        name: mode.label,
        description: mode.description,
      })),
      currentModeId: response.modes?.currentModeId ?? "default",
    },
  };
}
