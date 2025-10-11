// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { toWSLForInsert } from "@/lib/wsl";

export type DroppedEntry = {
  /** 原始条目名（不一定包含完整路径） */
  name: string;
  /** Windows 本地路径（若可解析） */
  winPath?: string;
  /** 统一转为可插入文本的 WSL 路径（相对或绝对由上层决定） */
  wslPath?: string;
  /** 是否为目录（尽力判定） */
  isDir?: boolean;
};

/**
 * 从 DataTransfer 中提取尽可能多的文件/目录路径（Windows 路径），并返回去重后的列表。
 * 说明：
 * - 优先使用 dataTransfer.files（支持多个）；
 * - 其次解析 text/uri-list 或 text/plain；
 * - 统一清理 file:/// 前缀与 URL 编码；
 */
export function extractWinPathsFromDataTransfer(dt: DataTransfer | null): string[] {
  if (!dt) return [];
  const out: string[] = [];
  try {
    // 1) FileList（最可靠）
    const files = Array.from(dt.files || []);
    for (const f of files) {
      const p = (f as any).path || (f as any).webkitRelativePath || "";
      if (p && typeof p === "string") out.push(p);
    }
  } catch {}
  try {
    // 2) text/uri-list
    const uriList = dt.getData("text/uri-list");
    if (uriList && uriList.trim()) {
      for (const ln of uriList.split(/\r?\n/)) {
        const s = ln.trim();
        if (!s || s.startsWith("#")) continue;
        const p = normalizeUriToWinPath(s);
        if (p) out.push(p);
      }
    }
  } catch {}
  try {
    // 3) text/plain（很多应用会拖入纯文本路径）
    const plain = dt.getData("text/plain");
    if (plain && plain.trim()) {
      for (const seg of plain.split(/\r?\n/)) {
        const s = seg.trim();
        if (!s) continue;
        const pFromFile = normalizeUriToWinPath(s);
        if (pFromFile) { out.push(pFromFile); continue; }
        // 若是 file: 开头但无法解析，直接跳过，避免生成 file:/G:/... 异常 token
        if (/^file:/i.test(s)) { continue; }
        const p = s;
        if (looksLikePath(p)) out.push(p);
      }
    }
  } catch {}
  // 规范化 + 去重：统一分隔符、盘符大小写，移除多余结尾分隔符（保留盘符根如 C:\）
  const uniq = Array.from(new Set(out.map((s) => normalizeForDedupe(String(s)))));
  return uniq;
}

function looksLikePath(s: string): boolean {
  return /^(?:[a-zA-Z]:\\|\\\\|file:\/\/\/)/.test(s) || /\//.test(s);
}

function normalizeUriToWinPath(s: string): string | "" {
  try {
    let str = String(s || "");
    if (!str) return "";
    // 统一大小写判断
    const lower = str.toLowerCase();
    if (lower.startsWith("file:")) {
      // 兼容多种非标准 file: 表达：
      // - file:///C:/a/b
      // - file:/C:/a/b
      // - file:\C:\a\b
      // - file://server/share/a/b
      // - file:////server/share/a/b
      // 优先尝试 URL 解析（标准形式），失败则走正则/手工解析
      try {
        // 将反斜杠归一为正斜杠，便于 URL 解析
        const normalized = str.replace(/\\/g, "/");
        if (/^file:\/\//i.test(normalized)) {
          const url = new URL(normalized);
          const host = url.host || "";
          const pathname = decodeURIComponent(url.pathname || "");
          // 盘符：/C:/...
          const m1 = pathname.match(/^\/([a-zA-Z]):\/(.*)$/);
          if (m1) {
            const drive = m1[1].toUpperCase();
            const rest = m1[2].replace(/\//g, "\\");
            return `${drive}:\\${rest}`;
          }
          // UNC：file://server/share -> \\server\share
          if (host) {
            const body = (host + pathname).replace(/^\/+/, "").replace(/\//g, "\\");
            return `\\\\${body}`;
          }
          // 某些实现会把多个斜杠折叠到 pathname：/server/share
          const m2 = pathname.match(/^\/([^\/]+)\/(.*)$/);
          if (m2) {
            const body = `${m2[1]}\\${m2[2].replace(/\//g, "\\")}`;
            return `\\\\${body}`;
          }
          return "";
        }
      } catch { /* 继续尝试手工解析 */ }

      // 手工解析：去掉前缀 file: 与后续的任意数量 / 或 \\ 前导
      let rest = str.slice(5);
      rest = rest.replace(/^[\\/]+/, "");
      // 驱动器形式：C:\ 或 C:/
      const md = rest.match(/^([a-zA-Z]):[\\/](.*)$/);
      if (md) {
        const drive = md[1].toUpperCase();
        const tail = md[2].replace(/\//g, "\\");
        return `${drive}:\\${tail}`;
      }
      // 仅驱动器根：C: 或 C:\ 或 C:/
      const mdRoot = rest.match(/^([a-zA-Z]):([\\/])?$/);
      if (mdRoot) {
        const drive = mdRoot[1].toUpperCase();
        return `${drive}:\\`;
      }
      // UNC：server/share/...
      if (rest) {
        const body = rest.replace(/\//g, "\\");
        return `\\\\${body}`;
      }
      return "";
    }
    // 非 file:，不处理
    return "";
  } catch { return ""; }
}

// 仅用于去重的 Windows 路径标准化：
// - 统一使用 \\ 分隔符；
// - 盘符字母转大写；
// - 去掉末尾多余分隔符，保留盘符根形式 C:\；
// - UNC 路径保留前缀 \\，去掉末尾多余分隔符。
function normalizeForDedupe(p: string): string {
  try {
    let s = String(p || "");
    if (!s) return s;
    // 统一分隔符
    s = s.replace(/\//g, "\\");
    // UNC
    if (s.startsWith("\\\\")) {
      // 去掉末尾多余分隔符
      s = s.replace(/[\\/]+$/, "");
      return s;
    }
    // 盘符路径
    const m = s.match(/^([a-zA-Z]):(.*)$/);
    if (m) {
      const drive = m[1].toUpperCase();
      let rest = m[2];
      // 仅根：C: 或 C:\ 或 C:/ -> 规范化为 C:\
      if (!rest || rest === "\\" || rest === "/") {
        return `${drive}:\\`;
      }
      // 去掉末尾分隔符
      rest = rest.replace(/[\\/]+$/, "");
      return `${drive}:${rest}`;
    }
    // 其他：仅去掉末尾分隔符
    return s.replace(/[\\/]+$/, "");
  } catch { return String(p || ""); }
}

/**
 * 根据项目根将拖入的 Windows 路径转换为 WSL 路径：
 * - 若在项目根内：返回相对 WSL 路径（不以 / 开头）
 * - 若不在项目内：返回 WSL 绝对路径（/mnt/... 或 /home/...）
 */
export function toProjectWslRelOrAbs(winPath: string, projectWinRoot?: string): string {
  const abs = String(winPath || "");
  const root = String(projectWinRoot || "").trim();
  if (root) {
    try {
      const a = normalizeWin(abs);
      const r = normalizeWin(root);
      if (a.toLowerCase().startsWith(r.toLowerCase() + "\\") || a.toLowerCase() === r.toLowerCase()) {
        const rel = a.slice(r.length).replace(/^\\+/, "").replace(/\\/g, "/");
        return rel; // 相对 WSL 路径
      }
    } catch {}
  }
  // 项目外：返回可插入的 WSL 绝对路径
  return toWSLForInsert(abs);
}

function normalizeWin(p: string): string { return String(p || "").replace(/\//g, "\\"); }


