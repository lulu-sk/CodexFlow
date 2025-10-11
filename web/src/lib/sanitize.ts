// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 简易 HTML 白名单过滤：仅保留文本 + [a, p, br, ul, ol, li, h1-h6, strong, em, code, pre, img]
 * - 允许的属性：
 *   - a[href]
 *   - img[src, alt]
 *   - 全部剔除 on* 事件与脚本/样式标签
 * - 输出用于 innerHTML 渲染
 */
export function sanitizeHtml(input: string): string {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(input || ''), 'text/html');
    const allowed = new Set(['A', 'P', 'BR', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'EM', 'CODE', 'PRE', 'IMG']);
    const allowedAttrs: Record<string, Set<string>> = {
      'A': new Set(['href', 'target', 'rel', 'title']),
      'IMG': new Set(['src', 'alt', 'title'])
    };

    const walk = (node: Node): Node | null => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const tag = el.tagName.toUpperCase();
        // 移除脚本/样式/未知标签
        if (!allowed.has(tag)) {
          // 保留子节点文本（将当前元素替换为其子节点）
          const frag = document.createDocumentFragment();
          while (el.firstChild) frag.appendChild(walk(el.firstChild) || document.createTextNode(''));
          return frag;
        }
        // 清理所有 on* 事件与不在白名单的属性
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
          const allowSet = allowedAttrs[tag];
          if (allowSet && !allowSet.has(attr.name)) { el.removeAttribute(attr.name); continue; }
          // 安全处理 <a>：强制添加 rel=noopener noreferrer
          if (tag === 'A' && name === 'href') {
            const href = el.getAttribute('href') || '';
            // 仅允许 http/https/mailto 链接
            if (!/^(https?:|mailto:)/i.test(href)) el.removeAttribute('href');
            el.setAttribute('rel', 'noopener noreferrer');
            el.setAttribute('target', '_blank');
          }
          // 安全处理 <img>：仅允许 http/https/data:image
          if (tag === 'IMG' && name === 'src') {
            const src = el.getAttribute('src') || '';
            if (!/^(https?:|data:image\/(png|jpeg|gif|webp);base64,)/i.test(src)) el.removeAttribute('src');
          }
        }
        // 递归处理子节点
        for (const child of Array.from(el.childNodes)) {
          const res = walk(child);
          if (res !== child) {
            if (res) el.replaceChild(res, child);
            else el.removeChild(child);
          }
        }
        return el;
      } else if (node.nodeType === Node.TEXT_NODE) {
        // 文本节点原样保留
        return node;
      }
      // 其它节点类型：移除
      return document.createTextNode('');
    };

    const body = doc.body;
    for (const child of Array.from(body.childNodes)) {
      const res = walk(child);
      if (res !== child) {
        if (res) body.replaceChild(res, child);
        else body.removeChild(child);
      }
    }
    return body.innerHTML || '';
  } catch {
    return '';
  }
}

