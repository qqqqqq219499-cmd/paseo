import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  type PressableStateCallbackType,
  Text,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { openExternalUrl } from "@/utils/open-external-url";
import { useGrokAccounts } from "./use-grok-accounts";

type Phase = "choose" | "waiting" | "completed" | "failed";
type LoginMode = "oauth" | "device-auth";

const CLI_MISSING_PATTERN = /not found|enoent|not installed|no such file/i;
// How long the copy buttons show the "copied" confirmation before reverting.
const COPIED_RESET_MS = 1500;

export function GrokAddAccountSheet({
  serverId,
  visible,
  onClose,
  onMakeActive,
}: {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  onMakeActive: (accountId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { accounts, login, startLogin, cancelLogin } = useGrokAccounts(serverId);

  const [phase, setPhase] = useState<Phase>("choose");
  const [mode, setMode] = useState<LoginMode | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);

  // Bumped whenever we reset or start a new attempt, so a still-in-flight
  // startLogin that resolves late can't write into a newer attempt's state.
  const attemptRef = useRef(0);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetToChoose = useCallback(() => {
    attemptRef.current += 1;
    setPhase("choose");
    setMode(null);
    setAuthUrl(null);
    setUserCode(null);
    setLoginId(null);
    setErrorMessage(null);
  }, []);

  // Every time the sheet opens, present the method choice — never auto-start a
  // login. The user picks oauth vs device-auth explicitly.
  useEffect(() => {
    if (!visible) return;
    resetToChoose();
  }, [visible, resetToChoose]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const beginLogin = useCallback(
    (nextMode: LoginMode) => {
      const attempt = (attemptRef.current += 1);
      setMode(nextMode);
      setAuthUrl(null);
      setUserCode(null);
      setLoginId(null);
      setErrorMessage(null);
      setPhase("waiting");
      void (async () => {
        try {
          const result = await startLogin(nextMode);
          if (attemptRef.current !== attempt) {
            if (result.outcome === "started" && result.loginId) {
              void cancelLogin(result.loginId).catch(() => undefined);
            }
            return;
          }
          if (result.outcome === "already_in_progress") {
            setLoginId(result.loginId);
            setErrorMessage(t("grokAccounts.login.alreadyInProgress"));
            setPhase("failed");
            return;
          }
          setLoginId(result.loginId);
          setAuthUrl(result.authUrl);
          setUserCode(result.userCode);
          // Deliberately NO auto-open here: for the oauth path the grok CLI opens
          // the system browser itself even when spawned headless (field-verified
          // 2026-07-11 — an auto-open here produced TWO browser windows). The URL
          // feeds the manual "open sign-in page" fallback for the rare case where
          // the CLI's own open fails.
        } catch (error) {
          if (attemptRef.current !== attempt) return;
          setErrorMessage(error instanceof Error ? error.message : String(error));
          setPhase("failed");
        }
      })();
    },
    [startLogin, cancelLogin, t],
  );

  const handleChooseDevice = useCallback(() => beginLogin("device-auth"), [beginLogin]);
  const handleChooseBrowser = useCallback(() => beginLogin("oauth"), [beginLogin]);

  // React to the daemon's broadcast login lifecycle. Gate on our own loginId so a
  // stale completed/failed state from a previous login never leaks through.
  useEffect(() => {
    if (!visible || phase !== "waiting") return;
    if (loginId === null || login.loginId !== loginId) return;
    if (login.state === "completed") {
      setPhase("completed");
    } else if (login.state === "failed") {
      setErrorMessage(login.error);
      setPhase("failed");
    }
  }, [visible, phase, loginId, login.state, login.loginId, login.error]);

  const completedAccount = useMemo(() => {
    if (login.state !== "completed" || !login.accountId) return null;
    return accounts.find((account) => account.id === login.accountId) ?? null;
  }, [login.state, login.accountId, accounts]);

  const handleCancel = useCallback(() => {
    if (pending) return;
    attemptRef.current += 1;
    if (phase === "waiting" && loginId) {
      void cancelLogin(loginId).catch(() => {
        // Cancellation is best-effort; the daemon also times the login out.
      });
    }
    onClose();
  }, [pending, phase, loginId, cancelLogin, onClose]);

  const handleOpenSignIn = useCallback(() => {
    if (authUrl) {
      void openExternalUrl(authUrl);
    }
  }, [authUrl]);

  const flashCopied = useCallback((target: "link" | "code") => {
    setCopied(target);
    if (copiedTimerRef.current) {
      clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = setTimeout(() => {
      setCopied(null);
      copiedTimerRef.current = null;
    }, COPIED_RESET_MS);
  }, []);

  const handleCopyLink = useCallback(() => {
    if (!authUrl) return;
    void copyToClipboard(authUrl)
      .then(() => flashCopied("link"))
      .catch(() => {
        // Clipboard is best-effort; the URL is still selectable on screen.
      });
  }, [authUrl, flashCopied]);

  const handleCopyCode = useCallback(() => {
    if (!userCode) return;
    void copyToClipboard(userCode)
      .then(() => flashCopied("code"))
      .catch(() => {
        // Clipboard is best-effort; the code is still selectable on screen.
      });
  }, [userCode, flashCopied]);

  const handleMakeActive = useCallback(() => {
    if (pending || !login.accountId) return;
    const accountId = login.accountId;
    setPending(true);
    void onMakeActive(accountId)
      .then(() => {
        setPending(false);
        onClose();
        return;
      })
      .catch(() => {
        setPending(false);
      });
  }, [pending, login.accountId, onMakeActive, onClose]);

  const failureDetail = useMemo(() => {
    if (login.failureReason === "timed_out") {
      return t("grokAccounts.login.timeout");
    }
    if (errorMessage && CLI_MISSING_PATTERN.test(errorMessage)) {
      return t("grokAccounts.cliMissing");
    }
    return errorMessage;
  }, [login.failureReason, errorMessage, t]);

  const sheetHeader = useMemo<SheetHeader>(() => ({ title: t("grokAccounts.addAccount") }), [t]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={handleCancel}
      header={sheetHeader}
      testID="grok-add-account-sheet"
    >
      <View style={styles.body}>
        {phase === "choose" ? (
          <>
            <Text style={styles.chooseTitle}>{t("grokAccounts.login.chooseTitle")}</Text>
            <View style={styles.methodList}>
              <MethodOption
                title={t("grokAccounts.login.methodDevice")}
                hint={t("grokAccounts.login.methodDeviceHint")}
                onPress={handleChooseDevice}
                testID="grok-add-account-method-device"
              />
              <MethodOption
                title={t("grokAccounts.login.methodBrowser")}
                hint={t("grokAccounts.login.methodBrowserHint")}
                onPress={handleChooseBrowser}
                testID="grok-add-account-method-browser"
              />
            </View>
          </>
        ) : null}

        {phase === "waiting" ? (
          <WaitingPhase
            mode={mode}
            authUrl={authUrl}
            userCode={userCode}
            copied={copied}
            onCopyLink={handleCopyLink}
            onCopyCode={handleCopyCode}
            onOpenSignIn={handleOpenSignIn}
            onCancel={handleCancel}
          />
        ) : null}

        {phase === "completed" ? (
          <>
            <Text style={styles.completedText}>
              {t("grokAccounts.login.completed", {
                email: completedAccount?.email ?? completedAccount?.name ?? "",
              })}
            </Text>
            <View style={styles.actions}>
              <Button
                variant="secondary"
                size="sm"
                style={styles.actionButton}
                onPress={onClose}
                disabled={pending}
                testID="grok-add-account-done"
              >
                {t("grokAccounts.login.done")}
              </Button>
              <Button
                variant="default"
                size="sm"
                style={styles.actionButton}
                onPress={handleMakeActive}
                disabled={pending || !login.accountId}
                loading={pending}
                testID="grok-add-account-make-active"
              >
                {t("grokAccounts.login.makeActive")}
              </Button>
            </View>
          </>
        ) : null}

        {phase === "failed" ? (
          <>
            <Text style={styles.failedText}>{t("grokAccounts.login.failed")}</Text>
            {failureDetail ? <Text style={styles.detailText}>{failureDetail}</Text> : null}
            <View style={styles.actions}>
              <Button
                variant="secondary"
                size="sm"
                style={styles.actionButton}
                onPress={onClose}
                testID="grok-add-account-close"
              >
                {t("grokAccounts.login.done")}
              </Button>
              <Button
                variant="default"
                size="sm"
                style={styles.actionButton}
                onPress={resetToChoose}
                testID="grok-add-account-retry"
              >
                {t("grokAccounts.login.tryAgain")}
              </Button>
            </View>
          </>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

// The in-flight login UI, split out so the sheet's own render stays simple. Two
// variants: device-auth shows the copyable URL + prominent code; oauth shows a
// spinner (the CLI opens the browser itself) with a manual open fallback.
function WaitingPhase({
  mode,
  authUrl,
  userCode,
  copied,
  onCopyLink,
  onCopyCode,
  onOpenSignIn,
  onCancel,
}: {
  mode: LoginMode | null;
  authUrl: string | null;
  userCode: string | null;
  copied: "link" | "code" | null;
  onCopyLink: () => void;
  onCopyCode: () => void;
  onOpenSignIn: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const cancelButton = (
    <View style={styles.actions}>
      <Button
        variant="secondary"
        size="sm"
        style={styles.actionButton}
        onPress={onCancel}
        testID="grok-add-account-cancel"
      >
        {t("grokAccounts.login.cancel")}
      </Button>
    </View>
  );

  if (mode === "device-auth") {
    return (
      <>
        <Text style={styles.instructionsText}>{t("grokAccounts.login.deviceInstructions")}</Text>
        {authUrl ? (
          <>
            <Text selectable style={styles.urlText}>
              {authUrl}
            </Text>
            <Button
              variant="outline"
              size="sm"
              style={styles.actionButton}
              onPress={onCopyLink}
              testID="grok-add-account-copy-link"
            >
              {copied === "link"
                ? t("grokAccounts.login.copied")
                : t("grokAccounts.login.copyLink")}
            </Button>
          </>
        ) : null}
        {userCode ? (
          <>
            <View style={styles.codeBlock}>
              <Text style={styles.codeLabel}>{t("grokAccounts.login.codeLabel")}</Text>
              <Text selectable style={styles.codeValue}>
                {userCode}
              </Text>
            </View>
            <Button
              variant="outline"
              size="sm"
              style={styles.actionButton}
              onPress={onCopyCode}
              testID="grok-add-account-copy-code"
            >
              {copied === "code"
                ? t("grokAccounts.login.copied")
                : t("grokAccounts.login.copyCode")}
            </Button>
          </>
        ) : null}
        {!authUrl && !userCode ? (
          <View style={styles.spinnerRow}>
            <ActivityIndicator />
            <Text style={styles.waitingText}>{t("common.states.starting")}</Text>
          </View>
        ) : null}
        {cancelButton}
      </>
    );
  }

  return (
    <>
      <View style={styles.spinnerRow}>
        <ActivityIndicator />
        <Text style={styles.waitingText}>{t("grokAccounts.login.waitingBrowser")}</Text>
      </View>
      {authUrl ? (
        <View style={styles.actions}>
          <Button
            variant="outline"
            size="sm"
            style={styles.actionButton}
            onPress={onOpenSignIn}
            testID="grok-add-account-open-sign-in"
          >
            {t("grokAccounts.login.openSignIn")}
          </Button>
        </View>
      ) : null}
      {cancelButton}
    </>
  );
}

// One tappable sign-in method: a bold title over a muted one-line hint. Kept a
// plain Pressable (not <Button>) because Button renders its label inside a
// single <Text>, which can't hold the stacked title + hint on native.
function MethodOption({
  title,
  hint,
  onPress,
  testID,
}: {
  title: string;
  hint: string;
  onPress: () => void;
  testID?: string;
}) {
  const optionStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.methodOption,
      pressed ? styles.methodOptionPressed : null,
    ],
    [],
  );
  return (
    <Pressable onPress={onPress} style={optionStyle} accessibilityRole="button" testID={testID}>
      <Text style={styles.methodTitle}>{title}</Text>
      <Text style={styles.methodHint}>{hint}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  chooseTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  methodList: {
    gap: theme.spacing[2],
  },
  methodOption: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  methodOptionPressed: {
    backgroundColor: theme.colors.surface2,
  },
  methodTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  methodHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  instructionsText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  urlText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  codeBlock: {
    gap: theme.spacing[1],
    alignItems: "center",
    paddingVertical: theme.spacing[2],
  },
  codeLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  codeValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontFamily: theme.fontFamily.mono,
    letterSpacing: 2,
  },
  spinnerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  waitingText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  completedText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  failedText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  detailText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  actionButton: {
    flex: 1,
  },
}));
