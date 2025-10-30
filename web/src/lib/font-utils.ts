// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 字体工具：解析 CSS font-family 列表、检测本地字体是否可用、
 * 并从字体栈中解析首个可用字体（用于设置页“预览实际使用字体”提示）。
 */

/**
 * 解析 font-family 栈为数组，保留原始顺序。
 * 兼容引号包裹的字体名与带空格的字体名。
 */
export function parseFontFamilyList(stack: string | null | undefined): string[] {
  const s = String(stack || "").trim();
  if (!s) return [];
  const result: string[] = [];
  let curr = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        curr += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }
    if (ch === ',') {
      const t = curr.trim();
      if (t) result.push(t);
      curr = "";
      continue;
    }
    curr += ch;
  }
  const tail = curr.trim();
  if (tail) result.push(tail);
  // 去除首尾引号（若仍保留）
  return result.map((name) => name.replace(/^(["'])(.*)\1$/, "$2").trim());
}

/**
 * 判断是否为通用族（generic family）。
 */
function isGenericFamily(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (
    n === "monospace" ||
    n === "serif" ||
    n === "sans-serif" ||
    n === "cursive" ||
    n === "fantasy" ||
    n === "system-ui" ||
    n === "ui-monospace" ||
    n === "ui-sans-serif" ||
    n === "ui-serif" ||
    n === "ui-rounded"
  );
}

/**
 * 粗略检测指定字体是否“可用”（系统已安装）。
 * 实现：比较 base 家族（monospace/serif/sans-serif）在引入目标字体前后的度量差异。
 */
export function isFontAvailable(fontName: string): boolean {
  try {
    // 优先使用 CSS Font Loading API，精准判定字体是否可用
    try {
      const fontSet: any = (document as any).fonts;
      if (fontSet && typeof fontSet.check === 'function') {
        if (fontSet.check(`12px "${fontName}"`) || fontSet.check(`12px ${fontName}`)) {
          return true;
        }
      }
    } catch {}

    const probeText = 'AaBbCcMmWw0123456789@#&*(){}[]';
    const fontSize = 64; // 放大以提升差异度
    const bases = ["monospace", "serif", "sans-serif"]; // 至少覆盖三类

    // 预先测量各 base 家族的宽度
    const baseWidths: Record<string, number> = {};
    for (const base of bases) {
      const span = document.createElement('span');
      span.textContent = probeText;
      span.style.position = 'absolute';
      span.style.left = '-9999px';
      span.style.top = '-9999px';
      span.style.fontSize = `${fontSize}px`;
      span.style.lineHeight = '1';
      span.style.letterSpacing = '0';
      span.style.whiteSpace = 'nowrap';
      span.style.fontFamily = base;
      document.body.appendChild(span);
      baseWidths[base] = span.getBoundingClientRect().width;
      document.body.removeChild(span);
    }

    // 比较引入目标字体后的宽度是否产生变化
    for (const base of bases) {
      const span = document.createElement('span');
      span.textContent = probeText;
      span.style.position = 'absolute';
      span.style.left = '-9999px';
      span.style.top = '-9999px';
      span.style.fontSize = `${fontSize}px`;
      span.style.lineHeight = '1';
      span.style.letterSpacing = '0';
      span.style.whiteSpace = 'nowrap';
      span.style.fontFamily = `'${fontName}', ${base}`;
      document.body.appendChild(span);
      const w = span.getBoundingClientRect().width;
      document.body.removeChild(span);
      if (Math.abs(w - baseWidths[base]) > 0.5) {
        return true;
      }
    }
  } catch {
    // 忽略异常：保守判定为不可用
  }
  return false;
}

export type ResolvedFont = {
  /** 实际使用的首个可用字体名；若仅命中 generic family，则返回该 generic 名 */
  name: string;
  /** 是否从首选回退（即解析到的 name 不是列表第一个具体字体） */
  isFallback: boolean;
};

/**
 * 从 CSS 字体栈中解析首个可用的字体名。
 * 策略：优先命中具体字体；若均不可用，返回遇到的第一个 generic（如 monospace）。
 */
export function resolveFirstAvailableFont(stack: string): ResolvedFont {
  const list = parseFontFamilyList(stack);
  if (list.length === 0) return { name: 'monospace', isFallback: true };
  let firstConcrete: string | null = null;
  for (const name of list) {
    if (!isGenericFamily(name)) {
      if (!firstConcrete) firstConcrete = name;
      if (isFontAvailable(name)) {
        return { name, isFallback: firstConcrete !== name };
      }
    }
  }
  // 未命中具体字体，返回首个 generic 或默认 monospace
  const generic = list.find(isGenericFamily) || 'monospace';
  return { name: generic, isFallback: true };
}

/**
 * 判断字体是否为等宽字体（monospace）。
 * 方法：比较 "iiiiiiiiii" 与 "WWWWWWWWWW" 渲染宽度是否一致。
 */
export function isMonospaceFont(fontName: string): boolean {
  try {
    const textNarrow = 'iiiiiiiiii';
    const textWide = 'WWWWWWWWWW';
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.left = '-9999px';
    container.style.top = '-9999px';
    container.style.whiteSpace = 'nowrap';
    container.style.visibility = 'hidden';
    document.body.appendChild(container);
    const mk = (t: string) => {
      const span = document.createElement('span');
      span.textContent = t;
      span.style.fontSize = '64px';
      span.style.lineHeight = '1';
      span.style.letterSpacing = '0';
      span.style.fontFamily = `'${fontName}', monospace`;
      container.appendChild(span);
      const w = span.getBoundingClientRect().width;
      container.removeChild(span);
      return w;
    };
    const w1 = mk(textNarrow);
    const w2 = mk(textWide);
    document.body.removeChild(container);
    return Math.abs(w1 - w2) < 0.5; // 允许极小的浮点误差
  } catch {
    return false;
  }
}



