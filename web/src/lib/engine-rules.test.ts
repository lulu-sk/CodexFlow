import { describe, expect, it } from "vitest";
import {
  getCodexConfigTomlPath,
  getGlobalRuleFilePath,
  getProjectRuleFilePath,
  getProviderRuleFileName,
  joinNativePath,
  normalizeEngineRootPath,
  normalizeEngineRootPaths,
} from "./engine-rules";

describe("engine-rules（引擎规则路径工具）", () => {
  it("Codex/Gemini 会把记录路径回退到真实引擎根目录", () => {
    expect(normalizeEngineRootPath("codex", "C:\\Users\\dev\\.codex\\sessions")).toBe("C:\\Users\\dev\\.codex");
    expect(normalizeEngineRootPath("gemini", "/home/dev/.gemini/tmp")).toBe("/home/dev/.gemini");
  });

  it("Claude 根路径保持不变", () => {
    expect(normalizeEngineRootPath("claude", "C:\\Users\\dev\\.claude")).toBe("C:\\Users\\dev\\.claude");
  });

  it("批量根路径会在归一化后去重", () => {
    const list = normalizeEngineRootPaths("codex", [
      "C:\\Users\\dev\\.codex\\sessions",
      "C:/Users/dev/.codex/sessions",
      "C:\\Users\\dev\\.codex",
    ]);
    expect(list).toEqual(["C:\\Users\\dev\\.codex"]);
  });

  it("规则与配置文件路径拼接正确", () => {
    expect(getGlobalRuleFilePath("codex", "C:\\Users\\dev\\.codex")).toBe("C:\\Users\\dev\\.codex\\AGENTS.md");
    expect(getGlobalRuleFilePath("claude", "/home/dev/.claude")).toBe("/home/dev/.claude/CLAUDE.md");
    expect(getProjectRuleFilePath("gemini", "/repo/demo")).toBe("/repo/demo/GEMINI.md");
    expect(getCodexConfigTomlPath("C:\\Users\\dev\\.codex")).toBe("C:\\Users\\dev\\.codex\\config.toml");
  });

  it("工具函数支持路径分隔符风格自动对齐", () => {
    expect(joinNativePath("C:\\Users\\dev", "AGENTS.md")).toBe("C:\\Users\\dev\\AGENTS.md");
    expect(joinNativePath("/home/dev/.claude", "CLAUDE.md")).toBe("/home/dev/.claude/CLAUDE.md");
    expect(getProviderRuleFileName("codex")).toBe("AGENTS.md");
  });
});
