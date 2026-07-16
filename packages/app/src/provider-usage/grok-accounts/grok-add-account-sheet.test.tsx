/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  openExternalUrl: vi.fn(),
  startLogin: vi.fn(),
  cancelLogin: vi.fn(),
  login: {
    state: "idle" as "idle" | "in_progress" | "completed" | "failed",
    loginId: null as string | null,
    accountId: null as string | null,
    failureReason: undefined as "error" | "cancelled" | "timed_out" | undefined,
    error: null as string | null,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => React.createElement("span"),
  Pressable: ({
    children,
    onPress,
    testID,
  }: React.PropsWithChildren<{ onPress?: () => void; testID?: string }>) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID, onClick: onPress },
      children,
    ),
  Text: ({ children }: React.PropsWithChildren) => React.createElement("span", null, children),
  View: ({ children }: React.PropsWithChildren) => React.createElement("div", null, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    visible,
    children,
    onClose,
    testID,
  }: React.PropsWithChildren<{ visible: boolean; onClose: () => void; testID?: string }>) =>
    visible
      ? React.createElement(
          "section",
          { "data-testid": testID },
          React.createElement(
            "button",
            { type: "button", "data-testid": "sheet-close", onClick: onClose },
            "close",
          ),
          children,
        )
      : null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: React.PropsWithChildren<{ onPress?: () => void; disabled?: boolean; testID?: string }>) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID, disabled, onClick: onPress },
      children,
    ),
}));

vi.mock("@/utils/copy-to-clipboard", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: mocks.openExternalUrl,
}));

vi.mock("./use-grok-accounts", () => ({
  useGrokAccounts: () => ({
    accounts: [],
    login: mocks.login,
    startLogin: mocks.startLogin,
    cancelLogin: mocks.cancelLogin,
  }),
}));

import { GrokAddAccountSheet } from "./grok-add-account-sheet";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderSheet(visible = true, onClose = vi.fn()) {
  return render(
    <GrokAddAccountSheet
      serverId="server-1"
      visible={visible}
      onClose={onClose}
      onMakeActive={vi.fn()}
    />,
  );
}

describe("GrokAddAccountSheet", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    mocks.copyToClipboard.mockReset().mockResolvedValue(true);
    mocks.openExternalUrl.mockReset();
    mocks.startLogin.mockReset();
    mocks.cancelLogin.mockReset().mockResolvedValue(undefined);
    Object.assign(mocks.login, {
      state: "idle",
      loginId: null,
      accountId: null,
      failureReason: undefined,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("copies the device login link without opening it", async () => {
    const authUrl = "https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234";
    mocks.startLogin.mockResolvedValue({
      outcome: "started",
      loginId: "login-1",
      authUrl,
      userCode: "WXYZ-1234",
    });
    renderSheet();

    fireEvent.click(screen.getByTestId("grok-add-account-method-device"));
    fireEvent.click(await screen.findByTestId("grok-add-account-copy-link"));

    await waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith(authUrl));
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();
  });

  it("ignores a previous failed login while a new device login is starting", async () => {
    Object.assign(mocks.login, {
      state: "failed",
      loginId: "old-login",
      failureReason: "error",
      error: "old failure",
    });
    const pending = deferred<{
      outcome: "started";
      loginId: string;
      authUrl: string;
      userCode: string;
    }>();
    mocks.startLogin.mockReturnValue(pending.promise);
    renderSheet();

    fireEvent.click(screen.getByTestId("grok-add-account-method-device"));
    await waitFor(() => expect(screen.queryByTestId("grok-add-account-retry")).toBeNull());

    pending.resolve({
      outcome: "started",
      loginId: "new-login",
      authUrl: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      userCode: "ABCD-1234",
    });

    expect(await screen.findByTestId("grok-add-account-copy-link")).toBeTruthy();
  });

  it("cancels a device login whose id arrives after the sheet closes", async () => {
    const pending = deferred<{
      outcome: "started";
      loginId: string;
      authUrl: string;
      userCode: string;
    }>();
    mocks.startLogin.mockReturnValue(pending.promise);
    const onClose = vi.fn();
    const view = renderSheet(true, onClose);

    fireEvent.click(screen.getByTestId("grok-add-account-method-device"));
    fireEvent.click(screen.getByTestId("sheet-close"));
    view.rerender(
      <GrokAddAccountSheet
        serverId="server-1"
        visible={false}
        onClose={onClose}
        onMakeActive={vi.fn()}
      />,
    );

    pending.resolve({
      outcome: "started",
      loginId: "late-login",
      authUrl: "https://accounts.x.ai/oauth2/device?user_code=EFGH-5678",
      userCode: "EFGH-5678",
    });

    await waitFor(() => expect(mocks.cancelLogin).toHaveBeenCalledWith("late-login"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an actionable failure instead of an empty spinner for an existing login", async () => {
    mocks.startLogin.mockResolvedValue({
      outcome: "already_in_progress",
      loginId: "existing-login",
      authUrl: null,
      userCode: null,
    });
    renderSheet();

    fireEvent.click(screen.getByTestId("grok-add-account-method-device"));

    expect(await screen.findByTestId("grok-add-account-retry")).toBeTruthy();
    expect(screen.queryByText("common.states.starting")).toBeNull();
  });

  it("leaves browser opening to the OAuth flow unless the fallback button is clicked", async () => {
    const authUrl = "https://auth.x.ai/oauth2/authorize?state=test";
    mocks.startLogin.mockResolvedValue({
      outcome: "started",
      loginId: "oauth-login",
      authUrl,
      userCode: null,
    });
    renderSheet();

    fireEvent.click(screen.getByTestId("grok-add-account-method-browser"));

    const fallback = await screen.findByTestId("grok-add-account-open-sign-in");
    expect(mocks.startLogin).toHaveBeenCalledWith("oauth");
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();

    fireEvent.click(fallback);
    expect(mocks.openExternalUrl).toHaveBeenCalledWith(authUrl);
  });
});
