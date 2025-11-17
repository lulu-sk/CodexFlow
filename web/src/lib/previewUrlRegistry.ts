// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const previewUrlRefCounts = new Map<string, number>();

function isBlobUrl(url: string | undefined | null): url is string {
  return typeof url === "string" && url.startsWith("blob:");
}

export function retainPreviewUrl(url: string | undefined | null): void {
  if (!isBlobUrl(url)) return;
  const prev = previewUrlRefCounts.get(url) || 0;
  previewUrlRefCounts.set(url, prev + 1);
}

export function releasePreviewUrl(url: string | undefined | null): void {
  if (!isBlobUrl(url)) return;
  const prev = previewUrlRefCounts.get(url);
  if (prev === undefined) return;
  if (prev <= 1) {
    previewUrlRefCounts.delete(url);
    try { URL.revokeObjectURL(url); } catch {}
  } else {
    previewUrlRefCounts.set(url, prev - 1);
  }
}

