// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

// 计算 textarea/input 的光标相对视口的像素坐标
// 实现思路：复制样式到隐藏 div，插入与 selectionStart 之前相同的文本，通过 span 的偏移计算位置。

export type CaretPosition = { left: number; top: number; height: number };

function copyStyle(source: HTMLElement, target: HTMLElement) {
  const style = window.getComputedStyle(source);
  const props = [
    "direction","boxSizing","width","height","overflowX","overflowY",
    "borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth",
    "paddingTop","paddingRight","paddingBottom","paddingLeft",
    "fontStyle","fontVariant","fontWeight","fontStretch","fontSize","fontFamily","lineHeight","letterSpacing","textTransform","textAlign","textIndent","whiteSpace","wordBreak","wordSpacing"
  ];
  for (const p of props) (target.style as any)[p] = (style as any)[p];
}

export function getCaretViewportPosition(el: HTMLTextAreaElement | HTMLInputElement, selectionIndex: number): CaretPosition {
  const isTextarea = (el as HTMLTextAreaElement).selectionStart !== undefined;
  const div = document.createElement("div");
  document.body.appendChild(div);
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  copyStyle(el as any, div);

  const value = String((el as any).value || "");
  const before = value.substring(0, selectionIndex);
  const after = value.substring(selectionIndex) || " ";
  const span = document.createElement("span");
  span.textContent = after[0] || " ";
  div.textContent = before;
  div.appendChild(span);

  const rect = span.getBoundingClientRect();
  const divRect = div.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const left = elRect.left + (rect.left - divRect.left) - el.scrollLeft;
  const top = elRect.top + (rect.top - divRect.top) - el.scrollTop;
  const height = rect.height || parseFloat(window.getComputedStyle(el).lineHeight || "16");
  document.body.removeChild(div);
  return { left, top, height };
}


