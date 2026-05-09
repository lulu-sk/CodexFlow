import { describe, expect, it } from "vitest";
import { resolveGitTextWith } from "./git-i18n";

describe("git i18n helper", () => {
  it("应对默认文案中的双花括号占位符做兜底插值", () => {
    const text = resolveGitTextWith(
      (_key, options) => String(options.defaultValue || ""),
      "dialogs.rollbackViewer.files.selectedCount",
      "已选 {{selected}} / {{total}}",
      { selected: 1, total: 2 },
    );
    expect(text).toBe("已选 1 / 2");
  });

  it("应对翻译结果中遗留的占位符做兜底插值", () => {
    const text = resolveGitTextWith(
      () => "{{directoryCount}} 个目录，{{fileCount}} 个文件",
      "commitTree.summary.directoriesAndFiles",
      "ignored",
      { directoryCount: 3, fileCount: 5 },
    );
    expect(text).toBe("3 个目录，5 个文件");
  });
});
