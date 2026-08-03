import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { clusterModeLabelPatch, isClusterModeEnabled } from "@getpaseo/protocol/agent-labels";
import { useSessionStore } from "@/stores/session-store";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import { resolveClusterControl, type ClusterControlSlice } from "@/composer/agent-controls/cluster";
import { ClusterIcon } from "@/agent-controls/icons";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { baseColors } from "@/styles/theme";

export interface ClusterControlValue {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
}

export function ClusterControlTrigger({
  enabled,
  onToggle,
  disabled = false,
  surface = "toolbar",
}: ClusterControlValue & { surface?: "toolbar" | "sheet" }) {
  const { presentation } = useComposerControlLayout();
  const { t } = useTranslation();

  const handlePress = useCallback(() => onToggle(!enabled), [enabled, onToggle]);

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild triggerRefProp="ref">
        <ThemedClusterControlTrigger
          icon={ClusterIcon}
          iconColor={enabled ? baseColors.green[400] : undefined}
          surface={surface}
          label={t("agentControls.cluster.title")}
          value={t(enabled ? "agentControls.cluster.on" : "agentControls.cluster.off")}
          showToolbarLabel={surface === "toolbar" && presentation.showModeLabel}
          disabled={disabled}
          onPress={handlePress}
          accessibilityLabel={t("agentControls.cluster.title")}
          testID="agent-cluster-toggle"
        />
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltipRow}>
          <Text style={styles.tooltipText}>{t("agentControls.cluster.hint")}</Text>
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

export function useLiveClusterControl(
  serverId: string,
  agentId: string,
): ClusterControlValue | null {
  const slice = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agents?.get(agentId);
      const controlSlice: ClusterControlSlice = {
        supported: session?.serverInfo?.features?.clusterMode === true,
        enabled: isClusterModeEnabled(agent?.labels),
        hasClient: Boolean(session?.client),
      };
      return controlSlice;
    }),
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const toast = useToast();

  const onToggle = useCallback(
    (enabled: boolean) => {
      if (!client) return;
      void client
        .updateAgent(agentId, { labels: clusterModeLabelPatch(enabled) })
        .catch((error) => {
          console.warn("[ClusterControl] updateAgent failed", error);
          toast.error(toErrorMessage(error));
        });
    },
    [agentId, client, toast],
  );

  return useMemo(() => {
    const resolved = resolveClusterControl(slice);
    if (!resolved) {
      return null;
    }
    return {
      enabled: resolved.enabled,
      onToggle,
      disabled: resolved.disabled,
    };
  }, [onToggle, slice]);
}

const ThemedClusterControlTrigger = withUnistyles(AgentControlTrigger);

const styles = StyleSheet.create((theme) => ({
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
}));
