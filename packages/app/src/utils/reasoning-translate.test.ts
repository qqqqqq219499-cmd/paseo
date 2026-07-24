import { describe, expect, it } from "vitest";
import {
  chunkTextForTranslation,
  needsChineseTranslation,
  parseGoogleTranslateResponse,
} from "./reasoning-translate";

describe("needsChineseTranslation", () => {
  it("false for short", () => {
    expect(needsChineseTranslation("ok")).toBe(false);
  });

  it("true for long english reasoning", () => {
    expect(
      needsChineseTranslation(
        "I need to find how reasoning content is rendered and stored in the agent stream specifically.",
      ),
    ).toBe(true);
  });

  it("false when CJK dominates latin", () => {
    expect(
      needsChineseTranslation(
        "用户想把英文思考过程自动翻译成中文这样就能看懂模型在干什么了。extra latin words here ok",
      ),
    ).toBe(false);
  });

  it("false when latin letter count under threshold", () => {
    expect(needsChineseTranslation("abcdefghijabcdefghijabc")).toBe(false); // 23 letters
  });
});

describe("chunkTextForTranslation", () => {
  it("keeps short text as one chunk", () => {
    expect(chunkTextForTranslation("hi", 10)).toEqual(["hi"]);
  });

  it("splits on paragraph boundaries when possible", () => {
    const a = "a".repeat(20);
    const b = "b".repeat(20);
    const text = `${a}\n\n${b}`;
    const chunks = chunkTextForTranslation(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("a");
    expect(chunks.join("")).toContain("b");
  });
});

describe("parseGoogleTranslateResponse", () => {
  it("joins segments", () => {
    expect(
      parseGoogleTranslateResponse([
        [
          ["你好", "hi"],
          ["。", "."],
        ],
      ]),
    ).toBe("你好。");
  });

  it("returns null for malformed payload", () => {
    expect(parseGoogleTranslateResponse(null)).toBeNull();
    expect(parseGoogleTranslateResponse({})).toBeNull();
    expect(parseGoogleTranslateResponse([])).toBeNull();
  });
});
