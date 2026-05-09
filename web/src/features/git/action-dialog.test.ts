import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { resolveActionDialogText } from "./action-dialog";
import { buildCommitDetailsPatchDialogConfig, buildDeleteCommitDialogConfig, buildResetCurrentBranchDialogConfig } from "./action-dialog-presets";

/**
 * 构造最小翻译函数桩，直接按 key 返回预设文案，便于验证延迟翻译行为。
 */
function createTranslator(map: Record<string, string>): TFunction {
  return ((key: string, options?: Record<string, unknown> & { defaultValue?: string }) => {
    let text = map[key] || options?.defaultValue || "";
    for (const [name, value] of Object.entries(options || {})) {
      if (name === "defaultValue" || name === "ns") continue;
      text = text.split(`{{${name}}}`).join(String(value ?? ""));
      text = text.split(`{${name}}`).join(String(value ?? ""));
    }
    return text;
  }) as unknown as TFunction;
}

describe("action-dialog presets", () => {
  it("reset 对话框应使用卡片模式表达 mixed / soft / hard，并默认选中 mixed", () => {
    const config = buildResetCurrentBranchDialogConfig();
    expect(config.width).toBe("wide");
    expect(config.defaults).toEqual({ mode: "mixed" });
    expect(config.fields).toHaveLength(1);
    expect(config.fields[0]?.presentation).toBe("cards");
    expect(config.fields[0]?.columns).toBe(3);
    expect(config.fields[0]?.options?.map((option) => option.value)).toEqual(["mixed", "soft", "hard"]);
  });

  it("同一份本地化 text spec 应在不同 translator 下解析为不同语言", () => {
    const config = buildResetCurrentBranchDialogConfig();
    const hardLabel = config.fields[0]?.options?.find((option) => option.value === "hard")?.label;
    const zhTranslator = createTranslator({
      "actionDialogs.reset.options.hard.label": "硬重置（Hard）",
    });
    const enTranslator = createTranslator({
      "actionDialogs.reset.options.hard.label": "Hard",
    });

    expect(resolveActionDialogText(hardLabel, zhTranslator)).toBe("硬重置（Hard）");
    expect(resolveActionDialogText(hardLabel, enTranslator)).toBe("Hard");
  });

  it("优选所选更改在 changelist 模式下应要求选择目标更改列表，并默认选中活动列表", () => {
    const config = buildCommitDetailsPatchDialogConfig("apply", {
      changeLists: [
        { id: "default", name: "默认" },
        { id: "feature", name: "功能A" },
      ],
      activeChangeListId: "feature",
    });

    expect(config.fields).toHaveLength(1);
    expect(config.fields[0]?.key).toBe("targetChangeListId");
    expect(config.fields[0]?.type).toBe("select");
    expect(config.fields[0]?.options?.map((option) => option.value)).toEqual(["default", "feature"]);
    expect(config.defaults).toEqual({ targetChangeListId: "feature" });
  });

  it("删除提交确认弹窗应默认显示不再询问复选框，并带入分支与提交数量", () => {
    const config = buildDeleteCommitDialogConfig({
      commitCount: 2,
      branchName: "feature/test",
    });
    const zhTranslator = createTranslator({
      "actionDialogs.deleteCommit.description": "是否要从“{branch}”分支删除 {count} 个提交？",
      "actionDialogs.deleteCommit.dontAskAgain": "不再询问",
    });

    expect(config.tone).toBe("danger");
    expect(resolveActionDialogText(config.description, zhTranslator)).toBe("是否要从“feature/test”分支删除 2 个提交？");
    expect(config.fields).toHaveLength(1);
    expect(config.fields[0]?.key).toBe("dontAskAgain");
    expect(config.fields[0]?.type).toBe("checkbox");
    expect(resolveActionDialogText(config.fields[0]?.label, zhTranslator)).toBe("不再询问");
    expect(config.defaults).toEqual({ dontAskAgain: "false" });
  });
});
