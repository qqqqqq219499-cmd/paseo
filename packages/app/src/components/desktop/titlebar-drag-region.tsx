import type { CSSProperties } from "react";
import type { ViewStyle } from "react-native";
import { getIsElectronRuntime } from "@/constants/layout";
import { isNative } from "@/constants/platform";

/**
 * VS Code-style titlebar drag region for Electron.
 *
 * Copied from VS Code at commit daa0a70:
 *   - titlebarPart.ts:463-464  → prepend(container, $('div.titlebar-drag-region'))
 *   - titlebarpart.css:57-64   → position: absolute, full size, -webkit-app-region: drag
 *   - titlebarpart.css:249-260 → top-edge resizer, no-drag, 4px
 *
 * The absolute overlay alone is NOT enough under React Native Web: layout Views
 * paint on top with pointerEvents:auto and steal hits, so empty chrome never
 * reaches the overlay. Prefer also marking chrome containers with
 * `electronDragStyle` and interactive panels with `electronNoDragStyle`.
 * Buttons/inputs still get no-drag from public/index.html.
 *
 * The resizer is Windows/Linux only (titlebarpart.css:249 scopes to .windows/.linux).
 * On macOS, Electron handles edge resize natively.
 */

const isElectronDesktop = !isNative && getIsElectronRuntime();

/** Apply to chrome shells (sidebar, header strip, shell underlay). */
export const electronDragStyle: ViewStyle | undefined = isElectronDesktop
  ? ({ WebkitAppRegion: "drag" } as ViewStyle)
  : undefined;

/** Apply to interactive panels that sit on a drag shell (message card, forms). */
export const electronNoDragStyle: ViewStyle | undefined = isElectronDesktop
  ? ({ WebkitAppRegion: "no-drag" } as ViewStyle)
  : undefined;

const DRAG_OVERLAY_STYLE: CSSProperties = {
  top: 0,
  left: 0,
  display: "block",
  position: "absolute",
  width: "100%",
  height: "100%",
  // @ts-expect-error — WebkitAppRegion is not in CSSProperties
  WebkitAppRegion: "drag",
  // Sit under layout siblings; container-level electronDragStyle is the real fix.
  zIndex: 0,
};

const TOP_RESIZER_STYLE: CSSProperties = {
  position: "absolute",
  top: 0,
  width: "100%",
  height: 4,
  // @ts-expect-error — WebkitAppRegion is not in CSSProperties
  WebkitAppRegion: "no-drag",
  zIndex: 1,
};

/**
 * Static drag overlay and top-edge resizer. Returns null on non-Electron.
 * Place as FIRST child of any positioned container that should be draggable.
 * Also mark that container with `electronDragStyle` so empty layout Views still drag.
 */
export function TitlebarDragRegion() {
  if (!isElectronDesktop) {
    return null;
  }

  return (
    <>
      {/* Drag overlay — VS Code .titlebar-drag-region (titlebarpart.css:57-64) */}
      <div style={DRAG_OVERLAY_STYLE} />
      {/* Top-edge resizer — VS Code .resizer (titlebarpart.css:249-256) */}
      <div style={TOP_RESIZER_STYLE} />
    </>
  );
}
