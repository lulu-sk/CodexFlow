// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 清理从日志/设置中得到的路径候选：
 * - 去除首尾空白与包裹引号
 * - 折叠 JSON 转义反斜杠（例如 C:\\code -> C:\code）
 * - 去除尾部分隔符
 */
export function tidyPathCandidate(value: string): string {
  try {
    let s = String(value || "")
      .replace(/\\n/g, "")
      .replace(/^"|"$/g, "")
      .replace(/^'|'$/g, "")
      .trim();
    s = s.replace(/\\\\/g, "\\").trim();
    s = s.replace(/[\\/]+$/g, "");
    return s;
  } catch {
    return String(value || "").trim();
  }
}

/**
 * Gemini projectHash 的计算通常基于“绝对路径字符串（无尾部斜杠）”，因此需先做规范化。
 */
export function normalizeGeminiPathForHash(p: string): string {
  const s = tidyPathCandidate(p).replace(/\\/g, "/");
  return s.replace(/\/+/g, "/").replace(/\/+$/, "");
}

/**
 * 提取 Gemini 会话文件路径中的 projectHash（匹配 ~/.gemini/tmp/<hash>/...）。
 */
export function extractGeminiProjectHashFromPath(filePath: string): string | null {
  try {
    const s = String(filePath || "").replace(/\\/g, "/");
    const m = s.match(/\/\.gemini\/tmp\/([0-9a-fA-F]{32,64})(?:\/|$)/);
    if (m?.[1]) return m[1].toLowerCase();
    return null;
  } catch {
    return null;
  }
}

/**
 * 在浏览器侧计算 SHA-256，并输出小写 hex（用于对齐主进程的 projectHash 规则）。
 */
export async function sha256Hex(text: string): Promise<string> {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return "";
    const encoded = new TextEncoder().encode(String(text || ""));
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex.toLowerCase();
  } catch {
    return "";
  }
}

