// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 规范化单行文本（用于预览过滤）：去除首尾空白与成对包裹符。
 */
function normalizeLineHeadForPreview(value: string): string {
  try {
    let text = String(value || "").trim();
    const stripPairs = (ch: string) => {
      if (text.startsWith(ch) && text.endsWith(ch) && text.length >= 2) text = text.slice(1, -1).trim();
    };
    stripPairs("`");
    stripPairs("\"");
    stripPairs("'");
    return text;
  } catch {
    return String(value || "").trim();
  }
}

/**
 * 判断一行是否为路径行（用于预览过滤）：
 * - 绝对路径：
 *   - Windows 盘符：C:\ 或 C:/ 开头
 *   - WSL UNC：\\wsl.localhost\Distro\... 或 //wsl.localhost/Distro/...
 *   - 旧式 WSL 共享：\\wsl$\Distro\...
 *   - /mnt/<drive>/... 或其他以 / 开头的 POSIX 根
 *   - file: URI（file:/C:/..., file:///mnt/c/... 等）
 * - 相对路径：
 *   - 显式相对：./、../、.\、..\ 开头
 *   - 无空格的多段相对路径（允许中英文、数字、下划线、点、连字符）
 */
export function isWinOrWslPathLineForPreview(line: string): boolean {
  try {
    const text = normalizeLineHeadForPreview(line);
    if (!text) return false;

    if (/^file:\//i.test(text)) {
      if (/^file:\/+[A-Za-z]:[\\/]/i.test(text)) return true;
      if (/^file:\/+wsl\.localhost\//i.test(text)) return true;
      if (/^file:\/+mnt\/[a-zA-Z]\//i.test(text)) return true;
    }
    if (/^[A-Za-z]:[\\/]/.test(text)) return true;
    if (/^\\\\wsl\.localhost\\[^\\\s]+\\/.test(text)) return true;
    if (/^\\\\wsl\$\\[^\\\s]+\\/.test(text)) return true;
    if (/^\/\/wsl\.localhost\/[^\s/]+\//.test(text)) return true;
    if (/^\/mnt\/[a-zA-Z]\//.test(text)) return true;
    if (/^\//.test(text)) return true;

    if (/^\.{1,2}[\\/]/.test(text)) return true;

    try {
      const reU = new RegExp("^[\\p{L}\\p{N}._-]+(?:[\\\\/][\\p{L}\\p{N}._-]+)+$", "u");
      if (reU.test(text)) return true;
    } catch {}
    if (/^[A-Za-z0-9._-\u4E00-\u9FFF]+(?:[\\/][A-Za-z0-9._-\u4E00-\u9FFF]+)+$/.test(text)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 过滤历史预览文本：
 * - 按行拆分，跳过空行与路径行，返回首个有效内容行（trim 后）。
 * - 若找不到有效内容，返回空串。
 */
export function filterHistoryPreviewText(raw: string): string {
  try {
    const lines = String(raw || "").split(/\r?\n/);
    for (const line of lines) {
      if (!line || /^\s*$/.test(line)) continue;
      if (isWinOrWslPathLineForPreview(line)) continue;
      return normalizeLineHeadForPreview(line);
    }
    return "";
  } catch {
    return "";
  }
}

type CodexInternalContextParts = {
  rest: string;
  objective: string;
};

/**
 * 从 Codex goal 内部上下文中提取用户目标摘要。
 */
function extractCodexGoalObjectiveText(inner: string): string {
  try {
    const matched = String(inner || "").match(/<objective>\s*([\s\S]*?)(?:<\/objective>|$)/i);
    if (!matched?.[1]) return "";
    return filterHistoryPreviewText(matched[1]);
  } catch {
    return "";
  }
}

/**
 * 拆分 Codex goal 模式注入的内部上下文前缀，保留后续真实用户内容并记录 objective 兜底摘要。
 */
function extractLeadingCodexInternalContext(raw: string): CodexInternalContextParts {
  const text = String(raw || "").replace(/\r\n/g, "\n");
  const trimmed = text.trimStart();
  if (!/^<codex_internal_context\b/i.test(trimmed)) return { rest: text, objective: "" };
  const matched = trimmed.match(/^<codex_internal_context\b[^>]*>([\s\S]*?)<\/codex_internal_context>\s*/i);
  if (!matched) return { rest: "", objective: "" };
  return {
    rest: trimmed.slice(matched[0].length),
    objective: extractCodexGoalObjectiveText(matched[1] || ""),
  };
}

/**
 * 过滤 Codex 历史预览文本：
 * - 优先提取官方 Codex “Files mentioned” 模板里的真实请求段；
 * - 非模板内容继续沿用通用预览过滤策略。
 */
export function filterCodexHistoryPreviewText(raw: string): string {
  try {
    const internalContext = extractLeadingCodexInternalContext(String(raw || "").replace(/\r\n/g, "\n"));
    const text = internalContext.rest.trim() ? internalContext.rest : internalContext.objective;
    const marker = text.match(/^##\s*My request for Codex:?\s*$/im);
    if (marker && typeof marker.index === "number") {
      const request = text.slice(marker.index + marker[0].length).trim();
      const cleaned = request.replace(/```[\s\S]*?```/g, "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
      if (cleaned) return cleaned;
    }
    if (/^#\s*Files mentioned by the user:/i.test(text.trim())) return "";
    if (/^#\s*AGENTS\.md instructions\b/i.test(text.trim())) return "";
    if (/^<environment_context>/i.test(text.trim())) return "";
    if (/^<turn_aborted>/i.test(text.trim())) return "";
    if (/^Another language model started to solve this problem\b/i.test(text.trim())) return "";
    return filterHistoryPreviewText(text) || internalContext.objective;
  } catch {
    return filterHistoryPreviewText(String(raw || ""));
  }
}

