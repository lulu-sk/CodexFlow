import { describe, expect, it } from "vitest";
import {
  buildCommitActionLabel,
  buildCommitAmendDetails,
  buildCommitAmendGroupLabel,
  createCommitAmendRestoreSnapshot,
  formatCommitAmendAuthor,
  isSameCommitHashIdentity,
  shouldApplyCommitAmendMessage,
  shouldRestoreCommitAmendAuthor,
  shouldRestoreCommitAmendMessage,
} from "./amend-model";

describe("commit amend model", () => {
  it("应把日志详情映射为 amend helper 所需的虚拟条目与作者文本", () => {
    const details = buildCommitAmendDetails({
      hash: "1234567890abcdef",
      shortHash: "12345678",
      parents: ["abcdef1234567890"],
      authorName: "Alice Example",
      authorEmail: "alice@example.com",
      authorDate: "2026-03-12T10:00:00.000Z",
      subject: "feat: amend target",
      body: "body line",
      lineStats: { additions: 3, deletions: 1 },
      branches: ["main"],
      tags: [],
      files: [
        { status: "M", path: "src/app.ts" },
        { status: "R100", path: "src/new-name.ts", oldPath: "src/old-name.ts" },
        { status: "D", path: "src/deleted.ts" },
      ],
    });

    expect(details.author).toBe("Alice Example <alice@example.com>");
    expect(details.fullMessage).toBe("feat: amend target\n\nbody line");
    expect(buildCommitAmendGroupLabel(details)).toBe("上一提交 12345678 · feat: amend target");
    expect(details.entries).toEqual([
      {
        path: "src/app.ts",
        oldPath: undefined,
        x: "M",
        y: ".",
        staged: false,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: false,
        statusText: "修改",
        changeListId: "__amend__",
      },
      {
        path: "src/new-name.ts",
        oldPath: "src/old-name.ts",
        x: "R",
        y: ".",
        staged: false,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: true,
        deleted: false,
        statusText: "重命名",
        changeListId: "__amend__",
      },
      {
        path: "src/deleted.ts",
        oldPath: undefined,
        x: "D",
        y: ".",
        staged: false,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: true,
        statusText: "删除",
        changeListId: "__amend__",
      },
    ]);
  });

  it("应按 non-modal amend 语义判定消息是否需要覆盖与恢复", () => {
    const snapshot = createCommitAmendRestoreSnapshot("draft message", "", {
      hash: "123",
      shortHash: "123",
      subject: "feat: amend target",
      fullMessage: "feat: amend target\n\nbody line",
      author: "Alice Example <alice@example.com>",
      entries: [],
    });

    expect(shouldApplyCommitAmendMessage("draft   message", "feat: amend target\n\nbody line")).toBe(true);
    expect(shouldApplyCommitAmendMessage("feat: amend target body line", "feat: amend target\n\nbody line")).toBe(false);
    expect(shouldRestoreCommitAmendMessage("feat: amend target\n\nbody line", snapshot)).toBe(true);
    expect(shouldRestoreCommitAmendMessage("user changed message", snapshot)).toBe(false);
  });

  it("应只在作者仍保持 amend 写入值时恢复旧作者", () => {
    const snapshot = createCommitAmendRestoreSnapshot("draft message", "", {
      hash: "123",
      shortHash: "123",
      subject: "feat: amend target",
      fullMessage: "feat: amend target",
      author: "Alice Example <alice@example.com>",
      entries: [],
    });

    expect(shouldRestoreCommitAmendAuthor("Alice Example <alice@example.com>", snapshot)).toBe(true);
    expect(shouldRestoreCommitAmendAuthor("Bob Example <bob@example.com>", snapshot)).toBe(false);
    expect(formatCommitAmendAuthor("Alice Example", "alice@example.com")).toBe("Alice Example <alice@example.com>");
  });

  it("应按 amend 开关切换主提交按钮文案", () => {
    expect(buildCommitActionLabel(false, false)).toBe("提交");
    expect(buildCommitActionLabel(false, false, true)).toBe("全部提交");
    expect(buildCommitActionLabel(true, false)).toBe("修改提交");
    expect(buildCommitActionLabel(true, true)).toBe("修改并推送...");
    expect(buildCommitActionLabel(false, true, true)).toBe("提交并推送...");
  });

  it("应按 IDEA 的 canonical Hash 语义做精确身份比较，而不是把短前缀视为同一提交", () => {
    expect(isSameCommitHashIdentity(
      "64edc51214ddd76c3013e379e8e3ebfbaced1610",
      "64EDC51214DDD76C3013E379E8E3EBFBACED1610",
    )).toBe(true);
    expect(isSameCommitHashIdentity("64edc51", "64edc51214ddd76c3013e379e8e3ebfbaced1610")).toBe(false);
    expect(isSameCommitHashIdentity("64edc51214ddd76c3013e379e8e3ebfbaced1610", "64edc51")).toBe(false);
    expect(isSameCommitHashIdentity("64edc51214ddd76c3013e379e8e3ebfbaced1610", "abcd1234")).toBe(false);
    expect(isSameCommitHashIdentity("64ed", "64edc51214ddd76c3013e379e8e3ebfbaced1610")).toBe(false);
    expect(isSameCommitHashIdentity("", "64edc51214ddd76c3013e379e8e3ebfbaced1610")).toBe(false);
  });
});
