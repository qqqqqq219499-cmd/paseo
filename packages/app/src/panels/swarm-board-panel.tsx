import React, { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { useTranslation } from "react-i18next";
import { LayoutGrid } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useShallow } from "zustand/react/shallow";
import { getProviderIcon } from "@/components/provider-icons";
import { usePaneContext } from "@/panels/pane-context";
import type {
  PanelDescriptor,
  PanelDescriptorContext,
  PanelRegistration,
} from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import { refreshProviderSubagents, useProviderSubagentStore } from "@/subagents/provider-store";
import {
  buildSwarmCardViewModels,
  summarizeSwarmCards,
  type SwarmCardStatus,
  type SwarmCardViewModel,
} from "@/subagents/swarm-cards";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";

const WIDE_GRID_MIN_WIDTH = 900;
const MEDIUM_GRID_MIN_WIDTH = 560;
const RUNNING_TICK_INTERVAL_MS = 1000;

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

function gridColumnCount(width: number): number {
  if (width >= WIDE_GRID_MIN_WIDTH) return 3;
  if (width >= MEDIUM_GRID_MIN_WIDTH) return 2;
  return 1;
}

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
  const hasRunning = useProviderSubagentStore((state) => {
    for (const [key, descriptor] of state.descriptors) {
      if (key.startsWith(prefix) && descriptor.status === "running") {
        return true;
      }
    }
    return false;
  });
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

const STATUS_ORDER: SwarmCardStatus[] = ["running", "completed", "failed", "canceled"];

function SwarmBoardSummaryBar({ cards }: { cards: SwarmCardViewModel[] }): ReactElement {
  const { t } = useTranslation();
  const summary = useMemo(() => summarizeSwarmCards(cards), [cards]);
  return (
    <View style={styles.summaryBar} testID="swarm-board-summary">
      <Text style={styles.summaryTotal} testID="swarm-board-summary-total">
        {t("swarmBoard.title")} · {summary.total}
      </Text>
      <View style={styles.summaryChips}>
        {STATUS_ORDER.map((status) => (
          <View
            key={status}
            style={[styles.summaryChip, statusChipStyles[status]]}
            testID={`swarm-board-summary-${status}`}
          >
            <Text style={[styles.summaryChipText, statusChipTextStyles[status]]}>
              {t(`swarmBoard.status.${status}`)} {summary[status]}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function SwarmBoardCard({
  card,
  now,
  onOpen,
}: {
  card: SwarmCardViewModel;
  now: number;
  onOpen: (card: SwarmCardViewModel) => void;
}): ReactElement {
  const { t } = useTranslation();
  const ProviderIcon = useMemo(() => getProviderIcon(card.provider), [card.provider]);
  const handlePress = useCallback(() => onOpen(card), [card, onOpen]);
  const cardStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.card,
      (hovered || pressed) && styles.cardActive,
    ],
    [],
  );
  const durationMs =
    card.status === "running" ? Math.max(0, now - Date.parse(card.createdAt)) : card.durationMs;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.title}
      testID={`swarm-board-card-${card.subagentId}`}
      onPress={handlePress}
      style={cardStyle}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardIcon}>
          <ProviderIcon size={16} color={styles.cardIconColor.color} />
        </View>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {card.title}
        </Text>
        <View style={[styles.statusBadge, statusChipStyles[card.status]]}>
          <Text style={[styles.statusBadgeText, statusChipTextStyles[card.status]]}>
            {t(`swarmBoard.status.${card.status}`)}
          </Text>
        </View>
      </View>
      <Text style={styles.cardActivity} numberOfLines={2}>
        {card.lastActivityPreview ?? t("swarmBoard.lastActivityNone")}
      </Text>
      <View style={styles.cardFooter}>
        <Text style={styles.cardMeta}>
          {t("swarmBoard.toolCalls", { count: card.toolCallCount })}
        </Text>
        <Text style={styles.cardMeta}>{formatDurationMs(durationMs)}</Text>
      </View>
    </Pressable>
  );
}

function SwarmBoardPanel() {
  const { t } = useTranslation();
  const { serverId, target, openTab } = usePaneContext();
  invariant(target.kind === "swarm_board", "SwarmBoardPanel requires swarm_board target");
  const parentAgentId = target.parentAgentId;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  // COMPAT(providerSubagents): added in v0.2.11, remove after 2027-01-12.
  const supported = serverInfo?.features?.providerSubagents === true;

  const { descriptors, timelines } = useProviderSubagentStore(
    useShallow((state) => ({
      descriptors: state.descriptors,
      timelines: state.timelines,
    })),
  );

  useEffect(() => {
    if (!client || !supported) return;
    void refreshProviderSubagents(client, serverId, parentAgentId).catch(() => undefined);
  }, [client, serverId, supported, parentAgentId]);

  const cards = useMemo(
    () => buildSwarmCardViewModels({ serverId, parentAgentId, descriptors, timelines }),
    [serverId, parentAgentId, descriptors, timelines],
  );

  const hasRunning = cards.some((card) => card.status === "running");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), RUNNING_TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasRunning]);

  const [gridWidth, setGridWidth] = useState(0);
  const handleGridLayout = useCallback((event: LayoutChangeEvent) => {
    setGridWidth(event.nativeEvent.layout.width);
  }, []);
  const columns = gridColumnCount(gridWidth);
  const cardSlotStyle = useMemo(
    () => [styles.cardSlot, { width: `${100 / columns}%` as const }],
    [columns],
  );

  const handleOpenCard = useCallback(
    (card: SwarmCardViewModel) => {
      openTab({
        kind: "provider_subagent",
        parentAgentId: card.parentAgentId,
        subagentId: card.subagentId,
      });
    },
    [openTab],
  );

  if (serverInfo && !supported) {
    return (
      <View style={styles.centerState} testID="swarm-board-unsupported">
        <Text style={styles.centerStateText}>{t("message.actions.forkUnavailable")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="swarm-board-panel">
      <SwarmBoardSummaryBar cards={cards} />
      {cards.length === 0 ? (
        <View style={styles.centerState} testID="swarm-board-empty">
          <Text style={styles.centerStateText}>{t("swarmBoard.empty")}</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          testID="swarm-board-grid-scroll"
        >
          <View style={styles.grid} onLayout={handleGridLayout} testID="swarm-board-grid">
            {cards.map((card) => (
              <View key={card.key} style={cardSlotStyle}>
                <SwarmBoardCard card={card} now={now} onOpen={handleOpenCard} />
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
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
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
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
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing[2],
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  cardSlot: {
    padding: theme.spacing[2],
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  cardActive: {
    backgroundColor: theme.colors.surface2,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cardIcon: {
    width: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  cardIconColor: {
    color: theme.colors.foregroundMuted,
  },
  cardTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  statusBadge: {
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  statusBadgeText: {
    fontSize: theme.fontSize.xs,
  },
  cardActivity: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    minHeight: 30,
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  cardMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  statusRunningChip: {
    borderColor: theme.colors.palette.blue[500],
  },
  statusRunningText: {
    color: theme.colors.palette.blue[500],
  },
  statusCompletedChip: {
    borderColor: theme.colors.palette.green[500],
  },
  statusCompletedText: {
    color: theme.colors.palette.green[500],
  },
  statusFailedChip: {
    borderColor: theme.colors.palette.red[500],
  },
  statusFailedText: {
    color: theme.colors.palette.red[500],
  },
  statusCanceledChip: {
    borderColor: theme.colors.foregroundMuted,
  },
  statusCanceledText: {
    color: theme.colors.foregroundMuted,
  },
}));

const statusChipStyles: Record<SwarmCardStatus, object> = {
  running: styles.statusRunningChip,
  completed: styles.statusCompletedChip,
  failed: styles.statusFailedChip,
  canceled: styles.statusCanceledChip,
};

const statusChipTextStyles: Record<SwarmCardStatus, object> = {
  running: styles.statusRunningText,
  completed: styles.statusCompletedText,
  failed: styles.statusFailedText,
  canceled: styles.statusCanceledText,
};

export const swarmBoardPanelRegistration: PanelRegistration<"swarm_board"> = {
  kind: "swarm_board",
  component: SwarmBoardPanel,
  useDescriptor: useSwarmBoardDescriptor,
};
