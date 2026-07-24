import React, { useCallback, useMemo, useState, type ReactElement } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  INLINE_BOARD_MAX_HEIGHT,
  SWARM_STATUS_ORDER,
  SwarmBoardCard,
  swarmBoardStatusChipTextStyles,
  useSwarmBoardModel,
  useSwarmRunningNow,
} from "@/subagents/swarm-board-view";
import { summarizeSwarmCards, type SwarmCardViewModel } from "@/subagents/swarm-cards";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function compareCardsByCreatedAt(left: SwarmCardViewModel, right: SwarmCardViewModel): number {
  if (left.createdAt < right.createdAt) return -1;
  if (left.createdAt > right.createdAt) return 1;
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

function formatCardIndex(index: number): string {
  return String(index + 1).padStart(2, "0");
}

export interface InlineSwarmBlockProps {
  serverId: string;
  parentAgentId: string;
  onOpenCard: (card: SwarmCardViewModel) => void;
}

export function InlineSwarmBlock({
  serverId,
  parentAgentId,
  onOpenCard,
}: InlineSwarmBlockProps): ReactElement | null {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { cards } = useSwarmBoardModel(serverId, parentAgentId);
  const needsTick = cards.some((card) => card.status === "running");
  const now = useSwarmRunningNow(needsTick);

  const [gridWidth, setGridWidth] = useState(0);
  const handleGridLayout = useCallback((event: LayoutChangeEvent) => {
    setGridWidth(event.nativeEvent.layout.width);
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const headerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.header,
      (hovered || pressed) && styles.headerActive,
    ],
    [],
  );

  const orderedCards = useMemo(() => [...cards].sort(compareCardsByCreatedAt), [cards]);
  const summary = useMemo(() => summarizeSwarmCards(cards), [cards]);
  const columns = gridWidth >= 520 ? 2 : 1;
  const cardSlotStyle = useMemo(
    () => [styles.cardSlot, { width: `${100 / columns}%` as const }],
    [columns],
  );

  if (orderedCards.length === 0) {
    return null;
  }

  const firstTitle = orderedCards[0]?.title ?? "";
  const headerLabel = t("swarmBoard.inlineHeader", {
    count: orderedCards.length,
    title: firstTitle,
  });

  return (
    <View style={styles.container} testID="inline-swarm-block">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={headerLabel}
        testID="inline-swarm-block-header"
        onPress={toggleExpanded}
        style={headerStyle}
      >
        {expanded ? (
          <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
        ) : (
          <ThemedChevronRight size={12} uniProps={foregroundMutedColorMapping} />
        )}
        <Text style={styles.headerLabel} numberOfLines={1} testID="inline-swarm-block-title">
          {headerLabel}
        </Text>
        <View style={styles.headerSummary}>
          {SWARM_STATUS_ORDER.map((status) =>
            summary[status] > 0 ? (
              <Text
                key={status}
                style={[styles.headerStatusText, swarmBoardStatusChipTextStyles[status]]}
                testID={`inline-swarm-block-status-${status}`}
              >
                {t(`swarmBoard.status.${status}`)} {summary[status]}
              </Text>
            ) : null,
          )}
        </View>
      </Pressable>
      {expanded ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          testID="inline-swarm-block-scroll"
        >
          <View style={styles.grid} onLayout={handleGridLayout} testID="inline-swarm-block-grid">
            {orderedCards.map((card, index) => (
              <View key={card.key} style={cardSlotStyle}>
                <SwarmBoardCard
                  card={card}
                  now={now}
                  onOpen={onOpenCard}
                  indexLabel={formatCardIndex(index)}
                />
              </View>
            ))}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  headerActive: {
    backgroundColor: theme.colors.surface2,
  },
  headerLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  headerSummary: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerStatusText: {
    fontSize: theme.fontSize.xs,
  },
  scroll: {
    maxHeight: INLINE_BOARD_MAX_HEIGHT,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
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
}));
