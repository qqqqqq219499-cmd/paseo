import { Plus } from "lucide-react-native";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Alert as RNAlert, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GrokAccount } from "@getpaseo/protocol/messages";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { GrokAddAccountSheet } from "./grok-add-account-sheet";
import { useGrokAccounts } from "./use-grok-accounts";

function accountPrimaryLabel(account: GrokAccount): string {
  return account.name?.trim() || account.email?.trim() || account.id;
}

function accountSecondaryLabel(account: GrokAccount): string | null {
  const name = account.name?.trim();
  const email = account.email?.trim();
  if (name && email && name !== email) {
    return email;
  }
  return null;
}

const KNOWN_CATEGORIES = new Set(["build", "api", "chat"]);

// grok.com's own label for a per-product weekly slice; unknown ids fall to "other".
function categoryLabel(category: string, t: TFunction): string {
  const key = KNOWN_CATEGORIES.has(category) ? category : "other";
  return t(`grokAccounts.category.${key}`);
}

// "Grok Build 35% · API 3% · Chat 2%" — the muted per-product breakdown line.
function breakdownSummary(
  breakdown: { category: string; percentUsed: number }[],
  t: TFunction,
): string {
  return breakdown
    .map((entry) => `${categoryLabel(entry.category, t)} ${Math.round(entry.percentUsed)}%`)
    .join(" · ");
}

// Short local date for the weekly reset ("Jul 17, 2026" / "2026年7月17日") in the
// active app language. Null when the timestamp is missing or unparseable.
function formatResetDate(iso: string, locale: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  try {
    return date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
}

export function GrokAccountsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const grok = useGrokAccounts(serverId);
  const {
    supported,
    isLocalDaemon,
    accounts,
    activeAccountId,
    unsavedActive,
    managedConfigActive,
    switchAccount,
    removeAccount,
  } = grok;

  const [addSheetVisible, setAddSheetVisible] = useState(false);
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);

  const openAddSheet = useCallback(() => setAddSheetVisible(true), []);
  const closeAddSheet = useCallback(() => setAddSheetVisible(false), []);

  // Switch, resolving the running-agent guard: the first call sends no force; a
  // "blocked" outcome opens a confirm dialog whose copy warns that grok reloads
  // its sign-in per request, then re-sends with force.
  const switchWithConfirm = useCallback(
    async (accountId: string) => {
      if (managedConfigActive) return;
      const result = await switchAccount(accountId);
      if (result.outcome !== "blocked") return;
      const confirmed = await confirmDialog({
        title: t("grokAccounts.switchBlockedTitle"),
        message: t("grokAccounts.switchBlockedBody"),
        confirmLabel: t("grokAccounts.switchAnyway"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (confirmed) {
        await switchAccount(accountId, { force: true });
      }
    },
    [managedConfigActive, switchAccount, t],
  );

  const handleSwitch = useCallback(
    (accountId: string) => {
      setBusyAccountId(accountId);
      void switchWithConfirm(accountId)
        .catch((error) => {
          RNAlert.alert(
            t("grokAccounts.title"),
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => setBusyAccountId(null));
    },
    [switchWithConfirm, t],
  );

  const handleRemove = useCallback(
    (account: GrokAccount) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("grokAccounts.removeConfirmTitle"),
          message: t("grokAccounts.removeConfirmBody", { name: accountPrimaryLabel(account) }),
          confirmLabel: t("grokAccounts.removeAnyway"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed) return;
        setBusyAccountId(account.id);
        try {
          const result = await removeAccount(account.id);
          // Removing the active account is guarded server-side; on "blocked" we
          // show the active-specific dialog and force (which keeps a backup and
          // never touches the live auth file).
          if (result.outcome === "blocked_active_account") {
            const forceConfirmed = await confirmDialog({
              title: t("grokAccounts.removeActiveTitle"),
              message: t("grokAccounts.removeActiveBody"),
              confirmLabel: t("grokAccounts.removeAnyway"),
              cancelLabel: t("common.actions.cancel"),
              destructive: true,
            });
            if (forceConfirmed) {
              await removeAccount(account.id, { force: true });
            }
          }
        } catch (error) {
          RNAlert.alert(
            t("grokAccounts.title"),
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          setBusyAccountId(null);
        }
      })();
    },
    [removeAccount, t],
  );

  const hasContent = accounts.length > 0 || unsavedActive != null;

  if (!supported) {
    return (
      <SettingsSection title={t("grokAccounts.title")} testID="grok-accounts-section">
        <View style={EMPTY_CARD_STYLE}>
          <Text style={styles.mutedText}>{t("grokAccounts.hostUpgradeRequired")}</Text>
        </View>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t("grokAccounts.title")} testID="grok-accounts-section">
      {managedConfigActive ? (
        <Alert variant="info" description={t("grokAccounts.managedConfig")} />
      ) : null}

      {hasContent ? (
        <View style={settingsStyles.card}>
          {unsavedActive ? (
            <View style={settingsStyles.row} testID="grok-accounts-unsaved-row">
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                  {t("grokAccounts.unsavedCurrent", {
                    email: unsavedActive.email ?? t("grokAccounts.unknownEmail"),
                  })}
                </Text>
              </View>
            </View>
          ) : null}

          {accounts.map((account) => (
            <GrokAccountRow
              key={account.id}
              account={account}
              isActive={account.id === activeAccountId}
              switchable={!managedConfigActive}
              busy={busyAccountId === account.id}
              onSwitch={handleSwitch}
              onRemove={handleRemove}
            />
          ))}
        </View>
      ) : (
        <View style={EMPTY_CARD_STYLE}>
          <Text style={styles.emptyTitle}>{t("grokAccounts.emptyTitle")}</Text>
          <Text style={styles.mutedText}>{t("grokAccounts.emptyBody")}</Text>
        </View>
      )}

      {isLocalDaemon ? (
        <Button
          variant="outline"
          size="sm"
          leftIcon={Plus}
          onPress={openAddSheet}
          testID="grok-accounts-add-button"
        >
          {t("grokAccounts.addAccount")}
        </Button>
      ) : (
        <Text style={styles.mutedText}>{t("grokAccounts.addFromDesktopHint")}</Text>
      )}

      {isLocalDaemon ? (
        <GrokAddAccountSheet
          serverId={serverId}
          visible={addSheetVisible}
          onClose={closeAddSheet}
          onMakeActive={switchWithConfirm}
        />
      ) : null}
    </SettingsSection>
  );
}

function GrokAccountRow({
  account,
  isActive,
  switchable,
  busy,
  onSwitch,
  onRemove,
}: {
  account: GrokAccount;
  isActive: boolean;
  switchable: boolean;
  busy: boolean;
  onSwitch: (accountId: string) => void;
  onRemove: (account: GrokAccount) => void;
}) {
  const { t } = useTranslation();

  const canSwitch = !isActive && switchable && !busy;
  const secondary = accountSecondaryLabel(account);

  const handlePressRow = useCallback(() => {
    if (!canSwitch) return;
    onSwitch(account.id);
  }, [canSwitch, onSwitch, account.id]);

  const handlePressRemove = useCallback(() => {
    onRemove(account);
  }, [onRemove, account]);

  return (
    <View style={settingsStyles.row} testID={`grok-account-row-${account.id}`}>
      <Pressable
        style={settingsStyles.rowContent}
        onPress={handlePressRow}
        disabled={!canSwitch}
        accessibilityRole="button"
        accessibilityLabel={t("grokAccounts.switchAction", { name: accountPrimaryLabel(account) })}
      >
        <View style={styles.titleRow}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {accountPrimaryLabel(account)}
          </Text>
          {isActive ? (
            <View style={styles.activeBadge}>
              <Text style={styles.activeBadgeText}>{t("grokAccounts.active")}</Text>
            </View>
          ) : null}
        </View>
        {secondary ? (
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {secondary}
          </Text>
        ) : null}
        <GrokQuotaLines account={account} />
        {account.needsReauth ? (
          <Text style={styles.reauthText} numberOfLines={2}>
            {t("grokAccounts.needsReauth")}
          </Text>
        ) : null}
      </Pressable>
      <Button
        variant="ghost"
        size="sm"
        textStyle={styles.removeText}
        onPress={handlePressRemove}
        disabled={busy}
        testID={`grok-account-remove-${account.id}`}
      >
        {t("grokAccounts.removeAction")}
      </Button>
    </View>
  );
}

// The weekly SuperGrok quota grok.com's Usage page shows: "N% used this week ·
// resets <date>" plus a muted per-product split. Falls back to "Quota unknown"
// when the daemon couldn't read it (status !== "ok" or no weekly percent yet).
function GrokQuotaLines({ account }: { account: GrokAccount }) {
  const { t, i18n } = useTranslation();
  const quota = account.quota;
  if (!quota || quota.status !== "ok" || quota.weeklyPercentUsed == null) {
    return (
      <Text style={settingsStyles.rowHint} numberOfLines={1}>
        {t("grokAccounts.quotaUnknown")}
      </Text>
    );
  }
  const percent = Math.round(quota.weeklyPercentUsed);
  const resetDate = quota.resetsAt ? formatResetDate(quota.resetsAt, i18n.language) : null;
  const breakdown = (quota.breakdown ?? []).filter((entry) => entry.percentUsed > 0);
  const weeklyLine = resetDate
    ? `${t("grokAccounts.weeklyUsed", { percent })} · ${t("grokAccounts.resetsOn", {
        date: resetDate,
      })}`
    : t("grokAccounts.weeklyUsed", { percent });
  return (
    <>
      <Text style={settingsStyles.rowHint} numberOfLines={1}>
        {weeklyLine}
      </Text>
      {breakdown.length > 0 ? (
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {t("grokAccounts.breakdown", { summary: breakdownSummary(breakdown, t) })}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyCard: {
    padding: theme.spacing[4],
    gap: theme.spacing[1],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  activeBadge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "rgba(74, 222, 128, 0.12)",
  },
  activeBadgeText: {
    color: theme.colors.palette.green[400],
    fontSize: theme.fontSize.xs,
  },
  reauthText: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  removeText: {
    color: theme.colors.destructive,
  },
}));

const EMPTY_CARD_STYLE = [settingsStyles.card, styles.emptyCard];
