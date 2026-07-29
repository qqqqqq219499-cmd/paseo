import "@xyflow/react/dist/style.css";

import React, { useCallback, useMemo, type CSSProperties, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import { StyleSheet } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { useSessionStore } from "@/stores/session-store";
import { baseColors } from "@/styles/theme";
import {
  INLINE_BOARD_MAX_HEIGHT,
  SWARM_STATUS_ORDER,
  swarmBoardStatusChipStyles,
  swarmBoardStatusChipTextStyles,
  useSwarmBoardModel,
  useSwarmRunningNow,
  type SwarmBoardViewProps,
} from "@/subagents/swarm-board-view";
import {
  summarizeSwarmCards,
  type SwarmCardDisplayState,
  type SwarmCardViewModel,
} from "@/subagents/swarm-cards";
import {
  buildSwarmGraph,
  layoutSwarmGraph,
  SWARM_GRAPH_NODE_TYPE,
  type SwarmGraphNodeData,
} from "@/subagents/swarm-graph-model";

// TODO: 后代层级（子的子）
// TODO: 大图退化（只读缩略/虚拟化）

const HANDLE_STYLE: CSSProperties = { background: "var(--colors-border)" };
const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
};
const ICON_WRAP_STYLE: CSSProperties = {
  display: "inline-flex",
  width: 20,
  justifyContent: "center",
};
const TITLE_ROOT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 14,
  fontWeight: 600,
  color: "var(--colors-foreground)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const TITLE_CHILD_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 500,
  color: "var(--colors-foreground)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const META_LINE_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--colors-foregroundMuted)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const DURATION_LINE_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--colors-foregroundMuted)",
};
const ROOT_SHELL_STYLE: CSSProperties = {
  minWidth: 200,
  maxWidth: 260,
  backgroundColor: "var(--colors-surface2)",
  borderWidth: 2,
  borderStyle: "solid",
  borderColor: "var(--colors-accent)",
  borderRadius: 16,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  boxShadow: "0 0 0 1px var(--colors-accent)",
  cursor: "default",
};
const CHILD_SHELL_STYLE: CSSProperties = {
  minWidth: 180,
  maxWidth: 220,
  backgroundColor: "var(--colors-surface1)",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--colors-borderAccent)",
  borderRadius: 16,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  cursor: "pointer",
};
const CANVAS_PANEL_STYLE: CSSProperties = {
  flex: 1,
  height: "100%",
  minHeight: 240,
  width: "100%",
  backgroundColor: "var(--colors-background)",
};
const CANVAS_INLINE_STYLE: CSSProperties = {
  height: INLINE_BOARD_MAX_HEIGHT - 44,
  minHeight: 180,
  width: "100%",
  backgroundColor: "var(--colors-background)",
};
const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true } as const;
const LAYOUT_OPTIONS = { direction: "LR" as const };
const FLOW_BACKGROUND_COLOR = "var(--colors-border)";
const ICON_MUTED_COLOR = "var(--colors-foregroundMuted)";
const DEP_EDGE_STYLE: CSSProperties = {
  stroke: "var(--colors-accent)",
  strokeWidth: 1.5,
  strokeDasharray: "6 3",
};

const BADGE_BASE_STYLE: CSSProperties = {
  borderRadius: 999,
  borderWidth: 1,
  borderStyle: "solid",
  fontSize: 11,
  paddingLeft: 8,
  paddingRight: 8,
  paddingTop: 2,
  paddingBottom: 2,
  flexShrink: 0,
};

const DISPLAY_BADGE_STYLES: Record<SwarmCardDisplayState, CSSProperties> = {
  queued: {
    ...BADGE_BASE_STYLE,
    borderColor: baseColors.amber[500],
    color: baseColors.amber[500],
  },
  working: {
    ...BADGE_BASE_STYLE,
    borderColor: baseColors.blue[500],
    color: baseColors.blue[500],
  },
  waiting: {
    ...BADGE_BASE_STYLE,
    borderColor: baseColors.amber[500],
    color: baseColors.amber[500],
  },
  completed: {
    ...BADGE_BASE_STYLE,
    borderColor: baseColors.green[500],
    color: baseColors.green[500],
  },
  failed: {
    ...BADGE_BASE_STYLE,
    borderColor: baseColors.red[500],
    color: baseColors.red[500],
  },
  canceled: {
    ...BADGE_BASE_STYLE,
    borderColor: "var(--colors-foregroundMuted)",
    color: "var(--colors-foregroundMuted)",
  },
};

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function isIndeterminateDisplayState(displayState: SwarmCardDisplayState): boolean {
  return displayState === "queued" || displayState === "working" || displayState === "waiting";
}

function SwarmGraphSummaryBar({ cards }: { cards: SwarmCardViewModel[] }): ReactElement {
  const { t } = useTranslation();
  const summary = useMemo(() => summarizeSwarmCards(cards), [cards]);
  return (
    <View style={styles.summaryBar} testID="swarm-board-summary">
      <Text style={styles.summaryTotal} testID="swarm-board-summary-total">
        {t("swarmBoard.title")} · {summary.total}
      </Text>
      <View style={styles.summaryChips}>
        {SWARM_STATUS_ORDER.map((status) => (
          <View
            key={status}
            style={[styles.summaryChip, swarmBoardStatusChipStyles[status]]}
            testID={`swarm-board-summary-${status}`}
          >
            <Text style={[styles.summaryChipText, swarmBoardStatusChipTextStyles[status]]}>
              {t(`swarmBoard.status.${status}`)} {summary[status]}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function SwarmGraphNodeBadge({
  displayState,
  label,
}: {
  displayState: SwarmCardDisplayState;
  label: string;
}): ReactElement {
  return <span style={DISPLAY_BADGE_STYLES[displayState]}>{label}</span>;
}

function SwarmGraphNodeHeader({
  isRoot,
  title,
  ProviderIcon,
  displayState,
  displayLabel,
}: {
  isRoot: boolean;
  title: string;
  ProviderIcon: ReturnType<typeof getProviderIcon> | null;
  displayState: SwarmCardDisplayState | null;
  displayLabel: string | null;
}): ReactElement {
  return (
    <div style={HEADER_ROW_STYLE}>
      {ProviderIcon ? (
        <span style={ICON_WRAP_STYLE}>
          <ProviderIcon size={isRoot ? 18 : 16} color={ICON_MUTED_COLOR} />
        </span>
      ) : null}
      <span style={isRoot ? TITLE_ROOT_STYLE : TITLE_CHILD_STYLE}>{title}</span>
      {displayState && displayLabel ? (
        <SwarmGraphNodeBadge displayState={displayState} label={displayLabel} />
      ) : null}
    </div>
  );
}

function SwarmGraphNodeBody({
  data,
  durationLabel,
  displayLabel,
}: {
  data: SwarmGraphNodeData;
  durationLabel: string | null;
  displayLabel: string | null;
}): ReactElement {
  const card = data.card;
  const ProviderIcon = card ? getProviderIcon(card.provider) : null;
  return (
    <>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <SwarmGraphNodeHeader
        isRoot={data.isRoot}
        title={data.title}
        ProviderIcon={ProviderIcon}
        displayState={card?.displayState ?? null}
        displayLabel={displayLabel}
      />
      {data.subtitle ? <div style={META_LINE_STYLE}>{data.subtitle}</div> : null}
      {durationLabel ? <div style={DURATION_LINE_STYLE}>{durationLabel}</div> : null}
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
    </>
  );
}

function SwarmGraphNode({ data }: NodeProps<Node<SwarmGraphNodeData>>): ReactElement {
  const { t } = useTranslation();
  const card = data.card;
  const needsTick = Boolean(
    card && (card.status === "running" || isIndeterminateDisplayState(card.displayState)),
  );
  const now = useSwarmRunningNow(needsTick);

  const durationLabel = useMemo(() => {
    if (!card) return null;
    if (card.status === "running") {
      return formatDurationMs(Math.max(0, now - Date.parse(card.createdAt)));
    }
    return formatDurationMs(card.durationMs);
  }, [card, now]);

  const displayLabel = card ? t(`swarmBoard.displayState.${card.displayState}`) : null;
  const testId = data.isRoot
    ? "swarm-graph-root-node"
    : `swarm-graph-node-${card?.subagentId ?? "unknown"}`;

  return (
    <div style={data.isRoot ? ROOT_SHELL_STYLE : CHILD_SHELL_STYLE} data-testid={testId}>
      <SwarmGraphNodeBody data={data} durationLabel={durationLabel} displayLabel={displayLabel} />
    </div>
  );
}

const nodeTypes = {
  [SWARM_GRAPH_NODE_TYPE]: SwarmGraphNode,
};

export function SwarmGraphView({
  serverId,
  parentAgentId,
  variant = "panel",
  onOpenCard,
}: SwarmBoardViewProps): ReactElement {
  const { t } = useTranslation();
  const isInline = variant === "inline";
  const { cards, supported, serverInfoLoaded, paseoAgentCount } = useSwarmBoardModel(
    serverId,
    parentAgentId,
  );

  const rootTitle = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const parent =
      session?.agents.get(parentAgentId) ?? session?.agentDetails.get(parentAgentId) ?? null;
    const title = parent?.title?.trim();
    return title && title.length > 0 ? title : "Swarm";
  });

  // TODO: 后代层级（子的子） — v1 只渲染直接子级，与现有面板语义一致
  const { nodes, edges } = useMemo(() => {
    const built = buildSwarmGraph({
      cards,
      rootAgentId: parentAgentId,
      rootTitle,
    });
    // TODO: 大图退化（只读缩略/虚拟化）
    const laid = layoutSwarmGraph(built, LAYOUT_OPTIONS);
    const styledEdges = laid.edges.map((edge) => {
      const kind = (edge.data as { kind?: string } | undefined)?.kind;
      if (kind === "dep") {
        return { ...edge, style: DEP_EDGE_STYLE };
      }
      return edge;
    });
    return { nodes: laid.nodes, edges: styledEdges };
  }, [cards, parentAgentId, rootTitle]);

  const handleNodeClick = useCallback<NodeMouseHandler<Node<SwarmGraphNodeData>>>(
    (_event, node) => {
      if (node.data.isRoot || !node.data.card) return;
      onOpenCard(node.data.card);
    },
    [onOpenCard],
  );

  if (serverInfoLoaded && !supported && paseoAgentCount === 0) {
    return (
      <View
        style={isInline ? styles.centerStateInline : styles.centerState}
        testID="swarm-board-unsupported"
      >
        <Text style={styles.centerStateText}>{t("message.actions.forkUnavailable")}</Text>
      </View>
    );
  }

  return (
    <View
      style={isInline ? styles.containerInline : styles.container}
      testID={isInline ? "swarm-graph-inline" : "swarm-graph-panel"}
    >
      <SwarmGraphSummaryBar cards={cards} />
      {cards.length === 0 ? (
        <View
          style={isInline ? styles.centerStateInline : styles.centerState}
          testID="swarm-board-empty"
        >
          <Text style={styles.centerStateText}>{t("swarmBoard.empty")}</Text>
        </View>
      ) : (
        <div
          style={isInline ? CANVAS_INLINE_STYLE : CANVAS_PANEL_STYLE}
          data-testid="swarm-graph-canvas"
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            panOnScroll
            onNodeClick={handleNodeClick}
            proOptions={REACT_FLOW_PRO_OPTIONS}
          >
            <Background gap={16} color={FLOW_BACKGROUND_COLOR} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  containerInline: {
    maxHeight: INLINE_BOARD_MAX_HEIGHT,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  centerStateInline: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[3],
  },
  centerStateText: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    fontSize: theme.fontSize.sm,
  },
  summaryBar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  summaryTotal: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  summaryChips: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  summaryChip: {
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  summaryChipText: {
    fontSize: theme.fontSize.xs,
  },
}));
