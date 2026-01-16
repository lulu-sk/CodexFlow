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
 * 将路径规范化为更接近 Windows 侧 projectHash 计算的输入：
 * - 分隔符统一为反斜杠
 * - 折叠重复分隔符（保留 UNC 起始双反斜杠）
 * - 去除尾部分隔符
 */
function normalizeGeminiWinPathForHash(p: string): string {
  try {
    let s = tidyPathCandidate(p).replace(/\//g, "\\");
    if (!s) return "";
    if (s.startsWith("\\\\")) {
      s = "\\\\" + s.slice(2).replace(/\\{2,}/g, "\\");
    } else {
      s = s.replace(/\\{2,}/g, "\\");
    }
    s = s.replace(/\\+$/, "");
    return s;
  } catch {
    return tidyPathCandidate(p);
  }
}

/**
 * 根据“项目绝对路径字符串”生成 Gemini projectHash 的输入候选（未做哈希）。
 *
 * 兼容点：
 * - Windows：盘符大小写差异、`/` 与 `\\` 分隔符差异
 * - UNC：`\\\\server\\share\\...`
 * - POSIX：仅做 `/` 规范化；若为 `/mnt/<drive>/...` 额外派生盘符路径
 */
export function deriveGeminiProjectHashInputCandidatesFromPath(pathCandidate: string): string[] {
  try {
    const raw = typeof pathCandidate === "string" ? pathCandidate.trim() : "";
    if (!raw) return [];
    const base = tidyPathCandidate(raw);
    if (!base) return [];

    const forms = new Set<string>();
    const add = (v: string) => {
      const t = tidyPathCandidate(v);
      if (!t) return;
      forms.add(t);
    };

    add(base);

    const baseSlash = base.replace(/\\/g, "/");
    const isDrive = /^[a-zA-Z]:\//.test(baseSlash);
    const isUNC = base.startsWith("\\\\") || baseSlash.startsWith("//");
    const isPosix = base.startsWith("/");

    if (isPosix) {
      add(normalizeGeminiPathForHash(base));
      const m = base.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
      if (m) add(`${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`);
    } else if (isDrive || isUNC) {
      add(normalizeGeminiPathForHash(base));
      add(normalizeGeminiWinPathForHash(base));
    } else {
      add(normalizeGeminiPathForHash(base));
      if (base.includes("\\") || /^[a-zA-Z]:/.test(base)) add(normalizeGeminiWinPathForHash(base));
    }

    for (const v of Array.from(forms)) {
      const m = v.match(/^([a-zA-Z]):([\\/].*)$/);
      if (!m) continue;
      const rest = m[2];
      add(`${m[1].toUpperCase()}:${rest}`);
      add(`${m[1].toLowerCase()}:${rest}`);
    }

    return Array.from(forms);
  } catch {
    return [];
  }
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

/**
 * 在浏览器侧从项目路径推导 Gemini projectHash 候选集合（SHA-256 hex）。
 */
export async function deriveGeminiProjectHashCandidatesFromPath(pathCandidate: string): Promise<string[]> {
  try {
    const inputs = deriveGeminiProjectHashInputCandidatesFromPath(pathCandidate);
    if (inputs.length === 0) return [];
    const hashes = await Promise.all(inputs.map((s) => sha256Hex(s)));
    return Array.from(new Set(hashes.filter(Boolean)));
  } catch {
    return [];
  }
}
