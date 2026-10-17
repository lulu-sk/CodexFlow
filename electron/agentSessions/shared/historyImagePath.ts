// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/** 规整从工具文本提取的 Windows 图片路径转义，保留 UNC 开头的双反斜杠。 */
export function normalizeHistoryImageLocalPath(value?: string): string {
  const raw = String(value || "").trim();
  if (/^[A-Za-z]:[\\/]/.test(raw))
    return raw.replace(/\\{2,}/g, "\\");
  if (/^\\{2,}[^\\/]+\\+[^\\/]+/.test(raw))
    return `\\\\${raw.replace(/^\\+/, "").replace(/\\{2,}/g, "\\")}`;
  return raw;
}

type HistoryImagePathContent = {
  localPath?: string;
  text?: string;
  src?: string;
  fallbackSrc?: string;
};

/** 修复旧缓存图片的路径、说明和预览地址，未变化时保留对象引用。 */
export function normalizeHistoryImageContent<T extends HistoryImagePathContent>(image: T): T {
  const rawPath = String(image.localPath || "");
  const localPath = rawPath ? normalizeHistoryImageLocalPath(rawPath) : image.localPath;
  const text = rawPath && localPath && image.text
    ? image.text.split(rawPath).join(localPath)
    : image.text;
  const src = normalizeHistoryImageFileUrl(image.src);
  const fallbackSrc = normalizeHistoryImageFileUrl(image.fallbackSrc);
  if (localPath === image.localPath && text === image.text && src === image.src && fallbackSrc === image.fallbackSrc)
    return image;
  return { ...image, localPath, text, src, fallbackSrc };
}

/** 合并 Windows 文件预览地址中的重复分隔符，保留 file 协议和网络主机前缀。 */
function normalizeHistoryImageFileUrl(value?: string): string | undefined {
  if (!value) return value;
  const match = value.match(/^(file:\/\/\/[A-Za-z]:\/|file:\/\/[^/]+\/)(.*)$/i);
  if (!match) return value;
  return `${match[1]}${match[2].replace(/^\/+/, "").replace(/\/{2,}/g, "/")}`;
}
