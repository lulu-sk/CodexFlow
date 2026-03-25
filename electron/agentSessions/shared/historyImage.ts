// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import path from "node:path";
import type { MessageContent } from "../../history";
import { isUNCPath, normalizeWinPath, uncToWsl } from "../../wsl";

export type HistoryImageContentOptions = {
  localPath?: string;
  mimeType?: string;
  dataUrl?: string;
  base64Data?: string;
  text?: string;
  tags?: string[];
  preferDataUrl?: boolean;
};

const IMAGE_PATH_PATTERN = /@?((?:[A-Za-z]:(?:\\|\/)|\/mnt\/[A-Za-z]\/|\/(?:home|root|Users)\/|\\\\[^\\\/\r\n]+\\[^\\\/\r\n]+\\)[^\r\n]*?\.(?:png|jpe?g|webp|gif|bmp|svg))/gi;

/**
 * 中文说明：从文本中提取图片绝对路径候选。
 * - 仅匹配常见绝对路径前缀，避免把普通文案误判成路径；
 * - 以图片扩展名为终点，兼容 Gemini `@path.png 提示词` 这类格式。
 */
export function extractImagePathCandidatesFromText(text?: string): string[] {
  try {
    const source = String(text || "");
    if (!source) return [];
    const out: string[] = [];
    let match: RegExpExecArray | null;
    IMAGE_PATH_PATTERN.lastIndex = 0;
    while ((match = IMAGE_PATH_PATTERN.exec(source)) !== null) {
      const normalized = normalizeImagePathCandidate(match[1]);
      if (normalized && !out.includes(normalized)) out.push(normalized);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 中文说明：构造历史图片内容项。
 * - 路径有效时优先返回本地 `file:///` 预览地址；
 * - 路径失效但存在会话内 Base64/Data URL 时，回退为 data URL；
 * - 同时保留 `fallbackSrc`，供前端在本地文件失效时无状态回退。
 */
export function createHistoryImageContent(options: HistoryImageContentOptions): MessageContent | null {
  const localPath = normalizeImagePathCandidate(options.localPath);
  const mimeType = normalizeMimeType(options.mimeType) || inferMimeTypeFromPath(localPath) || inferMimeTypeFromDataUrl(options.dataUrl);
  const dataUrl = buildImageDataUrl(options.dataUrl, options.base64Data, mimeType);
  const hasLocalFile = !!localPath && historyImagePathExists(localPath);
  const preferDataUrl = !!options.preferDataUrl && !!dataUrl;
  const primarySrc = preferDataUrl
    ? dataUrl
    : (hasLocalFile ? toHistoryImagePreviewUrl(localPath) : dataUrl);
  const fallbackSrc = preferDataUrl
    ? (hasLocalFile ? toHistoryImagePreviewUrl(localPath) : "")
    : (hasLocalFile ? dataUrl : "");
  if (!primarySrc) return null;

  const content: MessageContent = {
    type: "image",
    text: buildHistoryImageText({
      localPath,
      mimeType,
      hasSessionFallback: !!fallbackSrc,
      explicitText: options.text,
    }),
    src: primarySrc,
    localPath: localPath || undefined,
    mimeType: mimeType || undefined,
  };
  const tags = Array.isArray(options.tags) ? options.tags.filter((tag) => String(tag || "").trim().length > 0) : [];
  if (tags.length > 0) content.tags = Array.from(new Set(tags));
  if (fallbackSrc && fallbackSrc !== primarySrc) content.fallbackSrc = fallbackSrc;
  return content;
}

/**
 * 中文说明：将本地图片路径转为可直接用于渲染层的 `file:///` 地址。
 */
export function toHistoryImagePreviewUrl(localPath?: string): string {
  const raw = normalizeImagePathCandidate(localPath);
  if (!raw) return "";
  if (/^file:\/\//i.test(raw)) return raw;
  const mntWinPath = process.platform === "win32" ? mntPathToWindowsPath(raw) : "";
  if (mntWinPath) return `file:///${encodeFileUrlSegment(mntWinPath.replace(/\\/g, "/"))}`;
  const winPath = normalizeWinPath(raw);
  if (isUNCPath(winPath)) {
    const normalized = encodeFileUrlSegment(winPath.replace(/\\/g, "/"));
    return normalized.startsWith("//") ? `file:${normalized}` : `file://${normalized.replace(/^\/+/, "")}`;
  }
  if (/^[a-zA-Z]:[\\/]/.test(winPath)) {
    return `file:///${encodeFileUrlSegment(winPath.replace(/\\/g, "/"))}`;
  }
  if (raw.startsWith("/")) {
    return `file://${encodeFileUrlSegment(raw)}`;
  }
  return "";
}

/**
 * 中文说明：判断图片路径当前是否仍可从文件系统读取。
 * - 先尝试原始路径；
 * - 再尝试 WSL 可访问的等价路径，兼容在 WSL 测试环境中读取 Windows 路径。
 */
export function historyImagePathExists(localPath?: string): boolean {
  const candidates = buildFsPathCandidates(localPath);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return true;
    } catch {}
  }
  return false;
}

/**
 * 中文说明：规范化图片路径候选，移除常见包裹符号与 Gemini `@` 前缀。
 */
function normalizeImagePathCandidate(value?: string): string {
  try {
    let raw = String(value || "").trim();
    if (!raw) return "";
    raw = raw.replace(/^@+/, "").trim();
    raw = raw.replace(/^`+|`+$/g, "").trim();
    raw = raw.replace(/^"+|"+$/g, "").trim();
    raw = raw.replace(/^'+|'+$/g, "").trim();
    return raw;
  } catch {
    return String(value || "").trim();
  }
}

/**
 * 中文说明：为文件存在性检测生成一组可访问路径候选。
 */
function buildFsPathCandidates(localPath?: string): string[] {
  const raw = normalizeImagePathCandidate(localPath);
  if (!raw) return [];

  const out = new Set<string>();
  const push = (value?: string) => {
    const next = String(value || "").trim();
    if (next) out.add(next);
  };

  push(raw);
  const winPath = normalizeWinPath(raw);
  push(winPath);
  push(mntPathToWindowsPath(raw));

  if (isUNCPath(winPath)) {
    const unc = uncToWsl(winPath);
    if (unc?.wslPath) push(unc.wslPath);
  }

  const driveMatch = winPath.match(/^([a-zA-Z]):\\(.*)$/);
  if (driveMatch?.[1]) {
    const drive = driveMatch[1].toLowerCase();
    const rest = String(driveMatch[2] || "").replace(/\\/g, "/");
    push(`/mnt/${drive}/${rest}`);
  }

  return Array.from(out);
}

/**
 * 中文说明：将 `/mnt/<drive>/...` 转为 Windows 盘符路径，便于 Windows 进程访问真实文件。
 */
function mntPathToWindowsPath(localPath?: string): string {
  const raw = normalizeImagePathCandidate(localPath);
  if (!raw) return "";

  const match = raw.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
  if (!match?.[1]) return "";

  const drive = match[1].toUpperCase();
  const rest = String(match[2] || "").replace(/\//g, "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

/**
 * 中文说明：构造图片项的搜索/导出文案，避免把 Base64 正文写入历史文本。
 */
function buildHistoryImageText(args: { localPath?: string; mimeType?: string; hasSessionFallback: boolean; explicitText?: string }): string {
  const explicit = String(args.explicitText || "").trim();
  if (explicit) return explicit;

  const lines = ["图片"];
  if (args.localPath) lines.push(`路径: ${args.localPath}`);
  if (args.mimeType) lines.push(`类型: ${args.mimeType}`);
  if (args.hasSessionFallback) lines.push("回退: 会话内图片数据");
  return lines.join("\n");
}

/**
 * 中文说明：构造 data URL；若已传入完整 data URL，则直接复用。
 */
function buildImageDataUrl(dataUrl?: string, base64Data?: string, mimeType?: string): string {
  const direct = String(dataUrl || "").trim();
  if (/^data:image\//i.test(direct)) return direct;
  const base64 = String(base64Data || "").trim();
  if (!base64) return "";
  const normalizedMime = normalizeMimeType(mimeType) || "image/png";
  return `data:${normalizedMime};base64,${base64}`;
}

/**
 * 中文说明：根据路径扩展名推断图片 MIME。
 */
function inferMimeTypeFromPath(localPath?: string): string {
  const ext = path.extname(String(localPath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  return "";
}

/**
 * 中文说明：从 data URL 头部推断 MIME。
 */
function inferMimeTypeFromDataUrl(dataUrl?: string): string {
  const raw = String(dataUrl || "").trim();
  const match = raw.match(/^data:([^;,]+)[;,]/i);
  return normalizeMimeType(match?.[1]) || "";
}

/**
 * 中文说明：规范化 MIME，确保只接受图片类型。
 */
function normalizeMimeType(value?: string): string {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw.startsWith("image/")) return "";
  return raw;
}

/**
 * 中文说明：对文件 URL 路径段做安全编码，避免空格、`#`、`?` 破坏地址语义。
 */
function encodeFileUrlSegment(value: string): string {
  return encodeURI(String(value || "")).replace(/#/g, "%23").replace(/\?/g, "%3F");
}
