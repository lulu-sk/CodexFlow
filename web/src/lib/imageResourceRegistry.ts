// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { PastedImage, SavedImage } from "@/lib/clipboardImages";

export type ChipResourceLike = {
  fingerprint?: string;
  winPath?: string;
  wslPath?: string;
  fileName?: string;
  fromPaste?: boolean;
};

type ResourceEntry = {
  fingerprint?: string;
  winPath?: string;
  wslPath?: string;
  fileName?: string;
  fromPaste: boolean;
  refCount: number;
  createdAt: number;
  lastAccessAt: number;
};

const resourcesByWinPath = new Map<string, ResourceEntry>();
const resourcesByFingerprint = new Map<string, ResourceEntry>();

/**
 * 中文说明：限制图片资源 registry 的内存增长（长会话反复粘贴不同图片时避免无限增长）。
 * - 淘汰仅影响“内存索引”，不影响磁盘文件；
 * - 磁盘文件仍由主进程在“应用关闭/下次启动”统一清理（见 images/sessionPastedImages）。
 */
const MAX_RESOURCE_ENTRIES = 2048;
const RESOURCE_TTL_MS = 2 * 60 * 60_000; // 2 小时
const CLEANUP_MIN_INTERVAL_MS = 15_000; // 15 秒（节流，避免频繁扫描）
let lastCleanupAt = 0;

/**
 * 中文说明：获取当前时间戳（毫秒）。
 */
function nowMs(): number {
  return Date.now();
}

/**
 * 中文说明：更新条目的最近访问时间（用于 LRU）。
 */
function touchEntry(entry: ResourceEntry): void {
  try { entry.lastAccessAt = nowMs(); } catch {}
}

/**
 * 中文说明：从两个索引 Map 中移除同一条目（仅移除内存引用，不删除文件）。
 */
function removeEntryFromMaps(winPathKey: string, entry: ResourceEntry): void {
  try {
    const cur = resourcesByWinPath.get(winPathKey);
    if (cur === entry) resourcesByWinPath.delete(winPathKey);
    const fp = normalizeFingerprint(entry.fingerprint);
    if (fp) {
      const curFp = resourcesByFingerprint.get(fp);
      if (curFp === entry) resourcesByFingerprint.delete(fp);
    }
  } catch {}
}

/**
 * 中文说明：对 registry 做 TTL + 最大条目数淘汰。
 * - 优先淘汰 refCount=0 的条目；
 * - 若仍超过上限，则继续按 LRU 淘汰（即便 refCount>0，也不会影响“退出/下次启动清理文件”的策略）。
 */
function cleanupRegistry(options?: { force?: boolean }): void {
  try {
    const now = nowMs();
    const force = !!options?.force;
    if (!force && now - lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) return;
    lastCleanupAt = now;

    // 1) TTL：移除长时间未访问且无引用的条目
    if (RESOURCE_TTL_MS > 0) {
      for (const [key, entry] of resourcesByWinPath.entries()) {
        const last = Number(entry.lastAccessAt || entry.createdAt || 0);
        if (entry.refCount > 0) continue;
        if (last > 0 && now - last > RESOURCE_TTL_MS) {
          removeEntryFromMaps(key, entry);
        }
      }
    }

    // 2) 上限：按 LRU 淘汰
    if (resourcesByWinPath.size <= MAX_RESOURCE_ENTRIES) return;
    const items = Array.from(resourcesByWinPath.entries()).map(([key, entry]) => ({
      key,
      entry,
      score: Number(entry.lastAccessAt || entry.createdAt || 0),
    }));
    items.sort((a, b) => a.score - b.score);

    for (const it of items) {
      if (resourcesByWinPath.size <= MAX_RESOURCE_ENTRIES) break;
      if (it.entry.refCount > 0) continue;
      removeEntryFromMaps(it.key, it.entry);
    }
    if (resourcesByWinPath.size <= MAX_RESOURCE_ENTRIES) return;
    for (const it of items) {
      if (resourcesByWinPath.size <= MAX_RESOURCE_ENTRIES) break;
      if (!resourcesByWinPath.has(it.key)) continue;
      removeEntryFromMaps(it.key, it.entry);
    }
  } catch {}
}

/**
 * 中文说明：归一化图片指纹字符串（去空白；无效时返回空串）。
 */
function normalizeFingerprint(fp?: string): string {
  if (!fp) return "";
  return String(fp).trim();
}

/**
 * 中文说明：获取或创建资源条目，并同步维护 winPath / fingerprint 双索引。
 * - `createIfMissing=true`：允许创建新条目；
 * - 会更新最近访问时间，并在必要时触发清理（TTL/LRU/上限）。
 */
function getEntry(meta: ChipResourceLike, createIfMissing: boolean): ResourceEntry | null {
  if (!meta || !meta.fromPaste) return null;
  const winPath = typeof meta.winPath === "string" ? meta.winPath.trim() : "";
  const fingerprint = normalizeFingerprint(meta.fingerprint);
  if (!createIfMissing && !winPath && !fingerprint) return null;
  let entry: ResourceEntry | undefined;
  if (winPath) entry = resourcesByWinPath.get(winPath);
  if (!entry && fingerprint) entry = resourcesByFingerprint.get(fingerprint);
  if (!entry) {
    if (!createIfMissing) return null;
    if (!winPath && !fingerprint) return null;
    const now = nowMs();
    entry = {
      fingerprint: fingerprint || undefined,
      winPath: winPath || undefined,
      wslPath: meta.wslPath ? String(meta.wslPath) : undefined,
      fileName: meta.fileName ? String(meta.fileName) : undefined,
      fromPaste: !!meta.fromPaste,
      refCount: 0,
      createdAt: now,
      lastAccessAt: now,
    };
  } else {
    touchEntry(entry);
    const prevWinPath = String(entry.winPath || "").trim();
    const prevFingerprint = normalizeFingerprint(entry.fingerprint);
    if (winPath && prevWinPath && winPath !== prevWinPath) {
      // 避免同一 entry 产生“旧 key 残留”导致 Map 无界增长
      try { if (resourcesByWinPath.get(prevWinPath) === entry) resourcesByWinPath.delete(prevWinPath); } catch {}
      entry.winPath = winPath;
    } else if (winPath) {
      entry.winPath = winPath;
    }
    if (fingerprint && prevFingerprint && fingerprint !== prevFingerprint) {
      try { if (resourcesByFingerprint.get(prevFingerprint) === entry) resourcesByFingerprint.delete(prevFingerprint); } catch {}
      entry.fingerprint = fingerprint;
    } else if (fingerprint) {
      entry.fingerprint = fingerprint;
    }
    if (meta.wslPath && !entry.wslPath) entry.wslPath = String(meta.wslPath);
    if (meta.fileName && !entry.fileName) entry.fileName = String(meta.fileName);
    if (meta.fromPaste) entry.fromPaste = true;
  }
  if (entry.winPath) resourcesByWinPath.set(entry.winPath, entry);
  if (entry.fingerprint) resourcesByFingerprint.set(entry.fingerprint, entry);
  cleanupRegistry({ force: resourcesByWinPath.size > MAX_RESOURCE_ENTRIES });
  return entry;
}

export function rememberSavedImages(images: SavedImage[]): void {
  try {
    for (const image of images) {
      if (!image || !image.fromPaste || !image.winPath) continue;
      getEntry(image, true);
    }
    cleanupRegistry({ force: resourcesByWinPath.size > MAX_RESOURCE_ENTRIES });
  } catch {}
}

export function reuseSavedImageFromFingerprint(image: PastedImage): SavedImage | null {
  try {
    const fingerprint = normalizeFingerprint(image?.fingerprint);
    if (!fingerprint) return null;
    const entry = resourcesByFingerprint.get(fingerprint);
    if (!entry || !entry.winPath) return null;
    touchEntry(entry);
    cleanupRegistry();
    return {
      ...image,
      saved: true,
      fromPaste: true,
      winPath: entry.winPath,
      wslPath: entry.wslPath,
      fileName: entry.fileName,
    } as SavedImage;
  } catch {
    return null;
  }
}

export function retainPastedImage(meta: ChipResourceLike): void {
  try {
    if (!meta || !meta.fromPaste || !meta.winPath) return;
    const entry = getEntry(meta, true);
    if (!entry) return;
    entry.refCount += 1;
    cleanupRegistry();
  } catch {}
}

export function releasePastedImage(meta: ChipResourceLike): { shouldTrash: boolean; winPath?: string } {
  try {
    if (!meta || !meta.fromPaste || !meta.winPath) return { shouldTrash: false };
    const entry = getEntry(meta, false);
    if (!entry) return { shouldTrash: false };
    entry.refCount = Math.max(0, entry.refCount - 1);
    // 新策略：粘贴的临时图片在“应用关闭/下次启动”统一清理；
    // 因此渲染进程不再基于 refCount 主动触发删除，避免 N 分钟定时清理带来的体验与竞态问题。
    cleanupRegistry({ force: resourcesByWinPath.size > MAX_RESOURCE_ENTRIES });
    return { shouldTrash: false, winPath: entry.winPath };
  } catch {
    return { shouldTrash: false };
  }
}

// 请求主进程删除已失效的粘贴图片，并吞掉潜在异常与拒绝，避免渲染端出现 UnhandledPromiseRejection
export function requestTrashWinPath(winPath?: string): void {
  try {
    if (!winPath) return;
    const maybePromise: Promise<any> | undefined = (window as any).host?.images?.trash?.({ winPath });
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch {}
}
