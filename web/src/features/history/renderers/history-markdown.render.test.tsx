// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryMarkdown } from "./history-markdown";
import { applyHistoryFindHighlights, clearHistoryFindHighlights } from "@/features/history/find/history-find";

const highlighterRuns = vi.hoisted(() => ({ count: 0 }));
vi.mock("rehype-pretty-code", async (importOriginal) => {
  const actual = await importOriginal<typeof import("rehype-pretty-code")>();
  return {
    ...actual,
    /** 保留真实高亮，只记录转换次数以验证菜单和父层刷新不会重复解析。 */
    rehypePrettyCode(...args: Parameters<typeof actual.rehypePrettyCode>) {
      const transformer = actual.rehypePrettyCode(...args);
      if (!transformer) return transformer;
      /** 记录每次语法树高亮转换，转发参数和结果。 */
      return (...transformArgs: Parameters<typeof transformer>) => {
        highlighterRuns.count += 1;
        return transformer(...transformArgs);
      };
    },
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { line?: number; column?: number }) => {
      if (key === "history:localFileLine") return `第 ${options?.line} 行`;
      if (key === "history:localFileLineColumn") return `第 ${options?.line} 行，第 ${options?.column} 列`;
      if (key === "history:codeBlockPlainText") return "纯文本";
      return key;
    },
  }),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let mountedRoot: Root | undefined;

/** 挂载真实历史 Markdown，等待异步语法高亮完成后再检查界面。 */
async function renderHistoryMarkdown(text: string, selector: string): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mountedRoot = createRoot(host);
  await act(async () => mountedRoot?.render(
    <div data-history-message-key="session-0">
      <HistoryMarkdown text={text} projectRootPath={"C:\\workspace\\project"} />
    </div>,
  ));
  const deadline = Date.now() + 8000;
  while (!host.querySelector(selector) && Date.now() < deadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  if (!host.querySelector(selector)) throw new Error("历史 Markdown 未在限定时间内完成渲染");
  return host;
}

afterEach(() => {
  clearHistoryFindHighlights(document.body);
  act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  document.body.innerHTML = "";
  delete (window as any).host;
  vi.restoreAllMocks();
});

describe("HistoryMarkdown 渲染", () => {
  it("普通正文首帧就显示外链强调样式，外链走浏览器且不带文件菜单", async () => {
    const openExternalUrl = vi.fn().mockResolvedValue({ ok: true });
    (window as any).host = { utils: { openExternalUrl } };
    const host = document.createElement("div");
    document.body.appendChild(host);
    mountedRoot = createRoot(host);
    const previousRuns = highlighterRuns.count;
    act(() => mountedRoot?.render(<HistoryMarkdown text="[作者完整场景](https://example.com/scene)" />));
    const link = host.querySelector<HTMLAnchorElement>("a");
    expect(link?.className).toContain("!text-[var(--cf-accent)]");
    expect(link?.querySelector(".lucide-external-link")).not.toBeNull();
    expect(link?.querySelector(".lucide-file-text,.lucide-file-code-2")).toBeNull();
    expect(highlighterRuns.count).toBe(previousRuns);
    await act(async () => link?.click());
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/scene");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => { link?.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(document.body.textContent).not.toContain("history:copyPath");
  });

  it("代码高亮完成后打开本地文件菜单和父层刷新不再重复高亮", async () => {
    const text = "[main.ts](C:/workspace/main.ts)\n\n```ts\nconst value = 1;\n```";
    const host = await renderHistoryMarkdown(text, "pre code");
    const previousRuns = highlighterRuns.count;
    const link = host.querySelector<HTMLAnchorElement>("a");
    await act(async () => { link?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    expect(document.body.textContent).toContain("history:copyPath");
    await act(async () => mountedRoot?.render(
      <div data-history-message-key="session-0">
        <HistoryMarkdown text={text} className="parent-refresh" projectRootPath={"C:\\workspace\\project"} />
      </div>,
    ));
    expect(host.querySelector("pre code")?.textContent).toContain("const value = 1;");
    expect(highlighterRuns.count).toBe(previousRuns);
  });

  it("本地文件显示图标、强调色和独立行列标签，点击仍按位置打开", async () => {
    const openPathAtPosition = vi.fn().mockResolvedValue({ ok: true });
    (window as any).host = { utils: { openPathAtPosition } };
    const host = await renderHistoryMarkdown("[main.ts:42:3](C:/workspace/project/src/main.ts:42:3)", "a");
    const link = host.querySelector<HTMLAnchorElement>("a");
    expect(link?.querySelector("svg")).not.toBeNull();
    expect(link?.className).toContain("!text-[var(--cf-accent)]");
    expect(link?.textContent).toBe("main.ts(第 42 行，第 3 列)");
    expect(link?.title).toBe("C:/workspace/project/src/main.ts:42:3");
    await act(async () => link?.click());
    expect(openPathAtPosition).toHaveBeenCalledWith("C:/workspace/project/src/main.ts", {
      line: 42,
      column: 3,
      projectPath: "C:\\workspace\\project",
    });
  });

  it("bat 代码块显示语言和复制按钮，复制保留多行和缩进", async () => {
    const copyText = vi.fn().mockResolvedValue({ ok: true });
    (window as any).host = { utils: { copyText } };
    const code = '  set "EXAMPLE_MIRROR=https://example.com/releases/"\n  npm ci --foreground-scripts';
    const host = await renderHistoryMarkdown(`\`\`\`bat\n${code}\n\`\`\``, "pre code");
    expect(host.textContent).toContain("bat");
    const copyButton = host.querySelector<HTMLButtonElement>('button[aria-label="history:copyBlock"]');
    expect(copyButton?.disabled).toBe(false);
    await act(async () => copyButton?.click());
    expect(copyText).toHaveBeenCalledWith(code);
  });

  it("未标语言的代码块也能复制，行内代码保持轻量样式", async () => {
    const host = await renderHistoryMarkdown("`npm ci`\n\n```\nplain value\n```", "pre code");
    expect(host.textContent).toContain("纯文本");
    expect(host.querySelector("pre code")?.className).not.toContain("px-1.5");
    expect(host.querySelector("p code")?.className).toContain("px-1.5");
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
  });

  it("复制时分别保留真正空行和只有一个空格的行", async () => {
    const copyText = vi.fn().mockResolvedValue({ ok: true });
    (window as any).host = { utils: { copyText } };
    const code = "echo first\n\n \necho last";
    const host = await renderHistoryMarkdown(`\`\`\`bat\n${code}\n\`\`\``, "pre code");
    const copyButton = host.querySelector<HTMLButtonElement>('button[aria-label="history:copyBlock"]');
    await act(async () => copyButton?.click());
    expect(copyText).toHaveBeenCalledWith(code);
  });

  it.each([
    { query: "行", expectedParagraph: "下一行" },
    { query: "文本", expectedParagraph: "这是文本内容" },
  ])("生成的行号和语言标题不增加“$query”命中，导航仍指向原文", async ({ query, expectedParagraph }) => {
    const source = "[说明](/workspace/src/example.ts:42)\n\n下一行\n\n```\nvalue\n```\n\n这是文本内容";
    const host = await renderHistoryMarkdown(source, "pre code");
    // 原文中只有一次命中，数据层为该消息分配第一个正文命中 ID。
    const dataMatches = [{ id: "hfind-session-0-t0", messageKey: "session-0" }];
    expect(source.split(query).length - 1).toBe(dataMatches.length);
    expect(applyHistoryFindHighlights({ root: host, query })).toEqual(dataMatches);
    const mark = host.querySelector<HTMLElement>('[data-match-id="hfind-session-0-t0"]');
    expect(mark?.closest("p")?.textContent).toBe(expectedParagraph);
    expect(mark?.closest("[data-history-search-ignore]")).toBeNull();
    expect(host.querySelectorAll("mark")).toHaveLength(1);
  });
});
