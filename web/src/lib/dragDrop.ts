// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { toWslRelOrAbsForProject } from "@/lib/wsl";

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

export type WinPathKind = "directory" | "file" | "unknown";

export interface WinPathProbeResult {
  kind: WinPathKind;
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
}

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
        // Rider 等 IDE 可能将 Windows 路径以百分号编码形式写入 text/plain（如 %20 表示空格），此处尝试在必要时解码
        const resolved = resolvePlainTextPathCandidate(s);
        if (resolved) out.push(resolved);
      }
    }
  } catch {}
  // 规范化 + 去重：统一分隔符、盘符大小写，移除多余结尾分隔符（保留盘符根如 C:\）
  const uniq = Array.from(new Set(out.map((s) => normalizeForDedupe(String(s)))));
  return uniq;
}

/**
 * 综合 host 提供的 pathExists API 与字符串特征，最佳努力判定 Windows 路径的类型。
 * - 优先使用主进程 stat 返回的 isDirectory/isFile；
 * - 兼容旧版本仅返回 exists 标记的实现；
 * - 当无法确认时，默认按“文件”处理，避免误将文件视作目录。
 */
export async function probeWinPathKind(winPath: string): Promise<WinPathProbeResult> {
  const fallback: WinPathProbeResult = { kind: "unknown", exists: false, isDirectory: false, isFile: false };
  const raw = String(winPath || "").trim();
  if (!raw) return fallback;

  const host: any = (window as any)?.host;
  const utils: any = host?.utils;

  if (typeof utils?.pathExists !== "function") {
    const heuristicKind = looksLikeDirectoryPath(raw) ? "directory" : "file";
    return {
      kind: heuristicKind,
      exists: false,
      isDirectory: heuristicKind === "directory",
      isFile: heuristicKind === "file",
    };
  }

  const responses: Array<{ res: any; mode: "any" | "dirOnly" }> = [];
  try { responses.push({ res: await utils.pathExists(raw), mode: "any" }); } catch {}
  try { responses.push({ res: await utils.pathExists(raw, true), mode: "dirOnly" }); } catch {}

  let exists = false;
  for (const { res } of responses) {
    if (!res || res.ok === false) continue;
    if (typeof res.exists === "boolean" && res.exists) exists = true;
    if (typeof res.isDirectory === "boolean" || typeof res.isFile === "boolean") {
      const isDirectory = !!res.isDirectory;
      const isFile = !!res.isFile;
      const actualExists = typeof res.exists === "boolean" ? res.exists : (isDirectory || isFile);
      return {
        kind: isDirectory ? "directory" : (isFile ? "file" : exists ? "file" : "unknown"),
        exists: actualExists,
        isDirectory,
        isFile,
      };
    }
  }

  const dirProbe = responses.find(({ mode, res }) => mode === "dirOnly" && res && res.ok !== false);
  if (dirProbe && typeof dirProbe.res?.exists === "boolean" && dirProbe.res.exists) {
    return { kind: "directory", exists: true, isDirectory: true, isFile: false };
  }

  if (exists) {
    const heuristic = looksLikeDirectoryPath(raw) ? "directory" : "file";
    return {
      kind: heuristic,
      exists: true,
      isDirectory: heuristic === "directory",
      isFile: heuristic === "file",
    };
  }

  return fallback;
}

function looksLikePath(s: string): boolean {
  const str = String(s || "").trim();
  if (!str) return false;
  // Windows 盘符绝对路径（支持反斜杠或正斜杠）
  if (/^[a-zA-Z]:[\\/]/.test(str)) return true;
  // Windows UNC 共享路径：\\server\share\...
  if (/^\\\\[^\\/]+[\\/][^\\/]+/.test(str)) return true;
  // Windows 长路径前缀：\\?\C:\...
  if (/^\\\\\?\\[a-zA-Z]:[\\/]/.test(str)) return true;
  // Windows UNC 长路径变体：\\?\UNC\server\share\...
  if (/^\\\\\?\\UNC\\[^\\]+\\[^\\]+/.test(str)) return true;
  // file: URI（其余解析在 normalizeUriToWinPath 中处理）
  if (/^file:[\\/]{1,3}/i.test(str)) return true;
  // POSIX/WSL 绝对路径（/mnt/*、/home/* 等）
  if (str.startsWith("/")) return true;
  return false;
}

/**
 * 从 text/plain 候选中推断合适的 Windows 路径字符串。
 *
 * 设计原则：
 * 1) 若原串已经“像路径”（盘符/UNC/file:/POSIX），一律保留原样，不尝试百分号解码；
 *    - 避免把合法文件名中的 %xx（如 feature%20）误解码为空格等导致访问失败。
 * 2) 仅当原串不像路径、且包含 %xx 片段时，尝试一次“安全解码”，
 *    - 解码后仍需“像路径”才接受；否则丢弃（返回空串，让上层忽略该条）。
 * 3) file: URI 的解析在 normalizeUriToWinPath 中完成，这里不重复处理。
 *
 * 典型用例：
 * - "C%3A%5CUsers%5Cme%5Ca.txt" -> "C:\\Users\\me\\a.txt"
 * - "C:\\repo\\feature%20" -> 原样返回，避免误解码为带空格路径
 */
function resolvePlainTextPathCandidate(s: string): string | "" {
  const value = String(s || "").trim();
  if (!value) return "";
  // 关键策略：一旦原串已“像路径”，直接返回原串，避免将合法文件名中的 %xx 被误当作 URL 编码解码
  if (looksLikePath(value)) return value;
  const hasEncoded = /%[0-9a-fA-F]{2}/.test(value);
  if (!hasEncoded) return "";
  // 仅当原串不像路径时，尝试一次安全解码；解码后仍需“像路径”才接受
  const decoded = maybeDecodePercentEncodedPath(value);
  return looksLikePath(decoded) ? decoded : "";
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

/**
 * 在原始路径与“可能的解码候选”之间进行存在性择优：
 * - 若原串不含 %xx，直接返回原串；
 * - 若含 %xx，尝试安全解码（仅当 decode 后仍“像路径”）；
 * - 并发探测两个候选的存在性，若仅 decoded 存在则返回 decoded；仅 original 存在则返回 original；
 * - 其余情况（都存在或都不存在或不可判定）返回 original，以避免静默改写包含 '%' 的合法文件名。
 */
export async function preferExistingWinPathCandidate(original: string): Promise<string> {
  try {
    const raw = String(original || "").trim();
    if (!raw) return raw;
    if (!/%[0-9a-fA-F]{2}/.test(raw)) return raw;
    const decoded = maybeDecodePercentEncodedPath(raw);
    if (decoded === raw) return raw;
    if (!looksLikePath(decoded)) return raw;
    const [a, b] = await Promise.all([
      probeWinPathKind(raw).catch(() => ({ kind: "unknown", exists: false, isDirectory: false, isFile: false } as WinPathProbeResult)),
      probeWinPathKind(decoded).catch(() => ({ kind: "unknown", exists: false, isDirectory: false, isFile: false } as WinPathProbeResult)),
    ]);
    const aExists = !!(a && (a.exists || a.isDirectory || a.isFile));
    const bExists = !!(b && (b.exists || b.isDirectory || b.isFile));
    if (bExists && !aExists) return decoded;
    if (aExists && !bExists) return raw;
    return raw;
  } catch { return String(original || ""); }
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
    const looksValid = looksLikePath(s);
    if (!looksValid || /%(5C|2F|3A)/i.test(s)) {
      // 为了更好地去重，仅在可疑输入下尝试解码百分号编码（例如 C%3A%5C... -> C:\...），避免误改包含真实 %xx 的合法路径
      const decoded = maybeDecodePercentEncodedPath(s, { onlyWhenLooksInvalid: true });
      if (decoded !== s) {
        s = decoded;
      }
    }
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

function looksLikeDirectoryPath(p: string): boolean {
  const str = String(p || "");
  if (!str) return false;
  if (/[\\/]+$/.test(str)) return true;
  const name = str.split(/[\\/]/).pop() || "";
  if (!name) return false;
  const hasExt = /\.[^.]+$/.test(name) && !name.startsWith(".");
  // 若最后一段缺少常见文件扩展名，更倾向视作目录
  return !hasExt;
}

// 仅在字符串中出现合法百分号编码片段时尝试解码；失败或启发式不通过时返回原串
function maybeDecodePercentEncodedPath(s: string, options?: { onlyWhenLooksInvalid?: boolean }): string {
  try {
    const raw = String(s || "");
    if (!raw) return raw;
    const hasEncodedToken = /%[0-9a-fA-F]{2}/.test(raw);
    if (options?.onlyWhenLooksInvalid && looksLikePath(raw) && !hasEncodedToken) return raw;
    if (!hasEncodedToken) return raw;
    const decoded = decodeURIComponent(raw);
    const canonicalSource = canonicalizeEncodedPathCandidate(raw);
    const recodedViaUri = canonicalizeEncodedPathCandidate(encodeURI(decoded));
    if (recodedViaUri === canonicalSource) {
      return decoded;
    }
    const recodedViaComponent = canonicalizeEncodedPathCandidate(encodeURIComponent(decoded));
    if (recodedViaComponent === canonicalSource) {
      return decoded;
    }
    return raw;
  } catch { return String(s || ""); }
}

function canonicalizeEncodedPathCandidate(value: string): string {
  return String(value || "")
    .replace(/\\/g, "%5C")
    .replace(/%[0-9a-fA-F]{2}/g, (token) => token.toUpperCase());
}

/**
 * 根据项目根将拖入的 Windows 路径转换为 WSL 路径：
 * - 若在项目根内：返回相对 WSL 路径（不以 / 开头）
 * - 若不在项目内：返回 WSL 绝对路径（/mnt/... 或 /home/...）
 */
export function toProjectWslRelOrAbs(winPath: string, projectWinRoot?: string): string {
  // 与 web/src/lib/wsl.ts 保持一致，等于项目根时返回 "."，在项目内返回相对路径，否则返回可插入的 WSL 绝对路径
  return toWslRelOrAbsForProject(winPath, projectWinRoot, "relative");
}


