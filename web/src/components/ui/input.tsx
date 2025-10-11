// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { cn } from '@/lib/utils';

// 支持可选的 multiline 行为：当 multiline 为 true 时渲染为 textarea 并默认将高度提升三倍；
// 否则保持原生 input 行为并恢复为原始高度（h-10）。这样可以避免全局替换导致的垂直居中问题。
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement>, React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 是否渲染为多行输入（textarea） */
  multiline?: boolean;
}

export const Input = React.forwardRef<HTMLTextAreaElement | HTMLInputElement, InputProps>(({ className, multiline, ...props }, ref) => {
  const base = 'flex w-full rounded-md border border-slate-200 bg-white px-3 text-sm ring-offset-white placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-950/10';
  // 统一处理 Pointer Capture：将拖拽事件锁定在输入框内，避免拖拽误选外部文字
  const { onPointerDown: externalOnPointerDown, ...restProps } = props as any;

  if (multiline) {
    // textarea 默认文字从左上开始，设置为不可调整大小以保持布局一致
    return (
      <textarea
        ref={ref as any}
        className={cn(base, 'h-[7.5rem] py-2 resize-none select-text', className)}
        onPointerDown={(e) => { try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {} try { externalOnPointerDown && externalOnPointerDown(e); } catch {} }}
        {...(restProps as React.TextareaHTMLAttributes<HTMLTextAreaElement>)}
      />
    );
  }

  return (
    <input
      ref={ref as any}
      className={cn(base, 'h-10 py-2 select-text', className)}
      onPointerDown={(e) => { try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {} try { externalOnPointerDown && externalOnPointerDown(e); } catch {} }}
      {...(restProps as React.InputHTMLAttributes<HTMLInputElement>)}
    />
  );
});
Input.displayName = 'Input';

