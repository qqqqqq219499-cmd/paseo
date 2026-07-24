import { getPaseoToolLeafName } from "@getpaseo/protocol/tool-name-normalization";
import type { StreamItem } from "@/types/stream";

const CREATE_AGENT_LEAF_NAME = "create_agent";
const DIRECT_PASEO_CREATE_AGENT_NAME = "paseo_create_agent";

export function isCreateAgentToolCallItem(item: StreamItem): boolean {
  if (item.kind !== "tool_call" || item.payload.source !== "agent") {
    return false;
  }
  const name = item.payload.data.name.trim().toLowerCase();
  if (name === CREATE_AGENT_LEAF_NAME || name === DIRECT_PASEO_CREATE_AGENT_NAME) {
    return true;
  }
  return getPaseoToolLeafName(name) === CREATE_AGENT_LEAF_NAME;
}

/**
 * Group consecutive create_agent tool calls (no other stream item in between)
 * and return the id of the last call of each run — the anchor where an inline
 * swarm block is rendered.
 */
export function findInlineSwarmAnchorIds(items: StreamItem[]): Set<string> {
  const anchors = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || !isCreateAgentToolCallItem(item)) {
      continue;
    }
    const next = items[index + 1];
    if (!next || !isCreateAgentToolCallItem(next)) {
      anchors.add(item.id);
    }
  }
  return anchors;
}
