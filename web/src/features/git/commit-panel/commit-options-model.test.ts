import { describe, expect, it } from "vitest";
import {
  buildCommitAdvancedOptionsSummary,
  createCommitAdvancedOptionsState,
  hasCommitAdvancedOptions,
  isCommitAuthorDateInputValid,
  normalizeCommitAuthorDateInput,
  normalizeCommitAdvancedOptionsPayload,
  patchCommitAdvancedOptionsState,
  resolveCommitHooksAvailability,
} from "./commit-options-model";

describe("commit advanced options model", () => {
  it("应返回稳定的默认状态", () => {
    expect(createCommitAdvancedOptionsState()).toEqual({
      signOff: false,
      runHooks: true,
      author: "",
      authorDate: "",
      cleanupMessage: false,
      commitRenamesSeparately: false,
    });
  });

  it("应按字段增量更新高级选项，并保留未修改字段", () => {
    const nextState = patchCommitAdvancedOptionsState(createCommitAdvancedOptionsState(), {
      signOff: true,
      author: "Alice <alice@example.com>",
    });

    expect(nextState).toEqual({
      signOff: true,
      runHooks: true,
      author: "Alice <alice@example.com>",
      authorDate: "",
      cleanupMessage: false,
      commitRenamesSeparately: false,
    });
  });

  it("补丁不改变任何字段时应复用旧对象，避免 amend 回填形成无意义重渲染", () => {
    const previousState = createCommitAdvancedOptionsState();
    const nextState = patchCommitAdvancedOptionsState(previousState, {
      signOff: false,
      author: "",
    });
    expect(nextState).toBe(previousState);
  });

  it("应归一化 payload，仅保留有效字段并生成摘要", () => {
    const state = {
      signOff: true,
      runHooks: false,
      author: "  Alice <alice@example.com>  ",
      authorDate: "2026-03-12T10:11:12",
      cleanupMessage: true,
      commitRenamesSeparately: true,
    };
    const hooksAvailability = { available: true, disabledByPolicy: false };
    const payload = normalizeCommitAdvancedOptionsPayload(state, hooksAvailability);

    expect(payload).toEqual({
      signOff: true,
      skipHooks: true,
      author: "Alice <alice@example.com>",
      authorDate: "2026-03-12T10:11:12",
      cleanupMessage: true,
      commitRenamesSeparately: true,
    });
    expect(hasCommitAdvancedOptions(state, hooksAvailability)).toBe(true);
    expect(buildCommitAdvancedOptionsSummary(state, hooksAvailability)).toEqual([
      "Sign-off",
      "不运行 Hooks",
      "作者：Alice <alice@example.com>",
      "作者时间",
      "清理消息",
      "重命名单独提交",
    ]);
  });

  it("应支持常见作者时间文本格式并归一化为稳定值", () => {
    expect(normalizeCommitAuthorDateInput("2026-03-12 21:11")).toBe("2026-03-12T21:11:00");
    expect(normalizeCommitAuthorDateInput("2026-03-12 21:11:09")).toBe("2026-03-12T21:11:09");
    expect(normalizeCommitAuthorDateInput("2026-03-12")).toBe("2026-03-12T00:00:00");
    expect(isCommitAuthorDateInputValid("2026-03-12 21:11:09")).toBe(true);
    expect(isCommitAuthorDateInputValid("2026-02-31 21:11:09")).toBe(false);
  });

  it("未启用或无效字段不应进入 payload", () => {
    expect(normalizeCommitAdvancedOptionsPayload({
      author: "   ",
      authorDate: "invalid-date",
    })).toEqual({});
    expect(hasCommitAdvancedOptions({
      author: "   ",
      authorDate: "invalid-date",
    })).toBe(false);
  });

  it("hooks 被全局禁用时应强制落成 skipHooks，即使当前状态未显式关闭 runHooks", () => {
    expect(normalizeCommitAdvancedOptionsPayload({
      runHooks: true,
    }, {
      available: true,
      disabledByPolicy: true,
    })).toEqual({
      skipHooks: true,
    });
    expect(buildCommitAdvancedOptionsSummary({
      runHooks: true,
    }, {
      available: true,
      disabledByPolicy: true,
    })).toEqual(["Hooks 已全局禁用"]);
  });

  it("缺失的 hooks 可用性快照应回退为稳定默认值", () => {
    expect(resolveCommitHooksAvailability()).toEqual({
      available: false,
      disabledByPolicy: false,
      runByDefault: true,
    });
    expect(resolveCommitHooksAvailability({
      available: true,
      runByDefault: false,
    })).toEqual({
      available: true,
      disabledByPolicy: false,
      runByDefault: false,
    });
  });
});
