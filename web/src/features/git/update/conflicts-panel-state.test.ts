import { describe, expect, it } from "vitest";
import type { GitStatusEntry } from "../types";
import {
  buildConflictsPanelSnapshot,
  clearDismissedConflictsPanelSignature,
  createDefaultConflictsPanelPreferences,
  dismissConflictsPanelForSnapshot,
  revealConflictsPanel,
  setConflictsPanelGateEnabled,
  shouldShowConflictsPanel,
} from "./conflicts-panel-state";

function createEntry(path: string, conflictState: "conflict" | "resolved"): GitStatusEntry {
  return {
    path,
    x: "U",
    y: "U",
    staged: conflictState === "resolved",
    unstaged: conflictState !== "resolved",
    untracked: false,
    ignored: false,
    renamed: false,
    deleted: false,
    statusText: conflictState === "resolved" ? "已解决冲突" : "冲突",
    changeListId: "default",
    conflictState,
    repositoryRoot: "/repo",
  };
}

describe("conflicts panel state helpers", () => {
  it("gate 开启且存在冲突时，应自动显示冲突面板", () => {
    const preferences = createDefaultConflictsPanelPreferences();
    const snapshot = buildConflictsPanelSnapshot([createEntry("src/conflict.ts", "conflict")]);
    expect(shouldShowConflictsPanel({ preferences, snapshot })).toBe(true);
  });

  it("关闭当前 signature 后，相同冲突集不再自动显示", () => {
    const snapshot = buildConflictsPanelSnapshot([createEntry("src/conflict.ts", "conflict")]);
    const preferences = dismissConflictsPanelForSnapshot(createDefaultConflictsPanelPreferences(), snapshot);
    expect(shouldShowConflictsPanel({ preferences, snapshot })).toBe(false);
  });

  it("冲突集变化后，应清理旧关闭记忆并重新显示", () => {
    const firstSnapshot = buildConflictsPanelSnapshot([createEntry("src/a.ts", "conflict")]);
    const dismissed = dismissConflictsPanelForSnapshot(createDefaultConflictsPanelPreferences(), firstSnapshot);
    const nextSnapshot = buildConflictsPanelSnapshot([createEntry("src/b.ts", "conflict")]);
    const cleared = clearDismissedConflictsPanelSignature(dismissed, nextSnapshot);
    expect(shouldShowConflictsPanel({ preferences: cleared, snapshot: nextSnapshot })).toBe(true);
  });

  it("冲突全部解决后，应清理旧的关闭记忆，避免后续新冲突被历史 signature 阻断", () => {
    const dismissed = dismissConflictsPanelForSnapshot(
      createDefaultConflictsPanelPreferences(),
      buildConflictsPanelSnapshot([createEntry("src/a.ts", "conflict")]),
    );
    const cleared = clearDismissedConflictsPanelSignature(dismissed, buildConflictsPanelSnapshot([]));
    expect(cleared.dismissedSignature).toBe("");
  });

  it("关闭 gate 后不应显示，重新启用后应恢复显示", () => {
    const snapshot = buildConflictsPanelSnapshot([createEntry("src/conflict.ts", "conflict")]);
    const disabled = setConflictsPanelGateEnabled(createDefaultConflictsPanelPreferences(), false);
    expect(shouldShowConflictsPanel({ preferences: disabled, snapshot })).toBe(false);
    const revealed = revealConflictsPanel(disabled);
    expect(shouldShowConflictsPanel({ preferences: revealed, snapshot })).toBe(true);
  });
});
