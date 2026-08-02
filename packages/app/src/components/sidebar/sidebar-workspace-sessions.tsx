import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import { SessionStatusIcon } from "@/components/sidebar/session-status-icon";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useToast } from "@/contexts/toast-context";
import { agentHistoryQueryKey } from "@/hooks/agent-history-query-key";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useSessionStore } from "@/stores/session-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { toErrorMessage } from "@/utils/error-messages";
import { formatTimeAgo } from "@/utils/time";
import { navigateToAgentDirectoryEntry } from "@/utils/navigate-to-agent-directory-entry";

// The new-theme flat sessions list is primary navigation, so its rows get a
// larger leading provider icon than nested per-workspace session rows.
const FLAT_SESSION_ICON_SIZE = 16;

export const SidebarSessionRow = memo(function SidebarSessionRow({
  session,
  subtitle = null,
  timeOverride = null,
  variant = "default",
}: {
  session: AgentDirectoryEntry;
  /** Secondary line under the title — the flat sessions list shows the project. */
  subtitle?: string | null;
  /** Time to display + the caller already sorted by (e.g. last user message). */
  timeOverride?: Date | null;
  /**
   * "flat" rounds the hover/press background to the content-card radius so the
   * new-theme flat sessions list reads as part of the same rounded surface as
   * the right pane. "default" keeps the tighter nested-row radius.
   */
  variant?: "default" | "flat";
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { archiveAgent } = useArchiveAgent();
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  const handlePress = useCallback(() => {
    navigateToAgentDirectoryEntry(session);
  }, [session]);

  const handleOpenRename = useCallback(() => {
    setIsRenameOpen(true);
  }, []);
  const handleCloseRename = useCallback(() => {
    setIsRenameOpen(false);
  }, []);
  const handleRenameSubmit = useCallback(
    async (nextTitle: string) => {
      const client = useSessionStore.getState().sessions[session.serverId]?.client ?? null;
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      await client.updateAgent(session.id, { name: nextTitle.trim() });
      void queryClient.invalidateQueries({ queryKey: agentHistoryQueryKey(session.serverId) });
    },
    [queryClient, session.id, session.serverId, t],
  );

  const handleArchive = useCallback(() => {
    if (isArchiving) {
      return;
    }
    setIsArchiving(true);
    void archiveAgent({ serverId: session.serverId, agentId: session.id })
      .catch((error) => {
        toast.error(toErrorMessage(error));
      })
      .finally(() => {
        setIsArchiving(false);
      });
  }, [archiveAgent, isArchiving, session.id, session.serverId, toast]);

  const handleCopyAgentId = useCallback(() => {
    if (!session.id) {
      return;
    }
    void Clipboard.setStringAsync(session.id)
      .then(() => {
        toast.copied(t("workspace.tabs.toasts.agentIdCopiedLabel"));
      })
      .catch(() => {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      });
  }, [session.id, t, toast]);

  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.sessionRow,
      variant === "flat" && styles.sessionRowFlatRadius,
      (Boolean(hovered) || pressed) && styles.rowHovered,
    ],
    [variant],
  );

  const stateBucket = deriveSidebarStateBucket({
    status: session.status,
    pendingPermissionCount: session.pendingPermissionCount ?? 0,
    requiresAttention: session.requiresAttention,
    attentionReason: session.attentionReason,
  });

  const titleStyle = useMemo(
    () => [
      styles.sessionTitle,
      stateBucket === "failed" && styles.sessionTitleFailed,
      stateBucket === "needs_input" && styles.sessionTitleNeedsInput,
    ],
    [stateBucket],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        onPress={handlePress}
        style={pressableStyle}
        accessibilityRole="button"
        testID={`sidebar-session-${session.id}`}
      >
        <SessionStatusIcon
          provider={session.provider}
          stateBucket={stateBucket}
          size={variant === "flat" ? FLAT_SESSION_ICON_SIZE : undefined}
        />
        <View style={styles.sessionTextColumn}>
          <Text style={titleStyle} numberOfLines={1}>
            {session.title ?? t("importSession.preview.untitledSession")}
          </Text>
          {subtitle ? (
            <Text style={styles.sessionSubtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <Text style={styles.sessionTime} numberOfLines={1}>
          {formatTimeAgo(timeOverride ?? session.lastActivityAt)}
        </Text>
      </ContextMenuTrigger>
      <ContextMenuContent
        align="start"
        width={200}
        mobileMode="sheet"
        testID={`sidebar-session-context-${session.id}`}
      >
        <ContextMenuItem
          testID={`sidebar-session-context-${session.id}-rename`}
          onSelect={handleOpenRename}
        >
          {t("workspace.tabs.menu.renameAgent")}
        </ContextMenuItem>
        <ContextMenuItem
          testID={`sidebar-session-context-${session.id}-copy-id`}
          onSelect={handleCopyAgentId}
        >
          {t("workspace.tabs.menu.copyAgentId")}
        </ContextMenuItem>
        <ContextMenuItem
          testID={`sidebar-session-context-${session.id}-archive`}
          status={isArchiving ? "pending" : "idle"}
          pendingLabel={t("agentList.archiveSheet.archiving", {
            defaultValue: "Archiving…",
          })}
          destructive
          onSelect={handleArchive}
        >
          {t("agentList.archiveSheet.archive")}
        </ContextMenuItem>
      </ContextMenuContent>
      <AdaptiveRenameModal
        visible={isRenameOpen}
        title={t("workspace.tabs.menu.renameAgent")}
        initialValue={session.title ?? ""}
        submitLabel={t("workspace.tabs.menu.rename")}
        onClose={handleCloseRename}
        onSubmit={handleRenameSubmit}
        testID={`sidebar-session-rename-${session.id}`}
      />
    </ContextMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  // Match the floating content card's corner radius so the new-theme flat list
  // hover/press surface reads as part of the same rounded language as the right pane.
  sessionRowFlatRadius: {
    borderRadius: theme.shell.contentRadius,
  },
  sessionTextColumn: {
    flex: 1,
    minWidth: 0,
  },
  sessionTitle: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  sessionSubtitle: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginTop: 1,
  },
  sessionTitleFailed: {
    color: theme.colors.palette.red[500],
  },
  sessionTitleNeedsInput: {
    color: theme.colors.palette.amber[500],
  },
  sessionTime: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
}));
