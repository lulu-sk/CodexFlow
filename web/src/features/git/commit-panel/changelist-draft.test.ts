import { describe, expect, it } from "vitest";
import {
  areChangeListCommitDraftsEqual,
  buildChangeListCommitDraftPatch,
  readChangeListCommitDraft,
} from "./changelist-draft";

describe("changelist commit draft", () => {
  it("应从 comment/data 读取当前列表草稿", () => {
    expect(readChangeListCommitDraft({
      id: "feature",
      name: "功能",
      comment: "draft message",
      data: {
        commitAuthor: "Alice <alice@example.com>",
        commitAuthorDate: "2026-03-19T09:10:11",
        commitRenamesSeparately: true,
      },
      fileCount: 1,
      files: ["a.txt"],
    })).toEqual({
      message: "draft message",
      author: "Alice <alice@example.com>",
      authorDate: "2026-03-19T09:10:11",
      commitRenamesSeparately: true,
    });
  });

  it("应在构建 patch 时保留其他 data 字段，并在清空后回写 null", () => {
    const patch = buildChangeListCommitDraftPatch({
      id: "feature",
      name: "功能",
      comment: "old",
      data: {
        keep: "value",
        commitAuthor: "Alice <alice@example.com>",
      },
      fileCount: 1,
      files: ["a.txt"],
    }, {
      message: "",
      author: "",
      authorDate: "",
      commitRenamesSeparately: false,
    });

    expect(patch).toEqual({
      comment: "",
      data: {
        keep: "value",
      },
    });
  });

  it("比较函数应只在 message/author/date/rename 都一致时返回 true", () => {
    expect(areChangeListCommitDraftsEqual({
      message: "draft",
      author: "Alice",
      authorDate: "2026-03-19T09:10:11",
      commitRenamesSeparately: true,
    }, {
      message: "draft",
      author: "Alice",
      authorDate: "2026-03-19T09:10:11",
      commitRenamesSeparately: true,
    })).toBe(true);

    expect(areChangeListCommitDraftsEqual({
      message: "draft",
      author: "Alice",
      authorDate: "",
      commitRenamesSeparately: false,
    }, {
      message: "draft",
      author: "Bob",
      authorDate: "",
      commitRenamesSeparately: false,
    })).toBe(false);
  });
});
