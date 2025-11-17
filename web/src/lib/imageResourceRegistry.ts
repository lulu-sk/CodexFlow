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
};

const resourcesByWinPath = new Map<string, ResourceEntry>();
const resourcesByFingerprint = new Map<string, ResourceEntry>();

function normalizeFingerprint(fp?: string): string {
  if (!fp) return "";
  return String(fp).trim();
}

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
    entry = {
      fingerprint: fingerprint || undefined,
      winPath: winPath || undefined,
      wslPath: meta.wslPath ? String(meta.wslPath) : undefined,
      fileName: meta.fileName ? String(meta.fileName) : undefined,
      fromPaste: !!meta.fromPaste,
      refCount: 0,
    };
  } else {
    if (winPath) entry.winPath = winPath;
    if (fingerprint) entry.fingerprint = fingerprint;
    if (meta.wslPath && !entry.wslPath) entry.wslPath = String(meta.wslPath);
    if (meta.fileName && !entry.fileName) entry.fileName = String(meta.fileName);
    if (meta.fromPaste) entry.fromPaste = true;
  }
  if (entry.winPath) resourcesByWinPath.set(entry.winPath, entry);
  if (entry.fingerprint) resourcesByFingerprint.set(entry.fingerprint, entry);
  return entry;
}

export function rememberSavedImages(images: SavedImage[]): void {
  try {
    for (const image of images) {
      if (!image || !image.fromPaste || !image.winPath) continue;
      getEntry(image, true);
    }
  } catch {}
}

export function reuseSavedImageFromFingerprint(image: PastedImage): SavedImage | null {
  try {
    const fingerprint = normalizeFingerprint(image?.fingerprint);
    if (!fingerprint) return null;
    const entry = resourcesByFingerprint.get(fingerprint);
    if (!entry || !entry.winPath) return null;
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
  } catch {}
}

export function releasePastedImage(meta: ChipResourceLike): { shouldTrash: boolean; winPath?: string } {
  try {
    if (!meta || !meta.fromPaste || !meta.winPath) return { shouldTrash: false };
    const entry = getEntry(meta, false);
    if (!entry) return { shouldTrash: false };
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0) return { shouldTrash: false };
    if (entry.winPath) resourcesByWinPath.delete(entry.winPath);
    if (entry.fingerprint) resourcesByFingerprint.delete(entry.fingerprint);
    return { shouldTrash: entry.fromPaste && !!entry.winPath, winPath: entry.winPath };
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
