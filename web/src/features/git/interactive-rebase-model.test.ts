import { describe, expect, it } from "vitest";
import type { GitInteractiveRebasePlan } from "./types";
import {
  buildInteractiveRebaseRunPayload,
  cloneInteractiveRebaseEntries,
  getInteractiveRebaseActionAvailability,
  hasInteractiveRebaseDraftChanges,
  moveInteractiveRebaseEntry,
  moveInteractiveRebaseEntryToEdge,
  restoreInteractiveRebaseSelection,
  resolveInteractiveRebaseSuggestedMessage,
  summarizeInteractiveRebaseEntries,
  updateInteractiveRebaseEntryAction,
  updateInteractiveRebaseEntryMessage,
  validateInteractiveRebasePlanEntries,
} from "./interactive-rebase-model";

const PLAN_FIXTURE: GitInteractiveRebasePlan = {
  targetHash: "1111111",
  headHash: "3333333",
  baseHash: "0000000",
  rootMode: false,
  entries: [
    {
      hash: "1111111",
      shortHash: "1111111",
      subject: "first",
      authorName: "CodexFlow",
      authorDate: "2026-03-11T10:00:00.000Z",
      fullMessage: "first",
      action: "pick",
      originalIndex: 0,
    },
    {
      hash: "2222222",
      shortHash: "2222222",
      subject: "second",
      authorName: "CodexFlow",
      authorDate: "2026-03-11T10:01:00.000Z",
      fullMessage: "second body",
      action: "pick",
      originalIndex: 1,
      autosquashCandidate: true,
    },
    {
      hash: "3333333",
      shortHash: "3333333",
      subject: "third",
      authorName: "CodexFlow",
      authorDate: "2026-03-11T10:02:00.000Z",
      fullMessage: "third body",
      action: "pick",
      originalIndex: 2,
    },
  ],
};

describe("interactive-rebase-model", () => {
  it("应支持更新动作、移动顺序并生成运行 payload", () => {
    let entries = cloneInteractiveRebaseEntries(PLAN_FIXTURE.entries);
    entries = updateInteractiveRebaseEntryAction(entries, "2222222", "reword");
    entries = updateInteractiveRebaseEntryMessage(entries, "2222222", "second rewritten");
    entries = moveInteractiveRebaseEntry(entries, "3333333", -1);
    entries = moveInteractiveRebaseEntryToEdge(entries, "2222222", "top");

    expect(entries.map((entry) => entry.hash)).toEqual(["2222222", "1111111", "3333333"]);
    expect(validateInteractiveRebasePlanEntries(entries)).toBe("");
    expect(summarizeInteractiveRebaseEntries(entries)).toEqual({
      keepCount: 3,
      rewriteCount: 1,
      dropCount: 0,
      autosquashCount: 1,
    });

    const payload = buildInteractiveRebaseRunPayload(PLAN_FIXTURE, entries);
    expect(payload).toEqual({
      targetHash: "1111111",
      headHash: "3333333",
      entries: [
        { hash: "2222222", action: "reword", message: "second rewritten" },
        { hash: "1111111", action: "pick", message: undefined },
        { hash: "3333333", action: "pick", message: undefined },
      ],
    });
  });

  it("应在 squash 前没有可合并目标时给出校验错误，并生成建议消息", () => {
    let entries = cloneInteractiveRebaseEntries(PLAN_FIXTURE.entries);
    entries = updateInteractiveRebaseEntryAction(entries, "1111111", "drop");
    entries = updateInteractiveRebaseEntryAction(entries, "2222222", "squash");

    expect(validateInteractiveRebasePlanEntries(entries)).toContain("缺少可合并的目标提交");

    entries = cloneInteractiveRebaseEntries(PLAN_FIXTURE.entries);
    entries = updateInteractiveRebaseEntryAction(entries, "2222222", "squash");
    entries = updateInteractiveRebaseEntryMessage(entries, "2222222", "custom second");
    expect(resolveInteractiveRebaseSuggestedMessage(entries, "2222222")).toContain("first");
  });

  it("应按前序可附着目标计算动作可用性，并支持恢复选区与脏草稿检测", () => {
    let entries = cloneInteractiveRebaseEntries(PLAN_FIXTURE.entries);
    entries = updateInteractiveRebaseEntryAction(entries, "1111111", "drop");

    const availability = getInteractiveRebaseActionAvailability(entries, "2222222");
    expect(availability.fixup.enabled).toBe(false);
    expect(availability.squash.enabled).toBe(false);
    expect(availability.fixup.reason).toContain("前方缺少可附着的目标提交");

    const moved = moveInteractiveRebaseEntry(entries, "3333333", -1);
    expect(restoreInteractiveRebaseSelection(moved, "3333333", "1111111")).toBe("3333333");
    expect(restoreInteractiveRebaseSelection([], "3333333", "1111111")).toBe("");

    expect(hasInteractiveRebaseDraftChanges(PLAN_FIXTURE.entries, moved)).toBe(true);
    expect(hasInteractiveRebaseDraftChanges(PLAN_FIXTURE.entries, cloneInteractiveRebaseEntries(PLAN_FIXTURE.entries))).toBe(false);
  });
});
