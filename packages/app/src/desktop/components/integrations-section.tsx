import { useCallback, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowUpRight, Terminal, Blocks, Check, Settings2, Share2 } from "lucide-react-native";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/utils/open-external-url";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  shouldUseDesktopDaemon,
  type SharedContextStatus,
  type SkillOp,
  type SkillsSnapshot,
} from "@/desktop/daemon/desktop-daemon";
import { SkillSelectionSheet } from "@/desktop/components/skill-selection-sheet";
import {
  useCliInstall,
  useSharedContextStatus,
  useSkillsStatus,
} from "@/desktop/hooks/use-install-status";

const CLI_DOCS_URL = "https://paseo.sh/docs/cli";
const SKILLS_DOCS_URL = "https://paseo.sh/docs/skills";
const OP_KIND_ORDER: Record<SkillOp["kind"], number> = { add: 0, update: 1, delete: 2 };
const OP_KIND_LABEL_KEY: Record<SkillOp["kind"], string> = {
  add: "settings.integrations.operations.add",
  update: "settings.integrations.operations.update",
  delete: "settings.integrations.operations.delete",
};

function formatUpdateMessage(ops: readonly SkillOp[], t: TFunction): string {
  const sorted = [...ops].sort((a, b) => {
    const kindOrder = OP_KIND_ORDER[a.kind] - OP_KIND_ORDER[b.kind];
    return kindOrder !== 0 ? kindOrder : a.name.localeCompare(b.name);
  });
  return sorted.map((op) => `${t(OP_KIND_LABEL_KEY[op.kind])} ${op.name}`).join("\n");
}

function sharedContextDescription(status: SharedContextStatus | null, t: TFunction): string {
  if (!status) return t("settings.integrations.sharedContext.description");
  if (!status.mcpProxyReachable) return t("settings.integrations.sharedContext.proxyOffline");
  const detected = status.providers.filter((provider) => provider.detected);
  if (detected.length === 0) return t("settings.integrations.sharedContext.description");
  const ready = detected.filter(
    (provider) =>
      provider.prompt !== "drift" && provider.skills !== "drift" && provider.mcp !== "drift",
  ).length;
  return status.state === "ready"
    ? t("settings.integrations.sharedContext.ready", { count: detected.length })
    : t("settings.integrations.sharedContext.drift", { ready, count: detected.length });
}

export function IntegrationsSection() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const showSection = shouldUseDesktopDaemon();
  const {
    status: cliStatus,
    isInstalling: isInstallingCli,
    install: installCli,
    refresh: refreshCliStatus,
  } = useCliInstall();
  const {
    status: skillsStatus,
    isWorking: isSkillsWorking,
    install: installSkills,
    update: updateSkills,
    uninstall: uninstallSkills,
    saveSelection: saveSkillSelection,
    refresh: refreshSkillsStatus,
  } = useSkillsStatus();
  const [isChoosingSkills, setIsChoosingSkills] = useState(false);
  const skillMaintenanceOps = useMemo(
    () => skillsStatus?.ops.filter((op) => op.kind !== "delete") ?? [],
    [skillsStatus?.ops],
  );
  const {
    status: sharedContextStatus,
    isWorking: isSharedContextWorking,
    sync: syncSharedContext,
    refresh: refreshSharedContextStatus,
  } = useSharedContextStatus();

  useFocusEffect(
    useCallback(() => {
      if (!showSection) return undefined;
      refreshCliStatus();
      void refreshSkillsStatus();
      void refreshSharedContextStatus();
      return undefined;
    }, [refreshCliStatus, refreshSharedContextStatus, refreshSkillsStatus, showSection]),
  );

  const handleInstallCli = useCallback(() => {
    if (isInstallingCli) return;
    installCli();
  }, [installCli, isInstallingCli]);

  const handleInstallSkills = useCallback(() => {
    if (isSkillsWorking) return;
    void installSkills();
  }, [installSkills, isSkillsWorking]);

  const handleUpdateSkills = useCallback(async () => {
    if (isSkillsWorking) return;
    const confirmed = await confirmDialog({
      title: t("settings.integrations.skills.updateTitle"),
      message:
        skillMaintenanceOps.length > 0
          ? formatUpdateMessage(skillMaintenanceOps, t)
          : t("settings.integrations.skills.updateFallback"),
      confirmLabel: t("settings.integrations.actions.update"),
    });
    if (!confirmed) return;
    await updateSkills();
  }, [isSkillsWorking, skillMaintenanceOps, t, updateSkills]);

  const handleUninstallSkills = useCallback(async () => {
    if (isSkillsWorking) return;
    const confirmed = await confirmDialog({
      title: t("settings.integrations.skills.uninstallTitle"),
      message: t("settings.integrations.skills.uninstallMessage"),
      confirmLabel: t("settings.integrations.actions.uninstall"),
      destructive: true,
    });
    if (!confirmed) return;
    await uninstallSkills();
  }, [isSkillsWorking, t, uninstallSkills]);

  const handleOpenSkillSelection = useCallback(() => {
    setIsChoosingSkills(true);
  }, []);

  const handleCloseSkillSelection = useCallback(() => {
    setIsChoosingSkills(false);
  }, []);

  const handleSyncSharedContext = useCallback(async () => {
    if (isSharedContextWorking) return;
    const confirmed = await confirmDialog({
      title: t("settings.integrations.sharedContext.syncTitle"),
      message: t("settings.integrations.sharedContext.syncMessage"),
      confirmLabel: t("settings.integrations.actions.sync"),
    });
    if (!confirmed) return;
    await syncSharedContext();
  }, [isSharedContextWorking, syncSharedContext, t]);

  const handleOpenCliDocs = useCallback(() => {
    void openExternalUrl(CLI_DOCS_URL);
  }, []);

  const handleOpenSkillsDocs = useCallback(() => {
    void openExternalUrl(SKILLS_DOCS_URL);
  }, []);

  const arrowIcon = useMemo(
    () => <ArrowUpRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    [theme.iconSize.sm, theme.colors.foregroundMuted],
  );

  const chooseSkillsIcon = useMemo(
    () => <Settings2 size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />,
    [theme.iconSize.sm, theme.colors.foregroundMuted],
  );

  const trailing = useMemo(
    () => (
      <View style={styles.headerLinks}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={arrowIcon}
          textStyle={settingsStyles.sectionHeaderLinkText}
          style={settingsStyles.sectionHeaderLink}
          onPress={handleOpenCliDocs}
          accessibilityLabel={t("settings.integrations.docs.openCli")}
        >
          {t("settings.integrations.docs.cli")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={arrowIcon}
          textStyle={settingsStyles.sectionHeaderLinkText}
          style={settingsStyles.sectionHeaderLink}
          onPress={handleOpenSkillsDocs}
          accessibilityLabel={t("settings.integrations.docs.openSkills")}
        >
          {t("settings.integrations.docs.skills")}
        </Button>
      </View>
    ),
    [arrowIcon, handleOpenCliDocs, handleOpenSkillsDocs, t],
  );

  if (!showSection) {
    return null;
  }

  const skillsState =
    skillsStatus?.state === "drift" && skillMaintenanceOps.length === 0
      ? "up-to-date"
      : (skillsStatus?.state ?? null);
  const hasSelectedSkills =
    (skillsStatus?.selection.mode === "all" && skillsStatus.available.length > 0) ||
    (skillsStatus?.selection.mode === "custom" &&
      skillsStatus.selection.skills.some((name) => skillsStatus.available.includes(name)));

  return (
    <SettingsSection title={t("settings.integrations.title")} trailing={trailing}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.rowTitleRow}>
              <Terminal size={theme.iconSize.md} color={theme.colors.foreground} />
              <Text style={settingsStyles.rowTitle}>
                {t("settings.integrations.commandLine.title")}
              </Text>
            </View>
            <Text style={settingsStyles.rowHint}>
              {t("settings.integrations.commandLine.description")}
            </Text>
          </View>
          {cliStatus?.installed ? (
            <View style={styles.installedLabel}>
              <Check size={14} color={theme.colors.foregroundMuted} />
              <Text style={styles.mutedText}>{t("settings.integrations.actions.installed")}</Text>
            </View>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onPress={handleInstallCli}
              disabled={isInstallingCli}
            >
              {isInstallingCli
                ? t("settings.integrations.actions.installing")
                : t("settings.integrations.actions.install")}
            </Button>
          )}
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.rowTitleRow}>
              <Blocks size={theme.iconSize.md} color={theme.colors.foreground} />
              <Text style={settingsStyles.rowTitle}>{t("settings.integrations.skills.title")}</Text>
            </View>
            <Text style={settingsStyles.rowHint}>
              {skillsState === "drift"
                ? t("settings.integrations.skills.updateAvailable")
                : t("settings.integrations.skills.description")}
            </Text>
          </View>
          <View style={styles.actionsRow}>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={chooseSkillsIcon}
              onPress={handleOpenSkillSelection}
              disabled={skillsStatus === null || isSkillsWorking}
              accessibilityLabel={t("settings.integrations.skills.choose")}
            />
            {hasSelectedSkills ? (
              <SkillsActions
                state={skillsState}
                isWorking={isSkillsWorking}
                onInstall={handleInstallSkills}
                onUpdate={handleUpdateSkills}
                onUninstall={handleUninstallSkills}
              />
            ) : null}
          </View>
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.rowTitleRow}>
              <Share2 size={theme.iconSize.md} color={theme.colors.foreground} />
              <Text style={settingsStyles.rowTitle}>
                {t("settings.integrations.sharedContext.title")}
              </Text>
            </View>
            <Text style={settingsStyles.rowHint}>
              {sharedContextDescription(sharedContextStatus, t)}
            </Text>
          </View>
          <SharedContextAction
            status={sharedContextStatus}
            isWorking={isSharedContextWorking}
            onSync={handleSyncSharedContext}
          />
        </View>
      </View>
      {skillsStatus ? (
        <SkillSelectionSheet
          visible={isChoosingSkills}
          available={skillsStatus.available}
          selection={skillsStatus.selection}
          isSaving={isSkillsWorking}
          onSave={saveSkillSelection}
          onClose={handleCloseSkillSelection}
        />
      ) : null}
    </SettingsSection>
  );
}

function SharedContextAction({
  status,
  isWorking,
  onSync,
}: {
  status: SharedContextStatus | null;
  isWorking: boolean;
  onSync: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  if (status?.state === "ready") {
    return (
      <View style={styles.installedLabel}>
        <Check size={14} color={theme.colors.foregroundMuted} />
        <Text style={styles.mutedText}>{t("settings.integrations.actions.synced")}</Text>
      </View>
    );
  }
  return (
    <Button variant="outline" size="sm" onPress={onSync} disabled={isWorking}>
      {isWorking
        ? t("settings.integrations.actions.syncing")
        : t("settings.integrations.actions.sync")}
    </Button>
  );
}

interface SkillsActionsProps {
  state: SkillsSnapshot["state"] | null;
  isWorking: boolean;
  onInstall: () => void;
  onUpdate: () => void;
  onUninstall: () => void;
}

function SkillsActions({ state, isWorking, onInstall, onUpdate, onUninstall }: SkillsActionsProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();

  if (state === "up-to-date") {
    return (
      <View style={styles.actionsRow}>
        <View style={styles.installedLabel}>
          <Check size={14} color={theme.colors.foregroundMuted} />
          <Text style={styles.mutedText}>{t("settings.integrations.actions.installed")}</Text>
        </View>
        <Button variant="outline" size="sm" onPress={onUninstall} disabled={isWorking}>
          {t("settings.integrations.actions.uninstall")}
        </Button>
      </View>
    );
  }

  if (state === "drift") {
    return (
      <View style={styles.actionsRow}>
        <Button variant="outline" size="sm" onPress={onUpdate} disabled={isWorking}>
          {isWorking
            ? t("settings.integrations.actions.working")
            : t("settings.integrations.actions.update")}
        </Button>
        <Button variant="outline" size="sm" onPress={onUninstall} disabled={isWorking}>
          {t("settings.integrations.actions.uninstall")}
        </Button>
      </View>
    );
  }

  return (
    <Button variant="outline" size="sm" onPress={onInstall} disabled={isWorking}>
      {isWorking
        ? t("settings.integrations.actions.installing")
        : t("settings.integrations.actions.install")}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  headerLinks: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0],
  },
  rowTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  installedLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
