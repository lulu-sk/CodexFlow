// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type RankedRel = {
  rel: string;
  isDir: boolean;
  score: number;
};

type QueryInfo = {
  raw: string;
  needleCodes: number[];
  hasSlash: boolean;
  slashSegs: number[][];
};

/**
 * 中文说明：对文件/目录相对路径执行轻量模糊匹配并返回 topN。
 *
 * 设计目标：
 * - 避免 “map 全量评分 + sort 全量排序” 带来的 O(N log N) CPU 与海量临时对象分配；
 * - 在大仓库（数十万候选）下仍能稳定工作，避免触发渲染进程 reload/白屏。
 *
 * @param args.files - 文件相对路径列表（使用 "/" 分隔）
 * @param args.dirs - 目录相对路径列表（使用 "/" 分隔）
 * @param args.query - 查询串（允许包含 "\\"，内部会归一化为 "/"）
 * @param args.limit - 返回上限
 */
export function searchFileIndexCandidates(args: {
  files: string[];
  dirs: string[];
  query: string;
  limit: number;
}): RankedRel[] {
  const limit = clampLimit(args.limit);
  if (limit <= 0) return [];
  const q = normalizeQuery(args.query);
  if (!q) {
    // 空查询：不做全量扫描，直接给一个稳定的“前 N 个”种子结果
    const out: RankedRel[] = [];
    for (const d of (Array.isArray(args.dirs) ? args.dirs : [])) {
      if (out.length >= limit) break;
      if (!d) continue;
      out.push({ rel: String(d), isDir: true, score: 0 });
    }
    if (out.length < limit) {
      for (const f of (Array.isArray(args.files) ? args.files : [])) {
        if (out.length >= limit) break;
        if (!f) continue;
        out.push({ rel: String(f), isDir: false, score: 0 });
      }
    }
    return out;
  }

  const info = buildQueryInfo(q);
  const top: RankedRel[] = [];

  for (const d of (Array.isArray(args.dirs) ? args.dirs : [])) {
    if (!d) continue;
    const rel = String(d);
    const score = scoreRel(rel, true, info);
    if (score <= 0) continue;
    insertTopK(top, { rel, isDir: true, score }, limit);
  }
  for (const f of (Array.isArray(args.files) ? args.files : [])) {
    if (!f) continue;
    const rel = String(f);
    const score = scoreRel(rel, false, info);
    if (score <= 0) continue;
    insertTopK(top, { rel, isDir: false, score }, limit);
  }
  return top;
}

/**
 * 中文说明：将 query 归一化为文件索引使用的形式（统一分隔符并 trim）。
 */
function normalizeQuery(query: string): string {
  return String(query || "").trim().replace(/\\/g, "/");
}

/**
 * 中文说明：限制 limit，避免被外部误传大值导致扫描开销放大。
 */
function clampLimit(limit: number): number {
  const n = Number(limit);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(50, Math.floor(n)));
}

/**
 * 中文说明：构造查询的预处理信息（ASCII 大小写不敏感）。
 */
function buildQueryInfo(q: string): QueryInfo {
  const needleCodes = toNeedleCodes(q);
  const hasSlash = q.includes("/");
  const slashSegs = hasSlash
    ? q.split("/").filter(Boolean).map((seg) => toNeedleCodes(seg))
    : [];
  return { raw: q, needleCodes, hasSlash, slashSegs };
}

/**
 * 中文说明：将字符串转换为 ASCII 小写码点数组（仅对 A-Z 做折叠）。
 */
function toNeedleCodes(s: string): number[] {
  const out: number[] = [];
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    out.push(toLowerAsciiCode(str.charCodeAt(i)));
  }
  return out;
}

/**
 * 中文说明：ASCII 大小写折叠（仅处理 A-Z）。
 */
function toLowerAsciiCode(code: number): number {
  if (code >= 65 && code <= 90) return code + 32;
  return code;
}

/**
 * 中文说明：判断 hay 是否以 needle 开头（ASCII 大小写不敏感）。
 */
function startsWithIgnoreCaseAscii(hay: string, needle: number[]): boolean {
  if (!needle || needle.length === 0) return true;
  const s = String(hay || "");
  if (s.length < needle.length) return false;
  for (let i = 0; i < needle.length; i++) {
    const hc = toLowerAsciiCode(s.charCodeAt(i));
    if (hc !== needle[i]) return false;
  }
  return true;
}

/**
 * 中文说明：在 hay 中查找 needle 的首次位置（ASCII 大小写不敏感）。
 */
function indexOfIgnoreCaseAscii(hay: string, needle: number[], fromIndex = 0): number {
  if (!needle || needle.length === 0) return 0;
  const s = String(hay || "");
  const n = needle.length;
  const start = Math.max(0, Math.min(s.length, Math.floor(fromIndex)));
  if (n > s.length - start) return -1;
  for (let i = start; i <= s.length - n; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      const hc = toLowerAsciiCode(s.charCodeAt(i + j));
      if (hc !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * 中文说明：获取路径的 basename（以 "/" 为分隔符）。
 */
function basename(rel: string): string {
  const s = String(rel || "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 中文说明：子序列匹配得分（ASCII 大小写不敏感）。
 * - 返回 -1 表示不匹配；
 * - 返回越大表示越紧凑/越靠前。
 */
function scoreSubsequence(hay: string, needle: number[]): number {
  if (!needle || needle.length === 0) return -1;
  const s = String(hay || "");
  let j = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < s.length && j < needle.length; i++) {
    const hc = toLowerAsciiCode(s.charCodeAt(i));
    if (hc === needle[j]) {
      if (first < 0) first = i;
      last = i;
      j++;
    }
  }
  if (j !== needle.length) return -1;
  const span = Math.max(1, last - first + 1);
  const tight = Math.max(0, 200 - span);
  const startBonus = Math.max(0, 60 - first);
  return 220 + tight + startBonus;
}

/**
 * 中文说明：对单个候选路径评分（越大越靠前）。
 */
function scoreRel(rel: string, isDir: boolean, q: QueryInfo): number {
  const base = basename(rel);
  let s = 0;

  if (startsWithIgnoreCaseAscii(base, q.needleCodes)) s += 1200;
  if (startsWithIgnoreCaseAscii(rel, q.needleCodes)) s += 900;
  if (indexOfIgnoreCaseAscii(rel, q.needleCodes) >= 0) s += 500;

  if (q.hasSlash && q.slashSegs.length > 0) {
    let start = 0;
    let ok = 0;
    for (const seg of q.slashSegs) {
      const idx = indexOfIgnoreCaseAscii(rel, seg, start);
      if (idx >= 0) {
        ok += 1;
        start = idx + seg.length;
      } else {
        break;
      }
    }
    if (ok > 0) s += ok * 180;
    if (isDir) s += 160;
  } else {
    if (!isDir) s += 60;
    // 轻量模糊：仅在未命中 contains 时尝试子序列匹配，避免对所有候选做额外扫描
    if (s < 500 && q.needleCodes.length >= 3) {
      const a = scoreSubsequence(base, q.needleCodes);
      const b = scoreSubsequence(rel, q.needleCodes);
      const best = Math.max(a, b);
      if (best > 0) s += best;
    }
  }

  // 更短路径略优（对分数做轻微惩罚）
  s -= rel.length * 0.3;
  return s;
}

/**
 * 中文说明：插入到 topK 列表（按 score 降序，次级按 rel 长度升序）。
 */
function insertTopK(list: RankedRel[], item: RankedRel, limit: number): void {
  if (limit <= 0) return;
  if (list.length >= limit) {
    const worst = list[list.length - 1];
    if (compareRank(item, worst) >= 0) return;
  }
  let i = 0;
  while (i < list.length && compareRank(list[i], item) <= 0) i++;
  list.splice(i, 0, item);
  if (list.length > limit) list.pop();
}

/**
 * 中文说明：排序比较器（返回 <0 表示 a 更靠前）。
 */
function compareRank(a: RankedRel, b: RankedRel): number {
  if (a.score !== b.score) return b.score - a.score; // score 降序
  const la = a.rel.length;
  const lb = b.rel.length;
  if (la !== lb) return la - lb; // 更短优先
  return a.rel.localeCompare(b.rel);
}

