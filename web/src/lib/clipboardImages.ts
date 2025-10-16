// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

// 粘贴图片处理（渲染进程）：
// - 从 ClipboardEvent 提取图片 Blob
// - 生成本地预览 URL
// - 通过 preload 暴露的 images API 持久化到磁盘
// - 返回用于 UI 预览与插入 Markdown 的信息

export type PastedImage = {
  id: string;
  blob: Blob;
  previewUrl: string; // URL.createObjectURL
  width?: number;
  height?: number;
  type: string;
  size: number;
};

export type SavedImage = PastedImage & {
  saved?: boolean;
  winPath?: string;
  wslPath?: string;
  fileName?: string;
  error?: string;
  /** 是否由本次粘贴流程生成（用于 X 删除时彻底删除） */
  fromPaste?: boolean;
};

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "bmp",
  "webp",
  "gif",
  "svg",
  "svgz",
  "ico",
  "cur",
  "tif",
  "tiff",
  "avif",
  "heic",
  "heif",
]);

function guessMimeByExt(name?: string, fallback = "image/png"): string {
  const ext = extractExt(name);
  switch (ext) {
    case "jpg":
    case "jpeg":
    case "jpe":
    case "jfif":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    case "svg":
    case "svgz":
      return "image/svg+xml";
    case "ico":
    case "cur":
      return "image/x-icon";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "avif":
      return "image/avif";
    case "heic":
    case "heif":
      return "image/heif";
    default:
      return fallback;
  }
}

function extractExt(name?: string): string {
  if (!name) return "";
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

export function isImageFileName(name?: string): boolean {
  if (!name) return false;
  return IMAGE_EXTS.has(extractExt(name));
}

export function isImageFileLike(file: { type?: string; name?: string } | null | undefined): boolean {
  if (!file) return false;
  const type = String(file.type || "").toLowerCase();
  if (type.startsWith("image/")) return true;
  return isImageFileName(file.name);
}

// 从拖拽 FileList 中转为 PastedImage，复用粘贴图片流程
export async function extractImagesFromFileList(files: ArrayLike<File> | File[]): Promise<PastedImage[]> {
  const out: PastedImage[] = [];
  const arr = Array.from(files || []);
  for (const file of arr) {
    try {
      if (!isImageFileLike(file)) continue;
      const blob: Blob = file;
      const id = uid();
      const type = String(file.type || guessMimeByExt(file.name));
      const size = typeof file.size === "number" ? file.size : (blob as any).size || 0;
      const url = URL.createObjectURL(blob);
      let width: number | undefined;
      let height: number | undefined;
      try { ({ width, height } = await probeImageSize(url)); } catch {}
      out.push({ id, blob, previewUrl: url, width, height, type, size });
    } catch {}
  }
  return out;
}

export async function extractImagesFromPasteEvent(ev: ClipboardEvent): Promise<PastedImage[]> {
  const out: PastedImage[] = [];
  try {
    const cd = ev.clipboardData;
    if (!cd) return out;
    const items = cd.items || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const type = it?.type || "";
      if (!type || !type.startsWith("image/")) continue;
      const blob = it.getAsFile() || it.getAsFile?.();
      if (!blob) continue;
      const id = uid();
      const url = URL.createObjectURL(blob);
      // 尝试读取尺寸
      let width: number | undefined; let height: number | undefined;
      try { ({ width, height } = await probeImageSize(url)); } catch {}
      out.push({ id, blob, previewUrl: url, width, height, type, size: (blob as any).size || 0 });
    }
  } catch {}
  return out;
}

async function probeImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    try {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
      img.onerror = () => reject(new Error('image load error'));
      img.src = url;
    } catch (e) { reject(e); }
  });
}

export async function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = (e) => reject(e);
      reader.readAsDataURL(blob);
    } catch (e) { reject(e); }
  });
}

export async function persistImages(images: PastedImage[], projectWinRoot?: string, projectName?: string): Promise<SavedImage[]> {
  const saved: SavedImage[] = [];
  for (const it of images) {
    try {
      const dataURL = await blobToDataURL(it.blob);
      const res: any = await (window as any).host?.images?.saveDataURL?.({ dataURL, projectWinRoot, projectName });
      if (res && res.ok) {
        saved.push({ ...it, saved: true, winPath: res.winPath, wslPath: res.wslPath, fileName: res.fileName, fromPaste: true });
      } else {
        saved.push({ ...it, saved: false, error: String(res?.error || 'save failed') });
      }
    } catch (e) {
      saved.push({ ...it, saved: false, error: String(e) });
    }
  }
  return saved;
}

// 将 Markdown 插入到 textarea/input 当前光标处；若无法获取 caret，退化为末尾追加
export function insertTextAtCursor(el: HTMLTextAreaElement | HTMLInputElement, value: string, insert: string): { next: string; nextCaret: number } {
  try {
    const start = (el as any).selectionStart as number;
    const end = (el as any).selectionEnd as number;
    if (typeof start === 'number' && typeof end === 'number') {
      const left = value.slice(0, start);
      const right = value.slice(end);
      const next = left + insert + right;
      const caret = (left + insert).length;
      return { next, nextCaret: caret };
    }
  } catch {}
  const next = (value || '') + insert;
  return { next, nextCaret: next.length };
}

// 判断字符是否为 token 边界（空白或常见标点），用于定位独立“路径令牌”
function isBoundary(ch?: string): boolean {
  if (!ch) return true;
  if (/\s/.test(ch)) return true;
  return /[()\[\]{}<>'".,;:!?`]/.test(ch);
}

// 在文本中查找满足边界条件的 token，返回所有匹配起始索引
export function findTokenIndices(value: string, token: string): number[] {
  const indices: number[] = [];
  if (!value || !token) return indices;
  let from = 0;
  while (from <= value.length) {
    const i = value.indexOf(token, from);
    if (i === -1) break;
    const left = value[i - 1];
    const right = value[i + token.length];
    if (isBoundary(left) && isBoundary(right)) indices.push(i);
    from = i + token.length;
  }
  return indices;
}

export function hasToken(value: string, token: string): boolean {
  return findTokenIndices(value, token).length > 0;
}

// 删除满足边界条件的 token（可选择删除全部匹配）
export function removeToken(value: string, token: string, removeAll = true): { next: string; removed: number } {
  if (!value || !token) return { next: value, removed: 0 };
  const idxs = findTokenIndices(value, token);
  if (idxs.length === 0) return { next: value, removed: 0 };
  if (!removeAll) {
    const i = idxs[0];
    const next = value.slice(0, i) + value.slice(i + token.length);
    return { next, removed: 1 };
  }
  // 批量删除需从后往前避免重排索引
  let next = value;
  for (let k = idxs.length - 1; k >= 0; k--) {
    const i = idxs[k];
    next = next.slice(0, i) + next.slice(i + token.length);
  }
  return { next, removed: idxs.length };
}
