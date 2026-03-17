// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import type { HistoryMessage, MessageContent } from "@/app/app-shared";
import { useHistoryImageContextMenu } from "@/components/history/history-image-context-menu";
import InteractiveImagePreview from "@/components/ui/interactive-image-preview";
import { HistoryMarkdown } from "@/features/history/renderers/history-markdown";

const IMAGE_PATH_PATTERN = /@?((?:[A-Za-z]:\\|\/mnt\/[A-Za-z]\/|\/(?:home|root|Users)\/|\\\\[^\\\/\r\n]+\\[^\\\/\r\n]+\\)[^\r\n]*?\.(?:png|jpe?g|webp|gif|bmp|svg))/gi;
const IMAGE_OPEN_TAG_PATTERN = /<image\s+name=\[([^\]]+)\]>/gi;
const IMAGE_CLOSE_TAG_PATTERN = /<\/image>/gi;
const IMAGE_PLACEHOLDER_PATTERN = /\[(image\s+\d+[^\]]*)\]/gi;
const IMAGE_LABEL_PATTERN = /\[(Image\s*#\d+)\]/gi;

export type HistoryInlineImageMessageInput = {
  messageKey: string;
  message: HistoryMessage;
};

type HistoryInlineImageCandidate = {
  imageItemKey: string;
  image: MessageContent;
  pathKeys: string[];
};

type HistoryInlineImageTokenKind = "path" | "image_open" | "image_close" | "image_placeholder" | "image_label";

type HistoryInlineImageTextToken = {
  kind: HistoryInlineImageTokenKind;
  rawText: string;
  displayText: string;
  start: number;
  end: number;
  path?: string;
  label?: string;
};

type HistoryInlineImageMatch = {
  kind: Exclude<HistoryInlineImageTokenKind, "image_close">;
  tokenText: string;
  displayText: string;
  imageItemKey: string;
  image: MessageContent;
  path?: string;
  label?: string;
};

type HistoryInlineImageTextEntry = {
  textItemKey: string;
  text: string;
  tokens: HistoryInlineImageTextToken[];
};

type HistoryInlineImageItemEntry = {
  imageItemKey: string;
  image: MessageContent;
};

type HistoryInlineImageResolverRuntime = {
  pathQueues: Map<string, HistoryInlineImageCandidate[]>;
  groupedImageItemKeysByPathKey: Map<string, Set<string>>;
  sequentialCandidates: HistoryInlineImageCandidate[];
  consumedImageItemKeys: Set<string>;
  hiddenImageItemKeys: Set<string>;
  boundCandidateByPathKey: Map<string, HistoryInlineImageCandidate>;
  sequentialCursor: { value: number };
};

export type HistoryInlineImageRenderState = {
  hiddenImageItemKeys: Set<string>;
  hiddenTextItemKeys: Set<string>;
  matchesByTextItemKey: Map<string, HistoryInlineImageMatch[]>;
};

type HistoryInlineImageTextProps = {
  text: string;
  textItemKey: string;
  projectRootPath?: string;
  inlineImageState?: HistoryInlineImageRenderState;
};

/**
 * 中文说明：构造历史消息内单个内容项的稳定键。
 */
export function buildHistoryContentItemKey(messageKey: string, itemIndex: number): string {
  return `${String(messageKey || "").trim()}:content:${Math.max(0, Number(itemIndex) || 0)}`;
}

/**
 * 中文说明：判断某类内容是否适合做“路径旁内联图片”渲染。
 * - 仅对原本按 Markdown/普通文本渲染的内容启用；
 * - `code`、`state`、`session_meta` 等结构化块维持原展示方式。
 */
export function shouldRenderHistoryTextWithInlineImages(type?: string): boolean {
  const ty = String(type || "").trim().toLowerCase();
  if (ty === "image") return false;
  if (ty === "code") return false;
  if (ty === "function_call") return false;
  if (ty === "function_output") return false;
  if (ty === "user_instructions") return false;
  if (ty === "environment_context") return false;
  if (ty === "instructions") return false;
  if (ty === "git") return false;
  if (ty === "state") return false;
  if (ty === "session_meta") return false;
  return true;
}

/**
 * 中文说明：判断一条历史消息在应用“图片回挂”后是否仍有可见内容。
 */
export function hasVisibleHistoryMessageContent(
  message: HistoryMessage | null | undefined,
  messageKey: string,
  inlineImageState?: HistoryInlineImageRenderState,
): boolean {
  const items = Array.isArray(message?.content) ? message!.content : [];
  if (items.length === 0) return false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const itemKey = buildHistoryContentItemKey(messageKey, index);
    const type = String(item?.type || "").trim().toLowerCase();
    if (type === "image") {
      if (!inlineImageState?.hiddenImageItemKeys?.has(itemKey)) return true;
      continue;
    }
    if (inlineImageState?.hiddenTextItemKeys?.has(itemKey)) continue;
    if (String(item?.text ?? "").trim().length > 0) return true;
  }
  return false;
}

/**
 * 中文说明：基于“文本 token”和“会话中恢复出的图片项”建立只读配对关系。
 * - 路径型 token 会优先复用同一路径代表图，并隐藏该路径对应的全部独立图片块；
 * - 占位符型 token 会按出现顺序绑定图片，兼容旧版 Codex/Claude/Gemini 历史结构；
 * - 纯 `</image>` 文本项会被标记为隐藏，避免详情页残留噪音行。
 */
export function resolveHistoryInlineImageRenderState(
  messages: HistoryInlineImageMessageInput[],
): HistoryInlineImageRenderState {
  const runtime = collectHistoryInlineImageCandidates(messages);
  const hiddenTextItemKeys = new Set<string>();
  const matchesByTextItemKey = new Map<string, HistoryInlineImageMatch[]>();

  for (const view of Array.isArray(messages) ? messages : []) {
    const items = Array.isArray(view?.message?.content) ? view.message.content : [];
    const messageTextEntries: HistoryInlineImageTextEntry[] = [];
    const messageImageEntries: HistoryInlineImageItemEntry[] = [];
    const boundCandidateByLabelKey = new Map<string, HistoryInlineImageCandidate>();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const type = String(item?.type || "").trim().toLowerCase();
      if (type === "image") {
        messageImageEntries.push({
          imageItemKey: buildHistoryContentItemKey(view.messageKey, index),
          image: item,
        });
      }
      if (!shouldRenderHistoryTextWithInlineImages(type)) continue;

      const text = String(item?.text ?? "");
      if (!text) continue;
      const textItemKey = buildHistoryContentItemKey(view.messageKey, index);
      const tokens = extractHistoryInlineImageTokens(text);
      if (tokens.length === 0) continue;

      const matches: HistoryInlineImageMatch[] = [];
      for (const token of tokens) {
        if (token.kind === "image_close") continue;
        const candidate = resolveHistoryInlineImageTokenMatch(token, runtime, boundCandidateByLabelKey);
        if (!candidate) continue;
        matches.push({
          kind: token.kind,
          tokenText: token.rawText,
          displayText: token.displayText,
          imageItemKey: candidate.imageItemKey,
          image: candidate.image,
          path: token.path,
          label: token.label,
        });
      }

      if (matches.length > 0) matchesByTextItemKey.set(textItemKey, matches);
      if (shouldHideHistoryInlineTextItem(text, tokens)) hiddenTextItemKeys.add(textItemKey);
      messageTextEntries.push({ textItemKey, text, tokens });
    }

    for (const textItemKey of collectCollapsibleHistoryInlineTextItemKeys(messageTextEntries)) {
      hiddenTextItemKeys.add(textItemKey);
    }
    for (const imageItemKey of collectCollapsibleHistoryInlineImageItemKeys(messageImageEntries, messageTextEntries)) {
      runtime.hiddenImageItemKeys.add(imageItemKey);
    }
  }

  return {
    hiddenImageItemKeys: runtime.hiddenImageItemKeys,
    hiddenTextItemKeys,
    matchesByTextItemKey,
  };
}

/**
 * 中文说明：将包含路径或图片占位符的文本渲染为“原文本 + 行内缩略图”。
 * - 仅在存在已解析 token 时启用自定义渲染；
 * - 普通文本仍回退到 `HistoryMarkdown`，尽量保持原有展示能力。
 */
export function HistoryTextWithInlineImages({
  text,
  textItemKey,
  projectRootPath,
  inlineImageState,
}: HistoryInlineImageTextProps) {
  if (inlineImageState?.hiddenTextItemKeys?.has(textItemKey)) return null;

  const matches = inlineImageState?.matchesByTextItemKey?.get(textItemKey) || [];
  const tokens = extractHistoryInlineImageTokens(text);
  const hasPathPreviewFallback = tokens.some((token) => token.kind === "path" && !!buildHistoryInlineImageContentFromPath(token.path || token.rawText));
  const shouldUseCustomRender = tokens.length > 0 && (
    matches.length > 0 || hasPathPreviewFallback || tokens.some((token) => token.kind !== "path")
  );
  if (!shouldUseCustomRender) return <HistoryMarkdown text={text} projectRootPath={projectRootPath} />;

  const lines = String(text || "").split(/\r?\n/);
  let matchCursor = 0;

  /**
   * 中文说明：按文本出现顺序取出当前 token 对应的下一张图片，避免跨 token 串配。
   */
  const takeNextMatch = (token: HistoryInlineImageTextToken): HistoryInlineImageMatch | null => {
    for (let index = matchCursor; index < matches.length; index += 1) {
      const candidate = matches[index];
      if (!doesHistoryInlineImageMatchToken(candidate, token)) continue;
      matchCursor = index + 1;
      return candidate;
    }
    return null;
  };

  return (
    <div data-history-search-scope className="min-w-0 space-y-1.5">
      {lines.map((line, lineIndex) => {
        const lineTokens = extractHistoryInlineImageTokens(line);
        if (lineTokens.length === 0) {
          return (
            <div key={`${textItemKey}-line-${lineIndex}`} className="min-w-0 break-words whitespace-pre-wrap">
              {line || "\u00a0"}
            </div>
          );
        }

        const nodes: React.ReactNode[] = [];
        let lastIndex = 0;
        for (let tokenIndex = 0; tokenIndex < lineTokens.length; tokenIndex += 1) {
          const token = lineTokens[tokenIndex];
          if (token.start > lastIndex) {
            nodes.push(
              <span key={`${textItemKey}-line-${lineIndex}-prefix-${tokenIndex}`} className="whitespace-pre-wrap">
                {line.slice(lastIndex, token.start)}
              </span>,
            );
          }

          if (token.kind !== "image_close") {
            const match = takeNextMatch(token);
            if (match) {
              const mergedImage = token.kind === "path"
                ? mergeHistoryInlineImageWithPathFallback(match.image, token.path || token.rawText)
                : match.image;
              nodes.push(
                <HistoryInlineImageToken
                  key={`${textItemKey}-line-${lineIndex}-token-${tokenIndex}`}
                  displayText={match.displayText || token.displayText}
                  image={mergedImage}
                />,
              );
            } else if (token.kind === "path") {
              const fallbackImage = buildHistoryInlineImageContentFromPath(token.path || token.rawText);
              if (fallbackImage) {
                nodes.push(
                  <HistoryInlineImageToken
                    key={`${textItemKey}-line-${lineIndex}-fallback-${tokenIndex}`}
                    displayText={token.displayText}
                    image={fallbackImage}
                  />,
                );
              } else {
                nodes.push(
                  <span
                    key={`${textItemKey}-line-${lineIndex}-plain-${tokenIndex}`}
                    className="break-all whitespace-pre-wrap font-mono text-[0.95em]"
                  >
                    {token.displayText}
                  </span>,
                );
              }
            } else {
              nodes.push(
                <span
                  key={`${textItemKey}-line-${lineIndex}-plain-${tokenIndex}`}
                  className="break-all whitespace-pre-wrap font-mono text-[0.95em]"
                >
                  {token.displayText}
                </span>,
              );
            }
          }

          lastIndex = token.end;
        }

        if (lastIndex < line.length) {
          nodes.push(
            <span key={`${textItemKey}-line-${lineIndex}-suffix`} className="whitespace-pre-wrap">
              {line.slice(lastIndex)}
            </span>,
          );
        }

        if (nodes.length === 0 && stripHistoryInlineImageCloseTags(line).trim().length === 0) return null;

        return (
          <div key={`${textItemKey}-line-${lineIndex}`} className="min-w-0 break-words whitespace-pre-wrap leading-6">
            {nodes.length > 0 ? nodes : (stripHistoryInlineImageCloseTags(line) || "\u00a0")}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 中文说明：收集会话中的图片项，并建立路径索引与顺序索引。
 */
function collectHistoryInlineImageCandidates(
  messages: HistoryInlineImageMessageInput[],
): HistoryInlineImageResolverRuntime {
  const pathQueues = new Map<string, HistoryInlineImageCandidate[]>();
  const groupedImageItemKeysByPathKey = new Map<string, Set<string>>();
  const sequentialCandidates: HistoryInlineImageCandidate[] = [];

  for (const view of Array.isArray(messages) ? messages : []) {
    const items = Array.isArray(view?.message?.content) ? view.message.content : [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (String(item?.type || "").trim().toLowerCase() !== "image") continue;

      const pathKeys = buildHistoryImagePathKeys(String(item?.localPath || ""));
      const candidate: HistoryInlineImageCandidate = {
        imageItemKey: buildHistoryContentItemKey(view.messageKey, index),
        image: item,
        pathKeys,
      };
      sequentialCandidates.push(candidate);

      for (const pathKey of pathKeys) {
        const queue = pathQueues.get(pathKey) || [];
        if (!queue.some((entry) => entry.imageItemKey === candidate.imageItemKey)) queue.push(candidate);
        pathQueues.set(pathKey, queue);

        const groupedItemKeys = groupedImageItemKeysByPathKey.get(pathKey) || new Set<string>();
        groupedItemKeys.add(candidate.imageItemKey);
        groupedImageItemKeysByPathKey.set(pathKey, groupedItemKeys);
      }
    }
  }

  return {
    pathQueues,
    groupedImageItemKeysByPathKey,
    sequentialCandidates,
    consumedImageItemKeys: new Set<string>(),
    hiddenImageItemKeys: new Set<string>(),
    boundCandidateByPathKey: new Map<string, HistoryInlineImageCandidate>(),
    sequentialCursor: { value: 0 },
  };
}

/**
 * 中文说明：为单个文本 token 解析最合适的图片候选。
 */
function resolveHistoryInlineImageTokenMatch(
  token: HistoryInlineImageTextToken,
  runtime: HistoryInlineImageResolverRuntime,
  boundCandidateByLabelKey: Map<string, HistoryInlineImageCandidate>,
): HistoryInlineImageCandidate | null {
  if (token.kind === "path") {
    const pathKeys = buildHistoryImagePathKeys(token.path || token.rawText);
    const boundCandidate = findBoundHistoryInlineImageCandidateByPath(pathKeys, runtime.boundCandidateByPathKey);
    if (boundCandidate) return boundCandidate;

    const candidate = findNextHistoryInlineImageCandidateByPath(pathKeys, runtime);
    if (!candidate) return null;
    bindHistoryInlineImageCandidateToPathKeys(candidate, pathKeys, runtime.boundCandidateByPathKey);
    hideHistoryInlineImageCandidateGroup(candidate, runtime);
    return candidate;
  }

  if (token.kind === "image_open" || token.kind === "image_label") {
    const labelKey = toHistoryInlineImageLabelKey(token.label || token.displayText);
    const boundCandidate = labelKey ? boundCandidateByLabelKey.get(labelKey) || null : null;
    if (boundCandidate) return boundCandidate;

    const candidate = takeNextHistoryInlineImageSequentialCandidate(runtime);
    if (!candidate) return null;
    if (labelKey) boundCandidateByLabelKey.set(labelKey, candidate);
    hideHistoryInlineImageCandidateGroup(candidate, runtime);
    return candidate;
  }

  if (token.kind === "image_placeholder") {
    const candidate = takeNextHistoryInlineImageSequentialCandidate(runtime);
    if (!candidate) return null;
    hideHistoryInlineImageCandidateGroup(candidate, runtime);
    return candidate;
  }

  return null;
}

/**
 * 中文说明：从路径绑定表中查找已绑定的代表图，保证同一路径反复出现时只展示一组图片。
 */
function findBoundHistoryInlineImageCandidateByPath(
  pathKeys: string[],
  boundCandidateByPathKey: Map<string, HistoryInlineImageCandidate>,
): HistoryInlineImageCandidate | null {
  for (const pathKey of pathKeys) {
    const candidate = boundCandidateByPathKey.get(pathKey);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * 中文说明：按路径索引查找下一张尚未被消费的图片候选。
 */
function findNextHistoryInlineImageCandidateByPath(
  pathKeys: string[],
  runtime: HistoryInlineImageResolverRuntime,
): HistoryInlineImageCandidate | null {
  for (const pathKey of pathKeys) {
    const queue = runtime.pathQueues.get(pathKey) || [];
    for (const candidate of queue) {
      if (runtime.consumedImageItemKeys.has(candidate.imageItemKey)) continue;
      return candidate;
    }
  }
  return null;
}

/**
 * 中文说明：从全局顺序队列中取下一张尚未消费的图片，兼容旧版 `<image>` 与 `[image ...]` 占位符。
 */
function takeNextHistoryInlineImageSequentialCandidate(
  runtime: HistoryInlineImageResolverRuntime,
): HistoryInlineImageCandidate | null {
  while (runtime.sequentialCursor.value < runtime.sequentialCandidates.length) {
    const candidate = runtime.sequentialCandidates[runtime.sequentialCursor.value];
    runtime.sequentialCursor.value += 1;
    if (runtime.consumedImageItemKeys.has(candidate.imageItemKey)) continue;
    return candidate;
  }
  return null;
}

/**
 * 中文说明：把候选图与路径键建立绑定，后续同路径 token 会复用该候选。
 */
function bindHistoryInlineImageCandidateToPathKeys(
  candidate: HistoryInlineImageCandidate,
  tokenPathKeys: string[],
  boundCandidateByPathKey: Map<string, HistoryInlineImageCandidate>,
): void {
  for (const pathKey of [...candidate.pathKeys, ...tokenPathKeys]) {
    if (!pathKey) continue;
    boundCandidateByPathKey.set(pathKey, candidate);
  }
}

/**
 * 中文说明：隐藏候选图所属的整组图片项，并同步标记为已消费。
 * - 路径型图片会把相同归一化路径的全部独立 `IMAGE` 块一起隐藏；
 * - 无路径图片则至少隐藏自身，避免再次作为独立块出现。
 */
function hideHistoryInlineImageCandidateGroup(
  candidate: HistoryInlineImageCandidate,
  runtime: HistoryInlineImageResolverRuntime,
): void {
  runtime.hiddenImageItemKeys.add(candidate.imageItemKey);
  runtime.consumedImageItemKeys.add(candidate.imageItemKey);

  if (candidate.pathKeys.length === 0) return;
  for (const pathKey of candidate.pathKeys) {
    const groupedItemKeys = runtime.groupedImageItemKeysByPathKey.get(pathKey);
    if (!groupedItemKeys) continue;
    for (const imageItemKey of groupedItemKeys) {
      runtime.hiddenImageItemKeys.add(imageItemKey);
      runtime.consumedImageItemKeys.add(imageItemKey);
    }
  }
}

/**
 * 中文说明：判断单个文本项是否应整体隐藏。
 * - 目前仅在文本只剩 `</image>` 这类关闭占位符时隐藏；
 * - 其他 token 即使暂未匹配图片，也保留原文字，避免误伤正文。
 */
function shouldHideHistoryInlineTextItem(
  text: string,
  tokens: HistoryInlineImageTextToken[],
): boolean {
  if (tokens.length === 0) return false;
  let cursor = 0;
  for (const token of tokens) {
    const before = text.slice(cursor, token.start);
    if (before.trim().length > 0) return false;
    if (token.kind !== "image_close") return false;
    cursor = token.end;
  }
  return text.slice(cursor).trim().length === 0;
}

/**
 * 中文说明：在同一条消息内折叠“被后续更完整内容覆盖”的旧版图片占位符文本项。
 * - 仅折叠纯占位符文本，不隐藏带正文的真实输入内容；
 * - 若后续文本覆盖了当前图片标识（同标签/同路径/同占位符），则优先展示后面的聚合内容。
 */
function collectCollapsibleHistoryInlineTextItemKeys(
  entries: HistoryInlineImageTextEntry[],
): Set<string> {
  const out = new Set<string>();
  const descriptors = entries.map((entry) => describeHistoryInlineImageTextEntry(entry));

  for (let index = 0; index < descriptors.length; index += 1) {
    const current = descriptors[index];
    if (!current.isPlaceholderOnly) continue;
    if (current.signatures.size === 0) continue;

    for (let nextIndex = index + 1; nextIndex < descriptors.length; nextIndex += 1) {
      const next = descriptors[nextIndex];
      if (!doesHistoryInlineImageSignatureSetCover(next.signatures, current.signatures)) continue;
      if (!shouldCollapseHistoryInlineTextEntry(current, next)) continue;
      out.add(current.textItemKey);
      break;
    }
  }

  return out;
}

/**
 * 中文说明：在同一条消息内兜底隐藏旧格式图片卡片，避免 `<image>` 与 `[Image #n]` 同时重复展示。
 * - 仅在消息里确实存在旧式图片 token 时触发；
 * - 优先隐藏无本地路径、纯会话内恢复出来的图片块，减少误伤独立图片消息。
 */
function collectCollapsibleHistoryInlineImageItemKeys(
  imageEntries: HistoryInlineImageItemEntry[],
  textEntries: HistoryInlineImageTextEntry[],
): Set<string> {
  const out = new Set<string>();
  if (imageEntries.length === 0 || textEntries.length === 0) return out;

  const tokenStats = collectHistoryInlineImageMessageTokenStats(textEntries);
  if (!tokenStats.hasLegacyToken) return out;
  if (tokenStats.signatureCount === 0) return out;

  const preferredEntries = imageEntries.filter((entry) => !String(entry.image?.localPath || "").trim());
  const fallbackEntries = preferredEntries.length > 0 ? preferredEntries : imageEntries;
  const hideCount = Math.min(fallbackEntries.length, tokenStats.signatureCount);
  for (let index = 0; index < hideCount; index += 1) {
    const itemKey = fallbackEntries[index]?.imageItemKey;
    if (itemKey) out.add(itemKey);
  }
  return out;
}

type HistoryInlineImageTextEntryDescriptor = {
  textItemKey: string;
  normalizedText: string;
  signatures: Set<string>;
  visibleTextLength: number;
  isPlaceholderOnly: boolean;
};

/**
 * 中文说明：提炼文本项的可折叠特征，便于后续做轻量级覆盖判断。
 */
function describeHistoryInlineImageTextEntry(
  entry: HistoryInlineImageTextEntry,
): HistoryInlineImageTextEntryDescriptor {
  const visibleText = stripHistoryInlineImageTokenTexts(entry.text, entry.tokens).trim();
  return {
    textItemKey: entry.textItemKey,
    normalizedText: normalizeHistoryInlineImageTextForComparison(entry.text),
    signatures: collectHistoryInlineImageTokenSignatures(entry.tokens),
    visibleTextLength: visibleText.length,
    isPlaceholderOnly: visibleText.length === 0 && hasHistoryInlineImageRenderableToken(entry.tokens),
  };
}

type HistoryInlineImageMessageTokenStats = {
  hasLegacyToken: boolean;
  signatureCount: number;
};

/**
 * 中文说明：汇总单条消息中的图片 token 统计，用于决定是否隐藏旧格式独立图片卡片。
 */
function collectHistoryInlineImageMessageTokenStats(
  entries: HistoryInlineImageTextEntry[],
): HistoryInlineImageMessageTokenStats {
  const signatures = new Set<string>();
  let hasLegacyToken = false;

  for (const entry of entries) {
    for (const token of entry.tokens) {
      if (token.kind === "image_open" || token.kind === "image_label" || token.kind === "image_placeholder") {
        hasLegacyToken = true;
      }
      const signature = toHistoryInlineImageTokenSignature(token);
      if (signature) signatures.add(signature);
    }
  }

  return {
    hasLegacyToken,
    signatureCount: signatures.size,
  };
}

/**
 * 中文说明：判断后续文本项是否足以替代当前纯占位符项。
 * - 后续项只要覆盖当前全部图片标识，并且信息量不更少，即可隐藏当前占位符项；
 * - 这样可消除旧 Codex/Claude/Gemini 历史里被拆散的 `[Image #n]` 小框。
 */
function shouldCollapseHistoryInlineTextEntry(
  current: HistoryInlineImageTextEntryDescriptor,
  next: HistoryInlineImageTextEntryDescriptor,
): boolean {
  if (next.visibleTextLength > current.visibleTextLength) return true;
  if (next.signatures.size > current.signatures.size) return true;
  if (next.normalizedText === current.normalizedText) return true;
  return next.visibleTextLength === 0;
}

/**
 * 中文说明：判断文本项是否至少包含一个可展示的图片 token。
 */
function hasHistoryInlineImageRenderableToken(tokens: HistoryInlineImageTextToken[]): boolean {
  return tokens.some((token) => token.kind !== "image_close");
}

/**
 * 中文说明：提取文本项中的图片标识集合，用于比较“后续内容是否覆盖当前占位符”。
 */
function collectHistoryInlineImageTokenSignatures(
  tokens: HistoryInlineImageTextToken[],
): Set<string> {
  const out = new Set<string>();
  for (const token of tokens) {
    const signature = toHistoryInlineImageTokenSignature(token);
    if (signature) out.add(signature);
  }
  return out;
}

/**
 * 中文说明：为单个图片 token 生成稳定比较键，兼容路径、标签与旧版占位符。
 */
function toHistoryInlineImageTokenSignature(token: HistoryInlineImageTextToken): string {
  if (token.kind === "image_close") return "";
  if (token.kind === "path") {
    const pathKeys = buildHistoryImagePathKeys(token.path || token.rawText).sort();
    return pathKeys.length > 0 ? `path:${pathKeys[0]}` : "";
  }
  if (token.kind === "image_open" || token.kind === "image_label") {
    const labelKey = toHistoryInlineImageLabelKey(token.label || token.displayText || token.rawText);
    return labelKey ? `label:${labelKey}` : "";
  }
  if (token.kind === "image_placeholder") {
    const placeholderKey = toHistoryInlineImagePlaceholderKey(token.rawText);
    return placeholderKey ? `placeholder:${placeholderKey}` : "";
  }
  return "";
}

/**
 * 中文说明：判断后者的图片标识集合是否完整覆盖前者。
 */
function doesHistoryInlineImageSignatureSetCover(
  next: Set<string>,
  current: Set<string>,
): boolean {
  if (current.size === 0) return false;
  for (const signature of current) {
    if (!next.has(signature)) return false;
  }
  return true;
}

/**
 * 中文说明：移除文本中的图片 token 文本，仅保留真正可见的正文部分。
 */
function stripHistoryInlineImageTokenTexts(
  text: string,
  tokens: HistoryInlineImageTextToken[],
): string {
  if (tokens.length === 0) return String(text || "");

  let cursor = 0;
  let out = "";
  for (const token of tokens) {
    if (token.start > cursor) out += text.slice(cursor, token.start);
    cursor = Math.max(cursor, token.end);
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}

/**
 * 中文说明：将文本压平成稳定的比较值，避免空白差异影响重复项折叠。
 */
function normalizeHistoryInlineImageTextForComparison(value?: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/**
 * 中文说明：提取文本中的所有图片相关 token，并做重叠去重。
 */
function extractHistoryInlineImageTokens(text?: string): HistoryInlineImageTextToken[] {
  try {
    const source = String(text || "");
    if (!source) return [];

    const candidates: HistoryInlineImageTextToken[] = [];
    pushHistoryInlineImagePathTokens(source, candidates);
    pushHistoryInlineImageOpenTokens(source, candidates);
    pushHistoryInlineImageCloseTokens(source, candidates);
    pushHistoryInlineImagePlaceholderTokens(source, candidates);
    pushHistoryInlineImageLabelTokens(source, candidates);

    return filterOverlappingHistoryInlineImageTokens(candidates);
  } catch {
    return [];
  }
}

/**
 * 中文说明：提取文本内真实图片路径 token。
 */
function pushHistoryInlineImagePathTokens(
  source: string,
  out: HistoryInlineImageTextToken[],
): void {
  let match: RegExpExecArray | null;
  IMAGE_PATH_PATTERN.lastIndex = 0;
  while ((match = IMAGE_PATH_PATTERN.exec(source)) !== null) {
    const captured = String(match[1] || "");
    const normalizedPath = normalizeHistoryImagePathCandidate(captured);
    if (!normalizedPath) continue;

    const fullMatch = String(match[0] || "");
    const capturedOffset = fullMatch.indexOf(captured);
    const start = match.index + Math.max(0, capturedOffset);
    const end = start + captured.length;
    out.push({
      kind: "path",
      rawText: captured,
      displayText: captured,
      start,
      end,
      path: normalizedPath,
    });
  }
}

/**
 * 中文说明：提取旧版 `<image name=[...]>` 打开占位符。
 */
function pushHistoryInlineImageOpenTokens(
  source: string,
  out: HistoryInlineImageTextToken[],
): void {
  let match: RegExpExecArray | null;
  IMAGE_OPEN_TAG_PATTERN.lastIndex = 0;
  while ((match = IMAGE_OPEN_TAG_PATTERN.exec(source)) !== null) {
    const label = String(match[1] || "").trim();
    const rawText = String(match[0] || "");
    out.push({
      kind: "image_open",
      rawText,
      displayText: label ? `[${label}]` : rawText,
      start: match.index,
      end: match.index + rawText.length,
      label: label ? `[${label}]` : "",
    });
  }
}

/**
 * 中文说明：提取旧版 `</image>` 关闭占位符。
 */
function pushHistoryInlineImageCloseTokens(
  source: string,
  out: HistoryInlineImageTextToken[],
): void {
  let match: RegExpExecArray | null;
  IMAGE_CLOSE_TAG_PATTERN.lastIndex = 0;
  while ((match = IMAGE_CLOSE_TAG_PATTERN.exec(source)) !== null) {
    const rawText = String(match[0] || "");
    out.push({
      kind: "image_close",
      rawText,
      displayText: "",
      start: match.index,
      end: match.index + rawText.length,
    });
  }
}

/**
 * 中文说明：提取 `[image 965x458 PNG]` 这类旧版尺寸占位符。
 */
function pushHistoryInlineImagePlaceholderTokens(
  source: string,
  out: HistoryInlineImageTextToken[],
): void {
  let match: RegExpExecArray | null;
  IMAGE_PLACEHOLDER_PATTERN.lastIndex = 0;
  while ((match = IMAGE_PLACEHOLDER_PATTERN.exec(source)) !== null) {
    const rawText = String(match[0] || "");
    out.push({
      kind: "image_placeholder",
      rawText,
      displayText: rawText,
      start: match.index,
      end: match.index + rawText.length,
    });
  }
}

/**
 * 中文说明：提取 `[Image #1]` 这类旧版标签占位符。
 */
function pushHistoryInlineImageLabelTokens(
  source: string,
  out: HistoryInlineImageTextToken[],
): void {
  let match: RegExpExecArray | null;
  IMAGE_LABEL_PATTERN.lastIndex = 0;
  while ((match = IMAGE_LABEL_PATTERN.exec(source)) !== null) {
    const label = String(match[1] || "").trim();
    const rawText = String(match[0] || "");
    out.push({
      kind: "image_label",
      rawText,
      displayText: rawText,
      start: match.index,
      end: match.index + rawText.length,
      label: label ? `[${label}]` : rawText,
    });
  }
}

/**
 * 中文说明：过滤重叠 token，优先保留范围更大的高优先级 token。
 */
function filterOverlappingHistoryInlineImageTokens(
  tokens: HistoryInlineImageTextToken[],
): HistoryInlineImageTextToken[] {
  const sorted = [...tokens].sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    const lengthDiff = (right.end - right.start) - (left.end - left.start);
    if (lengthDiff !== 0) return lengthDiff;
    return getHistoryInlineImageTokenPriority(right.kind) - getHistoryInlineImageTokenPriority(left.kind);
  });

  const out: HistoryInlineImageTextToken[] = [];
  for (const token of sorted) {
    const hasOverlap = out.some((existing) => token.start < existing.end && token.end > existing.start);
    if (hasOverlap) continue;
    out.push(token);
  }
  return out.sort((left, right) => left.start - right.start);
}

/**
 * 中文说明：返回 token 冲突时的优先级。
 */
function getHistoryInlineImageTokenPriority(kind: HistoryInlineImageTokenKind): number {
  switch (kind) {
    case "image_open":
      return 5;
    case "image_close":
      return 4;
    case "path":
      return 3;
    case "image_placeholder":
      return 2;
    case "image_label":
      return 1;
    default:
      return 0;
  }
}

/**
 * 中文说明：判断某条解析结果是否对应当前渲染 token。
 */
function doesHistoryInlineImageMatchToken(
  match: HistoryInlineImageMatch,
  token: HistoryInlineImageTextToken,
): boolean {
  if (match.kind !== token.kind) return false;

  if (token.kind === "path") {
    return pathKeysIntersect(
      buildHistoryImagePathKeys(match.path || match.tokenText),
      buildHistoryImagePathKeys(token.path || token.rawText),
    );
  }

  if (token.kind === "image_open" || token.kind === "image_label") {
    return toHistoryInlineImageLabelKey(match.label || match.displayText || match.tokenText)
      === toHistoryInlineImageLabelKey(token.label || token.displayText || token.rawText);
  }

  if (token.kind === "image_placeholder") {
    return toHistoryInlineImagePlaceholderKey(match.tokenText) === toHistoryInlineImagePlaceholderKey(token.rawText);
  }

  return false;
}

/**
 * 中文说明：渲染单个“文本 token + 小图”行内片段。
 */
function HistoryInlineImageToken({ displayText, image }: { displayText: string; image: MessageContent }) {
  const primarySrc = String(image?.src || "").trim();
  const fallbackSrc = String(image?.fallbackSrc || "").trim();
  const { openContextMenu: openImageContextMenu, contextMenuNode } = useHistoryImageContextMenu({
    src: primarySrc,
    fallbackSrc,
    localPath: image.localPath,
  });
  const dialogMetaLines = [
    image.localPath ? `路径: ${image.localPath}` : "",
    image.mimeType ? `类型: ${image.mimeType}` : "",
    fallbackSrc ? "回退: 会话内图片数据" : "",
  ].filter((line) => String(line || "").trim().length > 0);

  return (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      <span className="break-all whitespace-pre-wrap font-mono text-[0.95em]">{displayText}</span>
      <InteractiveImagePreview
        src={primarySrc}
        fallbackSrc={fallbackSrc}
        alt={image.localPath || displayText || "history image"}
        dialogTitle={image.localPath || displayText || "图片"}
        dialogDescription={image.mimeType || undefined}
        dialogMeta={dialogMetaLines.length > 0 ? (
          <div className="space-y-1">
            {dialogMetaLines.map((line, index) => (
              <div key={`${image.localPath || displayText}-dialog-meta-${index}`} className="break-all whitespace-pre-wrap">{line}</div>
            ))}
          </div>
        ) : undefined}
      >
        {({ hasPreview, hoverTriggerProps, openDialog, imageProps }) => (
          hasPreview ? (
            <button
              type="button"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] align-middle transition-transform duration-apple-fast hover:scale-[1.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/35"
              onMouseEnter={hoverTriggerProps.onMouseEnter}
              onMouseLeave={hoverTriggerProps.onMouseLeave}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openDialog();
              }}
              onContextMenu={openImageContextMenu}
              title="预览图片"
            >
              <img {...imageProps} className="block h-full w-full object-cover" />
            </button>
          ) : null
        )}
      </InteractiveImagePreview>
      {contextMenuNode}
    </span>
  );
}

/**
 * 中文说明：规范化历史中的图片路径文本，去除 Gemini `@` 前缀与常见包裹符号。
 */
function normalizeHistoryImagePathCandidate(value?: string): string {
  let raw = String(value || "").trim();
  if (!raw) return "";
  raw = raw.replace(/^@+/, "").trim();
  raw = raw.replace(/^`+|`+$/g, "").trim();
  raw = raw.replace(/^"+|"+$/g, "").trim();
  raw = raw.replace(/^'+|'+$/g, "").trim();
  return raw;
}

/**
 * 中文说明：对历史图片 `file:///` 地址做轻量编码，避免空格与保留字符破坏 URL 语义。
 */
function encodeHistoryInlineImageFileUrlPath(value?: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return encodeURI(raw).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

/**
 * 中文说明：将历史里的本地路径转为可用于浏览器预览的主地址。
 * - Windows 盘符优先转为 `file:///C:/...`；
 * - `/mnt/<drive>/...` 优先映射为 Windows 盘符地址，兼容 Windows 侧 Electron；
 * - 其他 POSIX 绝对路径保持原样，兼容 WSL/Linux 侧运行。
 */
function toHistoryInlineImagePreviewSrc(value?: string): string {
  const raw = normalizeHistoryImagePathCandidate(value);
  if (!raw) return "";
  if (/^(?:data:image\/|blob:|file:\/\/)/i.test(raw)) return raw;

  const windowsMatch = raw.match(/^([A-Za-z]):[\\/](.*)$/);
  if (windowsMatch?.[1]) {
    const drive = windowsMatch[1].toUpperCase();
    const rest = String(windowsMatch[2] || "").replace(/\\/g, "/");
    return `file:///${encodeHistoryInlineImageFileUrlPath(`${drive}:/${rest}`)}`;
  }

  if (raw.startsWith("//")) return `file:${encodeHistoryInlineImageFileUrlPath(raw)}`;
  if (raw.startsWith("/")) return `file://${encodeHistoryInlineImageFileUrlPath(raw)}`;
  return "";
}

/**
 * 中文说明：为 `/mnt/<drive>/...` 这类路径提供备用预览地址，兼容不同运行环境。
 */
function toHistoryInlineImageFallbackSrc(value?: string): string {
  const raw = normalizeHistoryImagePathCandidate(value);
  if (!raw) return "";
  const mntMatch = raw.match(/^\/mnt\/([A-Za-z])\/(.*)$/);
  if (mntMatch?.[1]) {
    const drive = mntMatch[1].toUpperCase();
    const rest = String(mntMatch[2] || "");
    return `file:///${encodeHistoryInlineImageFileUrlPath(`${drive}:/${rest}`)}`;
  }

  const windowsMatch = raw.match(/^([A-Za-z]):[\\/](.*)$/);
  if (windowsMatch?.[1]) {
    const drive = windowsMatch[1].toLowerCase();
    const rest = String(windowsMatch[2] || "").replace(/\\/g, "/");
    return `file://${encodeHistoryInlineImageFileUrlPath(`/mnt/${drive}/${rest}`)}`;
  }

  return "";
}

/**
 * 中文说明：根据扩展名推断历史图片 MIME，用于大图弹窗显示紧凑元信息。
 */
function inferHistoryInlineImageMimeType(value?: string): string {
  const raw = normalizeHistoryImagePathCandidate(value).toLowerCase();
  if (raw.endsWith(".jpg") || raw.endsWith(".jpeg")) return "image/jpeg";
  if (raw.endsWith(".webp")) return "image/webp";
  if (raw.endsWith(".gif")) return "image/gif";
  if (raw.endsWith(".bmp")) return "image/bmp";
  if (raw.endsWith(".svg")) return "image/svg+xml";
  if (raw.endsWith(".png")) return "image/png";
  return "";
}

/**
 * 中文说明：在缺少后端图片内容项时，直接根据路径 token 构造只读预览对象。
 * - 仅服务于历史详情渲染，不参与消息归档；
 * - 优先使用适合当前平台的 `file:///` 地址，并为 `/mnt/<drive>/...` 提供兼容回退。
 */
function buildHistoryInlineImageContentFromPath(value?: string): MessageContent | null {
  const localPath = normalizeHistoryImagePathCandidate(value);
  if (!localPath) return null;

  const primarySrc = toHistoryInlineImagePreviewSrc(localPath);
  if (!primarySrc) return null;

  const fallbackSrc = toHistoryInlineImageFallbackSrc(localPath);
  const mimeType = inferHistoryInlineImageMimeType(localPath);
  const textLines = ["图片", `路径: ${localPath}`];
  if (mimeType) textLines.push(`类型: ${mimeType}`);
  if (fallbackSrc && fallbackSrc !== primarySrc) textLines.push("回退: 路径兼容预览");

  return {
    type: "image",
    text: textLines.join("\n"),
    src: primarySrc,
    fallbackSrc: fallbackSrc && fallbackSrc !== primarySrc ? fallbackSrc : undefined,
    localPath,
    mimeType: mimeType || undefined,
  };
}

/**
 * 中文说明：为路径型 token 合并“后端图片项 + 路径直连预览”的双保险结果。
 * - 若已命中旧缓存中的图片项，优先保留其主图地址；
 * - 同时把当前路径生成的本地预览地址挂成回退，避免旧缓存中的坏图地址导致裂图；
 * - 文本里的真实路径优先作为 `localPath` 展示，保证详情信息稳定。
 */
function mergeHistoryInlineImageWithPathFallback(
  image: MessageContent,
  pathValue?: string,
): MessageContent {
  const pathImage = buildHistoryInlineImageContentFromPath(pathValue);
  if (!pathImage) return image;

  const primarySrc = String(image?.src || "").trim() || String(pathImage.src || "").trim();
  const fallbackCandidates = [
    String(pathImage.src || "").trim(),
    String(pathImage.fallbackSrc || "").trim(),
    String(image?.fallbackSrc || "").trim(),
  ].filter((candidate, index, list) => candidate.length > 0 && candidate !== primarySrc && list.indexOf(candidate) === index);

  return {
    ...pathImage,
    ...image,
    src: primarySrc,
    fallbackSrc: fallbackCandidates[0] || undefined,
    localPath: pathImage.localPath || image.localPath,
    mimeType: image.mimeType || pathImage.mimeType,
  };
}

/**
 * 中文说明：为路径生成一组可互相映射的归一化键，兼容 Windows 与 `/mnt/x/` 互转场景。
 */
function buildHistoryImagePathKeys(value?: string): string[] {
  const raw = normalizeHistoryImagePathCandidate(value);
  if (!raw) return [];

  const out = new Set<string>();
  const push = (candidate?: string) => {
    const key = toHistoryImagePathKey(candidate);
    if (key) out.add(key);
  };

  push(raw);

  const windowsMatch = raw.match(/^([A-Za-z]):[\\/](.*)$/);
  if (windowsMatch?.[1]) {
    const drive = windowsMatch[1].toLowerCase();
    const rest = String(windowsMatch[2] || "").replace(/\\/g, "/");
    push(`/mnt/${drive}/${rest}`);
  }

  const mntMatch = raw.match(/^\/mnt\/([A-Za-z])\/(.*)$/);
  if (mntMatch?.[1]) {
    const drive = mntMatch[1].toUpperCase();
    const rest = String(mntMatch[2] || "").replace(/\//g, "\\");
    push(`${drive}:\\${rest}`);
  }

  return Array.from(out);
}

/**
 * 中文说明：将路径候选归一化为可比较的键。
 */
function toHistoryImagePathKey(value?: string): string {
  const raw = normalizeHistoryImagePathCandidate(value);
  if (!raw) return "";
  return raw.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

/**
 * 中文说明：将旧版图片标签归一化为稳定键。
 */
function toHistoryInlineImageLabelKey(value?: string): string {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 中文说明：将旧版尺寸占位符归一化为稳定键。
 */
function toHistoryInlineImagePlaceholderKey(value?: string): string {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 中文说明：删除文本中的 `</image>` 关闭占位符。
 */
function stripHistoryInlineImageCloseTags(value?: string): string {
  return String(value || "").replace(IMAGE_CLOSE_TAG_PATTERN, "");
}

/**
 * 中文说明：判断两组路径键是否存在交集。
 */
function pathKeysIntersect(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  for (const item of left) {
    if (rightSet.has(item)) return true;
  }
  return false;
}
