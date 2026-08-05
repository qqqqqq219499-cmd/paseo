import { isClusterModeEnabled } from "@getpaseo/protocol/agent-labels";

/**
 * Whether `create_agent_request` should create the agent idle and hand the
 * initial prompt to the cluster send gate (same hard path as follow-up send).
 *
 * Without this, the first message on a new cluster-mode agent went straight
 * to the single-agent provider and never fanned out.
 */
export function shouldRouteCreateInitialThroughCluster(
  labels: Record<string, string> | undefined,
  initialPrompt: string | undefined | null,
): boolean {
  return isClusterModeEnabled(labels) && Boolean(initialPrompt?.trim());
}
