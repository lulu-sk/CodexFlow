import { describe, expect, it } from "vitest";
import {
  BUILT_IN_YOLO_PROVIDER_IDS,
  enableBuiltInYoloPresetItems,
  enableYoloPresetForProvider,
  isAnyBuiltInYoloPresetEnabled,
  isAnyOtherBuiltInYoloPresetEnabled,
  isYoloPresetEnabled,
  shouldPromptAntigravityYoloInheritance,
} from "./yolo";

describe("providers/yolo（YOLO 预设工具）", () => {
  it("批量启用时只修改内置代理引擎的启动命令", () => {
    const items = enableBuiltInYoloPresetItems([
      { id: "codex", startupCmd: "codex" },
      { id: "claude", startupCmd: "claude --foo" },
      { id: "gemini", startupCmd: "gemini" },
      { id: "antigravity", startupCmd: "agy" },
      { id: "custom-a", startupCmd: "custom-a --run" },
    ]);

    expect(items.find((it) => it.id === "codex")?.startupCmd).toBe("codex --yolo");
    expect(items.find((it) => it.id === "claude")?.startupCmd).toBe("claude --dangerously-skip-permissions");
    expect(items.find((it) => it.id === "gemini")?.startupCmd).toBe("gemini --yolo");
    expect(items.find((it) => it.id === "antigravity")?.startupCmd).toBe("agy --dangerously-skip-permissions");
    expect(items.find((it) => it.id === "custom-a")?.startupCmd).toBe("custom-a --run");
  });

  it("可识别是否已存在任意一个内置 YOLO 预设", () => {
    expect(isAnyBuiltInYoloPresetEnabled([
      { id: "codex", startupCmd: "codex --yolo" },
      { id: "claude", startupCmd: "claude" },
      { id: "gemini", startupCmd: "gemini" },
    ])).toBe(true);

    expect(isAnyBuiltInYoloPresetEnabled([
      { id: "codex", startupCmd: "codex" },
      { id: "claude", startupCmd: "claude" },
      { id: "gemini", startupCmd: "gemini" },
      { id: "antigravity", startupCmd: "agy" },
    ])).toBe(false);
  });

  it("可排除指定引擎后判断其它内置引擎是否已启用 YOLO", () => {
    expect(isAnyOtherBuiltInYoloPresetEnabled([
      { id: "codex", startupCmd: "codex --yolo" },
      { id: "antigravity", startupCmd: "agy" },
    ], "antigravity")).toBe(true);

    expect(isAnyOtherBuiltInYoloPresetEnabled([
      { id: "codex", startupCmd: "codex" },
      { id: "antigravity", startupCmd: "agy --dangerously-skip-permissions" },
    ], "antigravity")).toBe(false);
  });

  it("只有其它内置引擎已启用且 Antigravity 未启用时才需要继承确认", () => {
    expect(shouldPromptAntigravityYoloInheritance([
      { id: "codex", startupCmd: "codex --yolo" },
      { id: "antigravity", startupCmd: "agy" },
    ])).toBe(true);

    expect(shouldPromptAntigravityYoloInheritance([
      { id: "codex", startupCmd: "codex --yolo" },
      { id: "antigravity", startupCmd: "agy --dangerously-skip-permissions" },
    ])).toBe(false);

    expect(shouldPromptAntigravityYoloInheritance([
      { id: "codex", startupCmd: "codex" },
      { id: "antigravity", startupCmd: "agy" },
    ])).toBe(false);
  });

  it("可只为单个内置引擎启用 YOLO 预设", () => {
    const items = enableYoloPresetForProvider([
      { id: "codex", startupCmd: "codex --yolo" },
      { id: "antigravity", startupCmd: "agy" },
      { id: "custom-a", startupCmd: "custom-a --run" },
    ], "antigravity");

    expect(items.find((it) => it.id === "codex")?.startupCmd).toBe("codex --yolo");
    expect(items.find((it) => it.id === "antigravity")?.startupCmd).toBe("agy --dangerously-skip-permissions");
    expect(items.find((it) => it.id === "custom-a")?.startupCmd).toBe("custom-a --run");
  });

  it("单引擎启用会在缺少该内置引擎时补齐条目", () => {
    const items = enableYoloPresetForProvider([{ id: "codex", startupCmd: "codex" }], "antigravity");

    expect(items.find((it) => it.id === "antigravity")?.startupCmd).toBe("agy --dangerously-skip-permissions");
  });

  it("预设识别严格按内置引擎范围生效", () => {
    for (const providerId of BUILT_IN_YOLO_PROVIDER_IDS) {
      const preset = providerId === "claude"
        ? "claude --dangerously-skip-permissions"
        : providerId === "antigravity"
          ? "agy --dangerously-skip-permissions"
          : `${providerId} --yolo`;
      expect(isYoloPresetEnabled(providerId, preset)).toBe(true);
    }
    expect(isYoloPresetEnabled("custom", "custom --yolo")).toBe(false);
  });
});
