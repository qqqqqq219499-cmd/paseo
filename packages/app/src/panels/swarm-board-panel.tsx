import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGrid } from "lucide-react-native";
import invariant from "tiny-invariant";
import { usePaneContext } from "@/panels/pane-context";
import type {
  PanelDescriptor,
  PanelDescriptorContext,
  PanelRegistration,
} from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import { SwarmGraphView } from "@/subagents/swarm-graph-view";
import type { SwarmCardViewModel } from "@/subagents/swarm-cards";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";

function useSwarmBoardDescriptor(
  target: { kind: "swarm_board"; parentAgentId: string },
  context: PanelDescriptorContext,
): PanelDescriptor {
  const { t } = useTranslation();
  const parent = useSessionStore(
    (state) =>
      state.sessions[context.serverId]?.agents.get(target.parentAgentId) ??
      state.sessions[context.serverId]?.agentDetails.get(target.parentAgentId) ??
      null,
  );
  const prefix = `${context.serverId}\0${target.parentAgentId}\0`;
  const hasRunningProvider = useProviderSubagentStore((state) => {
    for (const [key, descriptor] of state.descriptors) {
      if (key.startsWith(prefix) && descriptor.status === "running") {
        return true;
      }
    }
    return false;
  });
  const hasRunningPaseo = useSessionStore((state) => {
    const agents = state.sessions[context.serverId]?.agents;
    if (!agents) return false;
    for (const agent of agents.values()) {
      if (
        !agent.archivedAt &&
        agent.parentAgentId === target.parentAgentId &&
        agent.status === "running"
      ) {
        return true;
      }
    }
    return false;
  });
  const hasRunning = hasRunningProvider || hasRunningPaseo;
  const label = parent?.title?.trim() || t("swarmBoard.title");
  return {
    label,
    subtitle: t("swarmBoard.title"),
    tooltip: label,
    titleState: "ready",
    icon: LayoutGrid,
    statusBucket: hasRunning ? deriveSidebarStateBucket({ status: "running" }) : null,
  };
}

function SwarmBoardPanel() {
  const { serverId, target, openTab } = usePaneContext();
  invariant(target.kind === "swarm_board", "SwarmBoardPanel requires swarm_board target");
  const handleOpenCard = useCallback(
    (card: SwarmCardViewModel) => {
      if (card.kind === "paseo") {
        openTab({ kind: "agent", agentId: card.subagentId });
      } else {
        openTab({
          kind: "provider_subagent",
          parentAgentId: card.parentAgentId,
          subagentId: card.subagentId,
        });
      }
    },
    [openTab],
  );
  return (
    <SwarmGraphView
      serverId={serverId}
      parentAgentId={target.parentAgentId}
      variant="panel"
      onOpenCard={handleOpenCard}
    />
  );
}

export const swarmBoardPanelRegistration: PanelRegistration<"swarm_board"> = {
  kind: "swarm_board",
  component: SwarmBoardPanel,
  useDescriptor: useSwarmBoardDescriptor,
};
