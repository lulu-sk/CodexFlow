import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultGitLogColumnLayout,
  buildGitLogCopyText,
  estimateGitLogColumnWidth,
  loadGitLogColumnLayout,
  normalizeGitLogColumnLayout,
  resolveGitLogColumnWidth,
  resizeGitLogColumn,
} from "./log-columns";

describe("log-columns", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 验证默认布局会为短列与引用列开启自动宽度，兼顾首屏空间利用率。
   */
  it("默认对作者/时间/哈希列启用自动宽度", () => {
    const layout = createDefaultGitLogColumnLayout();
    expect(layout.autoFit.author).toBe(true);
    expect(layout.autoFit.date).toBe(true);
    expect(layout.autoFit.hash).toBe(true);
    expect(layout.autoFit.subject).toBe(false);
    expect(layout.autoFit.refs).toBe(true);
  });

  /**
   * 验证纯 normalize 不负责旧缓存迁移；只要历史宽度显式偏离当前默认值，就保持“手动宽度”语义。
   */
  it("normalize 会把显式旧宽度视为手动设置", () => {
    const layout = normalizeGitLogColumnLayout({
      order: ["hash", "subject"],
      widths: {
        subject: 420,
        author: 140,
        date: 132,
        hash: 104,
        refs: 220,
      },
    });
    expect(layout.autoFit.author).toBe(false);
    expect(layout.autoFit.date).toBe(false);
    expect(layout.autoFit.hash).toBe(false);
    expect(layout.autoFit.subject).toBe(false);
    expect(layout.autoFit.refs).toBe(false);
  });

  /**
   * 验证从 v1/v2 缓存读取时，会把历史默认宽度迁移到当前更紧凑的默认布局。
   */
  it("从旧版缓存加载时会执行迁移", () => {
    const storage = {
      getItem(key: string): string | null {
        if (key !== "cf.gitWorkbench.logColumns.v2") return null;
        return JSON.stringify({
          widths: {
            subject: 420,
            author: 140,
            date: 132,
            hash: 104,
            refs: 220,
          },
        });
      },
      setItem(): void {},
      removeItem(): void {},
      clear(): void {},
      key(): string | null {
        return null;
      },
      length: 0,
    };
    vi.stubGlobal("window", { localStorage: storage });

    const layout = loadGitLogColumnLayout();
    expect(layout.widths.subject).toBe(368);
    expect(layout.widths.author).toBe(104);
    expect(layout.widths.date).toBe(96);
    expect(layout.widths.hash).toBe(82);
    expect(layout.widths.refs).toBe(128);
    expect(layout.autoFit.author).toBe(true);
    expect(layout.autoFit.date).toBe(true);
    expect(layout.autoFit.hash).toBe(true);
    expect(layout.autoFit.refs).toBe(true);
  });

  /**
   * 验证旧缓存中若列宽明显偏离历史默认值，迁移后仍视为用户手动设置，避免自动宽度覆盖历史习惯。
   */
  it("兼容旧版手动列宽缓存", () => {
    const layout = normalizeGitLogColumnLayout({
      widths: {
        subject: 420,
        author: 166,
        date: 132,
        hash: 104,
        refs: 220,
      },
    });
    expect(layout.autoFit.author).toBe(false);
    expect(layout.autoFit.date).toBe(false);
    expect(layout.autoFit.hash).toBe(false);
    expect(layout.autoFit.refs).toBe(false);
  });

  /**
   * 验证自动宽度会按内容收紧作者列，避免作者名很短时保留过大空白。
   */
  it("按内容收紧短列宽度", () => {
    const layout = createDefaultGitLogColumnLayout();
    const preferred = estimateGitLogColumnWidth("author", ["lulu", "ci"]);
    const resolved = resolveGitLogColumnWidth(layout, "author", preferred);
    expect(preferred).toBeLessThan(layout.widths.author);
    expect(resolved).toBe(preferred);
  });

  /**
   * 验证用户手动拖拽后关闭自动宽度，后续保持手工设定结果。
   */
  it("手动拖拽后保留用户设置宽度", () => {
    const layout = createDefaultGitLogColumnLayout();
    const resized = resizeGitLogColumn(layout, "author", 166);
    expect(resized.autoFit.author).toBe(false);
    expect(resolveGitLogColumnWidth(resized, "author", 72)).toBe(166);
  });

  /**
   * 验证日志复制文本按当前列顺序输出，且只包含被选中的提交行。
   */
  it("copy provider 应按当前列顺序输出选中提交", () => {
    const text = buildGitLogCopyText({
      items: [
        {
          hash: "a1b2c3d4",
          shortHash: "a1b2c3d",
          parents: [],
          authorName: "Alice",
          authorEmail: "alice@example.com",
          authorDate: "2025-06-01T00:00:00.000Z",
          subject: "feat: one",
          decorations: "main",
        },
        {
          hash: "b2c3d4e5",
          shortHash: "b2c3d4e",
          parents: [],
          authorName: "Bob",
          authorEmail: "bob@example.com",
          authorDate: "2025-06-02T00:00:00.000Z",
          subject: "fix: two",
          decorations: "origin/main",
        },
      ],
      selectedHashes: ["b2c3d4e5", "a1b2c3d4"],
      layout: {
        order: ["author", "hash", "subject", "date", "refs"],
        widths: {
          subject: 368,
          author: 104,
          date: 96,
          hash: 82,
          refs: 128,
        },
        autoFit: {
          subject: false,
          author: true,
          date: true,
          hash: true,
          refs: true,
        },
      },
      formatDate: (iso) => iso.slice(0, 10),
    });

    expect(text).toBe([
      "Alice a1b2c3d feat: one 2025-06-01 main",
      "Bob b2c3d4e fix: two 2025-06-02 origin/main",
    ].join("\n"));
  });
});
