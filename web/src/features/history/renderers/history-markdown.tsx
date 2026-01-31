// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useMemo } from "react";
import { MarkdownHooks, type ExtraProps, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { rehypePrettyCode } from "rehype-pretty-code";
import { cn } from "@/lib/utils";

type HistoryMarkdownProps = {
  /** 原始文本（通常为 history item 的 text）。 */
  text: string;
  /** 额外 className（会合并到容器上）。 */
  className?: string;
};

const CODE_BLOCK_CLASS_NAME =
  "overflow-x-auto rounded-apple bg-[var(--cf-surface-muted)] border border-[var(--cf-border)] p-3 text-xs text-[var(--cf-text-primary)] font-mono shadow-apple-inner";

const INLINE_CODE_CLASS_NAME =
  "rounded-apple-sm bg-[var(--cf-surface-muted)] px-1.5 py-0.5 text-[0.85em] text-[var(--cf-text-primary)] font-mono";

/**
 * 中文说明：判断当前行是否为 fenced code block 的起止行（``` 或 ~~~）。
 */
function parseFenceLine(line: string): { marker: "`" | "~"; size: number } | null {
  const m = line.match(/^(\s*)(`{3,}|~{3,})/);
  if (!m) return null;
  const fence = m[2] || "";
  const marker = fence[0] === "~" ? "~" : "`";
  return { marker, size: fence.length };
}

/**
 * 中文说明：修复 LLM 常见的“1) xxx”有序列表写法，转换为 Markdown 可识别的“1. xxx”。
 */
function fixBrokenOrderedListLine(line: string): string {
  return line.replace(/^(\s*)(\d+)\)\s+/, "$1$2. ");
}

/**
 * 中文说明：对普通文本片段做 Windows 路径反斜杠转义，避免出现 `\_` 被解析为转义从而丢失路径分隔符。
 */
function escapeWindowsPathsInTextSegment(segment: string): string {
  if (!segment.includes("\\")) return segment;
  // 规则：对可能是 Windows 路径/UNC 路径的片段，将 `\` 转为 `\\`（让 Markdown 最终渲染为单个反斜杠）。
  const re = /(?:[A-Za-z]:\\|\\\\)[^\s]+/g;
  return segment.replace(re, (m) => m.replace(/\\/g, "\\\\"));
}

/**
 * 中文说明：仅在非行内代码区域中转义 Windows 路径，避免影响 `inline code` 的原始内容。
 */
function escapeWindowsPathsOutsideInlineCode(line: string): string {
  if (!line.includes("\\")) return line;
  if (!line.includes("`")) return escapeWindowsPathsInTextSegment(line);

  let out = "";
  let cursor = 0;
  let inInlineCode = false;
  let inlineFenceSize = 0;

  while (cursor < line.length) {
    const bt = line.indexOf("`", cursor);
    if (bt === -1) {
      const tail = line.slice(cursor);
      out += inInlineCode ? tail : escapeWindowsPathsInTextSegment(tail);
      break;
    }

    const before = line.slice(cursor, bt);
    out += inInlineCode ? before : escapeWindowsPathsInTextSegment(before);

    let j = bt;
    while (j < line.length && line[j] === "`") j += 1;
    const run = line.slice(bt, j);
    out += run;

    if (!inInlineCode) {
      inInlineCode = true;
      inlineFenceSize = run.length;
    } else if (run.length === inlineFenceSize) {
      inInlineCode = false;
      inlineFenceSize = 0;
    }

    cursor = j;
  }

  return out;
}

/**
 * 中文说明：对历史详情中的文本做 Markdown 渲染前的轻量修复：
 * - 修复“1) ”有序列表写法为“1. ”，避免解析失败；
 * - 对非代码区域中的 Windows 路径做反斜杠转义，避免 `\_` 导致路径分隔符丢失。
 */
export function preprocessHistoryMarkdown(text: string): string {
  const src = String(text ?? "");
  if (!src) return "";

  const normalized = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  const out: string[] = [];
  let inFence = false;
  let fenceMarker: "`" | "~" = "`";
  let fenceSize = 3;

  for (const rawLine of lines) {
    const line = String(rawLine ?? "");
    const fence = parseFenceLine(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence.marker;
        fenceSize = fence.size;
        out.push(line);
        continue;
      }
      if (inFence && fence.marker === fenceMarker && fence.size >= fenceSize) {
        inFence = false;
        out.push(line);
        continue;
      }
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    const fixedList = fixBrokenOrderedListLine(line);
    const escapedPaths = escapeWindowsPathsOutsideInlineCode(fixedList);
    out.push(escapedPaths);
  }

  return out.join("\n");
}

type MarkdownAnchorProps = React.ComponentPropsWithoutRef<"a"> & ExtraProps;
type MarkdownPreProps = React.ComponentPropsWithoutRef<"pre"> & ExtraProps;
type MarkdownCodeProps = React.ComponentPropsWithoutRef<"code"> & ExtraProps;
type MarkdownTableProps = React.ComponentPropsWithoutRef<"table"> & ExtraProps;

/**
 * 中文说明：Markdown 链接渲染，默认走 Host API 打开外部链接，避免在 Electron 内部直接跳转。
 */
function MarkdownLink(props: MarkdownAnchorProps) {
  const { href, onClick, ...rest } = props;
  return (
    <a
      {...rest}
      href={href}
      onClick={async (e) => {
        try {
          if (onClick) onClick(e);
          if (e.defaultPrevented) return;
          const url = String(href || "");
          if (!url) return;
          // 允许页面内锚点默认行为
          if (url.startsWith("#")) return;
          e.preventDefault();
          try {
            await window.host.utils.openExternalUrl(url);
          } catch {
            try {
              window.open(url, "_blank", "noopener,noreferrer");
            } catch {}
          }
        } catch {}
      }}
    />
  );
}

/**
 * 中文说明：Markdown 代码块容器渲染（统一应用滚动、背景、边框与字体样式）。
 */
function MarkdownPre(props: MarkdownPreProps) {
  const { className, ...rest } = props;
  return <pre {...rest} className={cn(CODE_BLOCK_CLASS_NAME, className)} />;
}

/**
 * 中文说明：Markdown code 渲染：尽量只对行内 code 追加样式，避免影响代码块的高亮结构。
 */
function MarkdownCode(props: MarkdownCodeProps) {
  const { className, ...rest } = props;
  // 经验规则：block code 通常带 className（language-xxx / shiki 等），行内 code 多数没有。
  const shouldStyleInline = !className;
  return <code {...rest} className={cn(shouldStyleInline ? INLINE_CODE_CLASS_NAME : "", className)} />;
}

/**
 * 中文说明：表格渲染时外层包一层横向滚动容器，避免撑破历史详情宽度。
 */
function MarkdownTable(props: MarkdownTableProps) {
  const { className, ...rest } = props;
  return (
    <div className="overflow-x-auto">
      <table {...rest} className={cn("w-full", className)} />
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  a: MarkdownLink,
  pre: MarkdownPre,
  code: MarkdownCode,
  table: MarkdownTable,
};

/**
 * 中文说明：历史详情专用 Markdown 渲染器。
 * - 采用 react-markdown 的 Hooks 版本以支持 async rehype（rehype-pretty-code）；
 * - 内置轻量预处理修复，尽量贴近 Cursor 插件的展示细节；
 * - 默认使用 prose 排版，并通过 data-history-search-scope 标记可搜索内容区域。
 */
export function HistoryMarkdown(props: HistoryMarkdownProps) {
  const { text, className } = props;

  const processed = useMemo(() => preprocessHistoryMarkdown(text), [text]);

  return (
    <div
      data-history-search-scope
      className={cn("prose prose-sm max-w-none dark:prose-invert cf-history-markdown", className)}
    >
      <MarkdownHooks
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[
          [
            rehypePrettyCode,
            {
              // 说明：同时提供亮/暗主题，暗色模式通过 CSS 选择 --shiki-dark 覆盖 token 颜色。
              theme: { light: "github-light", dark: "github-dark" },
              keepBackground: false,
              // 说明：默认按纯文本处理未标注语言的代码块，避免加载失败产生噪音日志
              defaultLang: "plaintext",
              // 说明：行内 code 通常更偏“强调/片段”，不做语法高亮可显著降低处理开销
              bypassInlineCode: true,
            },
          ],
        ]}
        components={MARKDOWN_COMPONENTS}
        fallback={
          // 说明：异步高亮尚未完成时的兜底展示，尽量维持旧版“按换行展示”的直观效果。
          <div className="whitespace-pre-wrap break-words text-[var(--cf-text-primary)]">{text}</div>
        }
      >
        {processed}
      </MarkdownHooks>
    </div>
  );
}
