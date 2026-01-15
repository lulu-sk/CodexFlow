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

