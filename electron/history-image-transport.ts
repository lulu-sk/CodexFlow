// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
/// <reference lib="es2021.weakref" />

import { randomUUID } from "node:crypto";

type ImageSourceField = "src" | "fallbackSrc";
type ImageContent = { type?: string; src?: string; fallbackSrc?: string };
type ImageMessage = { content?: ImageContent[] };
type ImageResource = { reference: string; dataURL: string };
const REFERENCE_PREFIX = "codexflow-history-image:";

/** 判断图片来源是否为历史正文传输时生成的资源引用。 */
export function isHistoryImageReference(value?: string): boolean {
  return typeof value === "string" && /^codexflow-history-image:/i.test(value);
}

/** 创建有限引用表；弱引用避免在原始历史缓存淘汰后继续保留大图片。 */
export function createHistoryImageTransport(maxEntries = 8192) {
  const limit = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 8192;
  const resourcesByContent = new WeakMap<object, Partial<Record<ImageSourceField, ImageResource>>>();
  const resourcesByReference = new Map<string, WeakRef<ImageResource>>();

  /** 为某个图片字段创建稳定引用；绑定原始数据快照，避免刷新后索引错绑。 */
  function referenceSource(content: ImageContent, field: ImageSourceField): string | undefined {
    const source = content[field];
    if (typeof source !== "string" || !/^data:image\//i.test(source)) return source;
    const fields = resourcesByContent.get(content) || {};
    let resource = fields[field];
    if (!resource || resource.dataURL !== source) {
      resource = { reference: `${REFERENCE_PREFIX}${randomUUID()}`, dataURL: source };
      fields[field] = resource;
      resourcesByContent.set(content, fields);
    }
    resourcesByReference.delete(resource.reference);
    resourcesByReference.set(resource.reference, new WeakRef(resource));
    while (resourcesByReference.size > limit) {
      const oldest = resourcesByReference.keys().next().value;
      if (!oldest) break;
      resourcesByReference.delete(oldest);
    }
    return resource.reference;
  }

  /** 只转换返回视图，原始解析缓存仍保留完整图片，普通正文保留原对象。 */
  function prepareDetails<T extends { messages?: ImageMessage[] }>(details: T): T {
    if (!Array.isArray(details.messages)) return details;
    let changed = false;
    const messages = details.messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      let contentChanged = false;
      const content = message.content.map((item) => {
        if (item.type !== "image") return item;
        const src = referenceSource(item, "src");
        const fallbackSrc = referenceSource(item, "fallbackSrc");
        if (src === item.src && fallbackSrc === item.fallbackSrc) return item;
        contentChanged = true;
        return { ...item, ...(src !== undefined ? { src } : {}), ...(fallbackSrc !== undefined ? { fallbackSrc } : {}) };
      });
      if (!contentChanged) return message;
      changed = true;
      return { ...message, content };
    });
    return changed ? { ...details, messages } : details;
  }

  /** 按需读取单张图片；过期引用明确失效，重新打开历史可重新登记同一引用。 */
  function resolveSource(source?: string): string | undefined {
    if (!isHistoryImageReference(source)) return source;
    if (!/^codexflow-history-image:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(source!)) return undefined;
    const reference = source!.toLowerCase();
    const resource = resourcesByReference.get(reference)?.deref();
    if (!resource) {
      resourcesByReference.delete(reference);
      return undefined;
    }
    resourcesByReference.delete(reference);
    resourcesByReference.set(reference, new WeakRef(resource));
    return resource.dataURL;
  }

  return { prepareDetails, resolveSource };
}

export const historyImageTransport = createHistoryImageTransport();
