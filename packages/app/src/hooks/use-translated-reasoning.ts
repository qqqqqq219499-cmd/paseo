import { useEffect, useState } from "react";
import { needsChineseTranslation } from "@/utils/reasoning-translate";
import { translateReasoningToZh } from "@/utils/translate-reasoning-to-zh";

export type ReasoningTranslateStatus = "idle" | "skipped" | "loading" | "done" | "error";

export interface UseTranslatedReasoningResult {
  /** Text to show in the Thinking block. */
  displayText: string;
  /** Original English (or source) text. */
  originalText: string;
  status: ReasoningTranslateStatus;
  /** True when we have a Chinese version different from the original. */
  isTranslated: boolean;
  showingOriginal: boolean;
  setShowingOriginal: (value: boolean) => void;
}

/**
 * When enabled and the thought is ready, auto-translate Latin-script reasoning
 * to Simplified Chinese for display. Streaming (not ready) keeps the original.
 */
export function useTranslatedReasoning(
  text: string,
  options: { enabled: boolean; ready: boolean },
): UseTranslatedReasoningResult {
  const [translated, setTranslated] = useState<string | null>(null);
  const [status, setStatus] = useState<ReasoningTranslateStatus>("idle");
  const [showingOriginal, setShowingOriginal] = useState(false);

  useEffect(() => {
    setTranslated(null);
    setShowingOriginal(false);
    setStatus("idle");

    if (!options.enabled) {
      setStatus("skipped");
      return;
    }
    if (!options.ready) {
      setStatus("idle");
      return;
    }
    if (!needsChineseTranslation(text)) {
      setStatus("skipped");
      return;
    }

    const controller = new AbortController();
    setStatus("loading");
    void translateReasoningToZh(text, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) {
        return;
      }
      if (result === text) {
        setStatus("error");
        setTranslated(null);
        return;
      }
      setTranslated(result);
      setStatus("done");
    });

    return () => {
      controller.abort();
    };
  }, [text, options.enabled, options.ready]);

  const isTranslated = translated !== null && translated !== text;
  const displayText =
    isTranslated && !showingOriginal ? (translated as string) : text;

  return {
    displayText,
    originalText: text,
    status,
    isTranslated,
    showingOriginal,
    setShowingOriginal,
  };
}
