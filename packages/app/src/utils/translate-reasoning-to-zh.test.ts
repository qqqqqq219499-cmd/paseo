import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearReasoningTranslateCache,
  setReasoningTranslateImpl,
  translateReasoningToZh,
} from "./translate-reasoning-to-zh";
import {
  chunkTextForTranslation,
  needsChineseTranslation,
  parseGoogleTranslateResponse,
} from "./reasoning-translate";

afterEach(() => {
  clearReasoningTranslateCache();
  setReasoningTranslateImpl(null);
});

describe("needsChineseTranslation", () => {
  it("true for english reasoning", () => {
    expect(
      needsChineseTranslation(
        "I need to find how reasoning content is rendered and stored in the agent stream specifically.",
      ),
    ).toBe(true);
  });
  it("false for chinese", () => {
    expect(
      needsChineseTranslation("用户想把英文思考过程自动翻译成中文这样就能看懂模型在干什么了。"),
    ).toBe(false);
  });
});

describe("parseGoogleTranslateResponse", () => {
  it("joins segments", () => {
    expect(parseGoogleTranslateResponse([[["你好", "hi"], ["。", "."]]])).toBe("你好。");
  });
});

describe("translateReasoningToZh", () => {
  it("uses MyMemory-shaped fetch", async () => {
    const text =
      "I need to find how reasoning content is rendered and stored in the agent stream. Let me search more specifically.";
    const fetchImpl = vi.fn(async (input: string) => {
      if (String(input).includes("mymemory")) {
        return {
          ok: true,
          json: async () => ({
            responseData: { translatedText: "我需要找出推理内容如何在代理流中渲染和存储。" },
          }),
        } as Response;
      }
      throw new Error("unexpected");
    });
    const result = await translateReasoningToZh(text, { fetchImpl });
    expect(result).toContain("我需要");
  });

  it("falls back on total failure", async () => {
    const text =
      "I need to find how reasoning content is rendered and stored in the agent stream. Let me search more specifically.";
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(translateReasoningToZh(text, { fetchImpl })).resolves.toBe(text);
  });
});

describe("chunkTextForTranslation", () => {
  it("keeps short", () => {
    expect(chunkTextForTranslation("hi", 10)).toEqual(["hi"]);
  });
});
