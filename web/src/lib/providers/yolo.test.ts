import { describe, expect, it } from "vitest";
import {
  BUILT_IN_YOLO_PROVIDER_IDS,
  enableBuiltInYoloPresetItems,
  isAnyBuiltInYoloPresetEnabled,
  isYoloPresetEnabled,
} from "./yolo";

describe("providers/yolo（YOLO 预设工具）", () => {
  it("批量启用时只修改内置三引擎的启动命令", () => {
    const items = enableBuiltInYoloPresetItems([
      { id: "codex", startupCmd: "codex" },
      { id: "claude", startupCmd: "claude --foo" },
      { id: "gemini", startupCmd: "gemini" },
      { id: "custom-a", startupCmd: "custom-a --run" },
    ]);

    expect(items.find((it) => it.id === "codex")?.startupCmd).toBe("codex --yolo");
    expect(items.find((it) => it.id === "claude")?.startupCmd).toBe("claude --dangerously-skip-permissions");
    expect(items.find((it) => it.id === "gemini")?.startupCmd).toBe("gemini --yolo");
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
    ])).toBe(false);
  });

  it("预设识别严格按内置引擎范围生效", () => {
    for (const providerId of BUILT_IN_YOLO_PROVIDER_IDS) {
      expect(isYoloPresetEnabled(providerId, providerId === "claude" ? "claude --dangerously-skip-permissions" : `${providerId} --yolo`)).toBe(true);
    }
    expect(isYoloPresetEnabled("custom", "custom --yolo")).toBe(false);
  });
});
