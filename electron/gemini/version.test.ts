import { describe, expect, it } from "vitest";
import {
  parseGeminiCliVersion,
  resolveGeminiExternalEditorShortcutFromVersion,
} from "./version";

describe("Gemini CLI 版本快捷键策略", () => {
  it("从版本输出中提取版本号", () => {
    expect(parseGeminiCliVersion("0.37.0")).toBe("0.37.0");
    expect(parseGeminiCliVersion("gemini-cli v0.38.0-preview.0")).toBe("0.38.0-preview.0");
  });

  it("0.38.0 起使用 Ctrl+G，旧版本使用 Ctrl+X", () => {
    expect(resolveGeminiExternalEditorShortcutFromVersion("0.37.0")).toBe("ctrlX");
    expect(resolveGeminiExternalEditorShortcutFromVersion("0.38.0-preview.0")).toBe("ctrlG");
    expect(resolveGeminiExternalEditorShortcutFromVersion("0.38.0")).toBe("ctrlG");
    expect(resolveGeminiExternalEditorShortcutFromVersion("0.44.0")).toBe("ctrlG");
    expect(resolveGeminiExternalEditorShortcutFromVersion("")).toBe("auto");
  });
});
