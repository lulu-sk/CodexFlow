// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

type GeminiAttachmentChipLike = {
  chipKind?: string;
  type?: string;
  fileName?: string;
};

type GeminiTerminalMode = "wsl" | "windows" | "pwsh";

/**
 * 中文说明：判断当前 Chip 是否应按 Gemini 图片附件语义发送。
 */
export function isGeminiImageChip(chip: GeminiAttachmentChipLike | null | undefined): boolean {
  if (!chip) return false;
  if (String(chip.chipKind || "").trim().toLowerCase() === "image") return true;
  return String(chip.type || "").trim().toLowerCase().startsWith("image/");
}

/**
 * 中文说明：按 Gemini CLI 的 `@path` 约定转义路径。
 */
export function escapeGeminiAttachmentPath(pathText: string, terminalMode: GeminiTerminalMode): string {
  const raw = String(pathText || "");
  if (!raw) return "";
  if (terminalMode === "windows" || terminalMode === "pwsh") {
    if (/[\s&()[\]{}^=;!'+,`~%$@#]/.test(raw)) return `"${raw}"`;
    return raw;
  }
  return raw.replace(/([ \t()[\]{};|*?$`'"#&<>!~\\])/g, "\\$1");
}

/**
 * 中文说明：将 Gemini 图片路径序列化为 `@path` 语法；空路径时返回空串。
 */
export function buildGeminiImageAttachmentToken(pathText: string, terminalMode: GeminiTerminalMode): string {
  const escaped = escapeGeminiAttachmentPath(pathText, terminalMode);
  return escaped ? `@${escaped}` : "";
}
