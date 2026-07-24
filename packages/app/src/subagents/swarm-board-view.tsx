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
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/react/shallow";
import { getProviderIcon } from "@/components/provider-icons";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { refreshProviderSubagents, useProviderSubagentStore } from "@/subagents/provider-store";
import {
  syncPaseoSubagentHistory,
  usePaseoSubagentHistoryStore,
  type PaseoSubagentHistoryEntry,
} from "@/subagents/paseo-history-store";
import {
  buildSwarmCardViewModels,
  summarizeSwarmCards,
  type SwarmCardDisplayState,
  type SwarmCardStatus,
  type SwarmCardViewModel,
} from "@/subagents/swarm-cards";

const WIDE_GRID_MIN_WIDTH = 900;
const MEDIUM_GRID_MIN_WIDTH = 560;
const RUNNING_TICK_INTERVAL_MS = 1000;
export const INLINE_BOARD_MAX_HEIGHT = 280;

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

function gridInlineColumnCount(width: number): number {
  return width >= 520 ? 2 : 1;
}

const UNFINISHED_PROGRESS_CAP = 0.85;
const PROGRESS_TIME_CONSTANT_MS = 90_000;
const PROGRESS_MIN_VISIBLE = 0.03;

function isIndeterminateDisplayState(displayState: SwarmCardDisplayState): boolean {
  return displayState === "queued" || displayState === "working" || displayState === "waiting";
}

// Kimi-style estimated fill: asymptotic toward UNFINISHED_PROGRESS_CAP while
// unfinished, snapping to a full bar on terminal states.
function estimatedUnfinishedProgress(elapsedMs: number): number {
  const estimate = UNFINISHED_PROGRESS_CAP * (1 - Math.exp(-elapsedMs / PROGRESS_TIME_CONSTANT_MS));
  return Math.max(PROGRESS_MIN_VISIBLE, estimate);
}

export const SWARM_STATUS_ORDER: SwarmCardStatus[] = ["running", "completed", "failed", "canceled"];

function SwarmBoardSummaryBar({ cards }: { cards: SwarmCardViewModel[] }): ReactElement {
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

function SwarmCardProgressBar({
  displayState,
  createdAt,
  now,
}: {
  displayState: SwarmCardDisplayState;
  createdAt: string;
  now: number;
}): ReactElement {
  const indeterminate = isIndeterminateDisplayState(displayState);
  const fillStyle = progressFillStyles[displayState];
  if (indeterminate) {
    const elapsedMs = Math.max(0, now - Date.parse(createdAt));
    const width = `${(estimatedUnfinishedProgress(elapsedMs) * 100).toFixed(1)}%` as const;
    return (
      <View style={styles.progressTrack} testID="swarm-board-progress">
        <View
          style={[styles.progressFill, fillStyle, { width }]}
          testID="swarm-board-progress-fill"
        />
      </View>
    );
  }
  return (
    <View style={styles.progressTrack} testID="swarm-board-progress">
      <View
        style={[styles.progressFill, fillStyle, styles.progressFillFull]}
        testID="swarm-board-progress-fill"
      />
    </View>
  );
}

export function SwarmBoardCard({
  card,
  now,
  onOpen,
  indexLabel,
}: {
  card: SwarmCardViewModel;
  now: number;
  onOpen: (card: SwarmCardViewModel) => void;
  indexLabel?: string;
}): ReactElement {
  const { t } = useTranslation();
  const ProviderIcon = useMemo(() => getProviderIcon(card.provider), [card.provider]);
  const durationLabel =
    card.status === "running"
      ? formatDurationMs(Math.max(0, now - Date.parse(card.createdAt)))
      : formatDurationMs(card.durationMs);
  const handlePress = useCallback(() => onOpen(card), [card, onOpen]);
  const cardStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.card,
      (hovered || pressed) && styles.cardActive,
    ],
    [],
  );

  return (
    <Pressable
      accessibilityRole="button"
      testID={`swarm-board-card-${card.subagentId}`}
      onPress={handlePress}
      style={cardStyle}
    >
      <View style={styles.cardHeader}>
        {indexLabel ? (
          <Text style={styles.cardIndex} testID={`swarm-board-card-index-${card.subagentId}`}>
            {indexLabel}
          </Text>
        ) : null}
        <View style={styles.cardIcon}>
          <ProviderIcon size={16} color={styles.cardIconColor.color} />
        </View>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {card.title}
        </Text>
        <View style={[styles.statusBadge, displayChipStyles[card.displayState]]}>
          <Text style={[styles.statusBadgeText, displayChipTextStyles[card.displayState]]}>
            {t(`swarmBoard.displayState.${card.displayState}`)}
          </Text>
        </View>
      </View>
      <Text style={styles.cardActivity} numberOfLines={2}>
        {card.lastActivityPreview ?? t("swarmBoard.lastActivityNone")}
      </Text>
      <SwarmCardProgressBar displayState={card.displayState} createdAt={card.createdAt} now={now} />
      <View style={styles.cardFooter}>
        <Text style={styles.cardMeta}>
          {t("swarmBoard.toolCalls", { count: card.toolCallCount })}
        </Text>
        <Text style={styles.cardMeta}>{durationLabel}</Text>
      </View>
    </Pressable>
  );
}

export interface SwarmBoardModel {
  cards: SwarmCardViewModel[];
  supported: boolean;
  serverInfoLoaded: boolean;
  paseoAgentCount: number;
}

export function useSwarmBoardModel(serverId: string, parentAgentId: string): SwarmBoardModel {
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

  const { agents, agentStreamTail } = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      return {
        agents: session?.agents ?? null,
        agentStreamTail: session?.agentStreamTail ?? null,
      };
    }),
  );
  const historyEntries = usePaseoSubagentHistoryStore((state) => state.entries);
  // Derive the child-agent list outside the store selector. The selector must
  // return referentially stable values: a freshly built array on every
  // snapshot defeats useShallow's memoization and loops useSyncExternalStore
  // (React minified error #185, "Maximum update depth exceeded").
  const paseoAgents = useMemo(() => {
    const rows: Agent[] = [];
    if (agents) {
      for (const agent of agents.values()) {
        if (agent.archivedAt || agent.parentAgentId !== parentAgentId) continue;
        rows.push(agent);
      }
    }
    return rows;
  }, [agents, parentAgentId]);

  useEffect(() => {
    if (!client || !supported) return;
    void refreshProviderSubagents(client, serverId, parentAgentId).catch(() => undefined);
  }, [client, serverId, supported, parentAgentId]);

  const paseoHistory = useMemo(() => {
    const history = new Map<string, PaseoSubagentHistoryEntry>();
    const prefix = `${serverId}\0`;
    for (const [key, entry] of historyEntries) {
      if (key.startsWith(prefix)) {
        history.set(key.slice(prefix.length), entry);
      }
    }
    return history;
  }, [historyEntries, serverId]);

  const cards = useMemo(
    () =>
      buildSwarmCardViewModels({
        serverId,
        parentAgentId,
        paseoAgents,
        descriptors,
        timelines,
        agentStreamTail: agentStreamTail ?? undefined,
        paseoHistory,
      }),
    [serverId, parentAgentId, paseoAgents, descriptors, timelines, agentStreamTail, paseoHistory],
  );

  useEffect(() => {
    if (!client) return;
    for (const card of cards) {
      if (card.kind !== "paseo") continue;
      void syncPaseoSubagentHistory(
        client,
        serverId,
        card.subagentId,
        card.status === "running",
      )?.catch(() => undefined);
    }
  }, [client, serverId, cards]);

  return {
    cards,
    supported,
    serverInfoLoaded: serverInfo !== null,
    paseoAgentCount: paseoAgents.length,
  };
}

export function useSwarmRunningNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), RUNNING_TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export interface SwarmBoardViewProps {
  serverId: string;
  parentAgentId: string;
  /** panel = full tab; inline = embedded in the parent agent session */
  variant?: "panel" | "inline";
  onOpenCard: (card: SwarmCardViewModel) => void;
}

export function SwarmBoardView({
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

  const needsTick = cards.some(
    (card) => card.status === "running" || isIndeterminateDisplayState(card.displayState),
  );
  const now = useSwarmRunningNow(needsTick);

  const [gridWidth, setGridWidth] = useState(0);
  const handleGridLayout = useCallback((event: LayoutChangeEvent) => {
    setGridWidth(event.nativeEvent.layout.width);
  }, []);
  // Inline sits in a narrow composer-width strip; prefer denser columns sooner.
  const columns = isInline ? gridInlineColumnCount(gridWidth) : gridColumnCount(gridWidth);
  const cardSlotStyle = useMemo(
    () => [styles.cardSlot, { width: `${100 / columns}%` as const }],
    [columns],
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
      testID={isInline ? "swarm-board-inline" : "swarm-board-panel"}
    >
      <SwarmBoardSummaryBar cards={cards} />
      {cards.length === 0 ? (
        <View
          style={isInline ? styles.centerStateInline : styles.centerState}
          testID="swarm-board-empty"
        >
          <Text style={styles.centerStateText}>{t("swarmBoard.empty")}</Text>
        </View>
      ) : (
        <ScrollView
          style={isInline ? styles.scrollInline : styles.scroll}
          contentContainerStyle={styles.scrollContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          testID="swarm-board-grid-scroll"
        >
          <View style={styles.grid} onLayout={handleGridLayout} testID="swarm-board-grid">
            {cards.map((card) => (
              <View key={card.key} style={cardSlotStyle}>
                <SwarmBoardCard card={card} now={now} onOpen={onOpenCard} />
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
  scroll: {
    flex: 1,
  },
  scrollInline: {
    maxHeight: INLINE_BOARD_MAX_HEIGHT - 44,
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
  cardIndex: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
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
  progressTrack: {
    height: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.border,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
  },
  progressFillFull: {
    width: "100%",
  },
  progressQueued: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  progressWorking: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  progressWaiting: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  progressCompleted: {
    backgroundColor: theme.colors.palette.green[500],
  },
  progressFailed: {
    backgroundColor: theme.colors.palette.red[500],
  },
  progressCanceled: {
    backgroundColor: theme.colors.foregroundMuted,
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
  displayQueuedChip: {
    borderColor: theme.colors.palette.amber[500],
  },
  displayQueuedText: {
    color: theme.colors.palette.amber[500],
  },
  displayWorkingChip: {
    borderColor: theme.colors.palette.blue[500],
  },
  displayWorkingText: {
    color: theme.colors.palette.blue[500],
  },
  displayWaitingChip: {
    borderColor: theme.colors.palette.amber[500],
  },
  displayWaitingText: {
    color: theme.colors.palette.amber[500],
  },
  displayCompletedChip: {
    borderColor: theme.colors.palette.green[500],
  },
  displayCompletedText: {
    color: theme.colors.palette.green[500],
  },
  displayFailedChip: {
    borderColor: theme.colors.palette.red[500],
  },
  displayFailedText: {
    color: theme.colors.palette.red[500],
  },
  displayCanceledChip: {
    borderColor: theme.colors.foregroundMuted,
  },
  displayCanceledText: {
    color: theme.colors.foregroundMuted,
  },
}));

export const swarmBoardStatusChipStyles: Record<SwarmCardStatus, object> = {
  running: styles.statusRunningChip,
  completed: styles.statusCompletedChip,
  failed: styles.statusFailedChip,
  canceled: styles.statusCanceledChip,
};

export const swarmBoardStatusChipTextStyles: Record<SwarmCardStatus, object> = {
  running: styles.statusRunningText,
  completed: styles.statusCompletedText,
  failed: styles.statusFailedText,
  canceled: styles.statusCanceledText,
};

const displayChipStyles: Record<SwarmCardDisplayState, object> = {
  queued: styles.displayQueuedChip,
  working: styles.displayWorkingChip,
  waiting: styles.displayWaitingChip,
  completed: styles.displayCompletedChip,
  failed: styles.displayFailedChip,
  canceled: styles.displayCanceledChip,
};

const displayChipTextStyles: Record<SwarmCardDisplayState, object> = {
  queued: styles.displayQueuedText,
  working: styles.displayWorkingText,
  waiting: styles.displayWaitingText,
  completed: styles.displayCompletedText,
  failed: styles.displayFailedText,
  canceled: styles.displayCanceledText,
};

const progressFillStyles: Record<SwarmCardDisplayState, object> = {
  queued: styles.progressQueued,
  working: styles.progressWorking,
  waiting: styles.progressWaiting,
  completed: styles.progressCompleted,
  failed: styles.progressFailed,
  canceled: styles.progressCanceled,
};
