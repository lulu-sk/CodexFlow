// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import i18n from "@/i18n/setup";

export type TerminalAdapterAPI = {
  mount: (el: HTMLElement) => { cols: number; rows: number };
  write: (data: string) => void;
  // 通过 xterm 的粘贴接口注入文本；在启用 Bracketed Paste 模式的应用中可避免逐字清洗
  // 若环境不支持 paste，则回退为 write
  paste: (data: string) => void;
  onData: (cb: (data: string) => void) => () => void;
  resize: () => { cols: number; rows: number };
  focus?: () => void;
  blur?: () => void;
  dispose: () => void;
};

export function createTerminalAdapter(): TerminalAdapterAPI {
  // 调试辅助：在控制台异常时，将关键度量写入主进程 perf.log
  // 打开方式（渲染进程控制台执行一次）：localStorage.setItem('CF_DEBUG_TERM', '1')
  // 关闭方式：localStorage.removeItem('CF_DEBUG_TERM')
  // 默认关闭日志；如需开启：localStorage.setItem('CF_DEBUG_TERM','1')
  // 调试开关：默认关闭；如需开启，执行：localStorage.setItem('CF_DEBUG_TERM','1')
  const dbgEnabled = () => {
    try { return localStorage.getItem('CF_DEBUG_TERM') === '1'; } catch { return false; }
  };
  const dlog = (msg: string) => { if (dbgEnabled()) { try { (window as any).host?.utils?.perfLog?.(msg); } catch {} } };
  // 默认启用“整行钉死”；如需禁用：localStorage.setItem('CF_DISABLE_PIN','1')
  const pinDisabled = () => {
    try {
      const v = localStorage.getItem('CF_DISABLE_PIN');
      if (v === '1') return true;
      if (v === '0') return false;
    } catch {}
    return false; // 默认启用 pin
  };

  let term: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let container: HTMLElement | null = null;
  let dprMedia: MediaQueryList | null = null;
  let removeDprListener: (() => void) | null = null;
  let removeKeydownCopyListener: (() => void) | null = null;
  let removeDocKeydownCopyListener: (() => void) | null = null;
  let removeCopyEventListener: (() => void) | null = null;
  let removePasteEventListener: (() => void) | null = null;
  let removeContextMenuListener: (() => void) | null = null;
  let removeWheelListener: (() => void) | null = null;
  let removeCtxMenuOverlay: (() => void) | null = null;
  let removeAppLevelListeners: (() => void) | null = null; // 全局监听清理（用于关闭终端右键菜单）
  let removeTermFocusListener: (() => void) | null = null;
  let removeTermBlurListener: (() => void) | null = null;
  // 防重与抑制：用于避免 Ctrl+V 同时触发 keydown + paste 导致的重复粘贴
  let lastManualPasteAt = 0; // 上次手动触发粘贴时间戳（ms）
  let suppressNativePasteUntil = 0; // 在该时间点之前忽略原生 paste 事件（ms）
  const logFocus = (state: "focus" | "blur") => {
    if (!dbgEnabled()) return;
    try { (window as any).host?.utils?.perfLog?.(`[adapter] xterm.${state}`); } catch {}
  };
  // 关键：标签页切换后强制同步滚动区域高度，避免滚轮无法滚至底部
  const syncViewportHeight = (tag: string) => {
    if (!term) return;
    try {
      const core: any = (term as any)?._core;
      const viewport = core?.viewport;
      if (viewport && typeof viewport.syncScrollArea === "function") {
        viewport.syncScrollArea(true);
        if (dbgEnabled()) {
          try {
            (window as any).host?.utils?.perfLog?.(`[adapter] viewport.sync tag=${tag}`);
          } catch {}
        }
      }
    } catch (err) {
      if (dbgEnabled()) {
        try { (window as any).host?.utils?.perfLog?.(`[adapter] viewport.sync.error tag=${tag} err=${(err as Error)?.message || err}`); } catch {}
      }
    }
  };

  // 精确 fit 并将容器高度钉在“整行像素”，消除半行余数导致的上下偏移
  const fitAndPin = (forceRefresh = true): { cols: number; rows: number } => {
    if (!term || !fitAddon || !container) return { cols: 0, rows: 0 };
    try {
      const rect0 = container.getBoundingClientRect();
      const before = { cols: term.cols, rows: term.rows };
      dlog(`[adapter] fit.start hostWH=${Math.round(rect0.width)}x${Math.round(rect0.height)} before=${before.cols}x${before.rows}`);

      // 若宿主高度为 0 或被隐藏，则跳过本次 fit/pin，避免产生 11x6 等异常度量
      try {
        const style = window.getComputedStyle(container);
        const hidden = style.display === 'none' || style.visibility === 'hidden';
        if (hidden || rect0.height <= 1) {
          dlog(`[adapter] fit.skip hiddenOrZero hidden=${hidden} rect=${Math.round(rect0.width)}x${Math.round(rect0.height)}`);
          if (forceRefresh) try { term.refresh(0, term.rows - 1); } catch {}
          return { cols: term.cols, rows: term.rows };
        }
      } catch {}
      // 第一次 fit：拿到初步行列与 cell 尺寸
      fitAddon.fit();

      // 读取 cell 高度（CSS 像素）——使用 xterm 内部渲染服务的度量
      // 说明：这里访问 _core 属于非公开属性，但这是目前获取精确 cell 尺寸的稳定方式。
      const core: any = (term as any)?._core;
      const dims = core?._renderService?.dimensions?.css?.cell || {};
      const cellH = Number(dims?.height || 0);
      const cellW = Number(dims?.width || 0);
      if (!cellH || !isFinite(cellH)) {
        dlog(`[adapter] fit.noCellH rows=${term.rows} cols=${term.cols}`);
        if (forceRefresh) try { term.refresh(0, term.rows - 1); } catch {}
        return { cols: term.cols, rows: term.rows };
      }

      if (pinDisabled()) {
        // 调试开关：禁用“整行钉死”，仅执行常规 fit
        fitAddon.fit();
        dlog(`[adapter] dims cell=${cellW.toFixed(2)}x${cellH.toFixed(2)} dpr=${(window.devicePixelRatio||1).toFixed(2)}`);
        if (forceRefresh) try { term.refresh(0, term.rows - 1); } catch {}
        dlog(`[adapter] fit.pinDisabled after=${term.cols}x${term.rows}`);
        return { cols: term.cols, rows: term.rows };
      }

      // 宿主可用像素高度；取整去掉小数抖动
      const rect = container.getBoundingClientRect();
      const hostH = Math.max(0, Math.floor(rect.height));
      
      // 计算整行数，并将容器高度钉为 rows*cellH 的整数像素，避免“半行余数”
      const rows = Math.max(2, Math.floor(hostH / cellH));
      const pinnedPx = Math.max(0, Math.round(rows * cellH));
      const want = `${pinnedPx}px`;
      const prev = (container.style.height || "").trim();
      if (prev !== want) container.style.height = want;

      // 第二次 fit：让 xterm 按钉死后的高度重新计算网格
      fitAddon.fit();
      dlog(`[adapter] fit.pinned cell=${cellW.toFixed(2)}x${cellH.toFixed(2)} hostH=${hostH} rows=${rows} pinnedPx=${pinnedPx} after=${term.cols}x${term.rows}`);
      if (forceRefresh) try { term.refresh(0, term.rows - 1); } catch {}
      syncViewportHeight("fitAndPin");
      return { cols: term.cols, rows: term.rows };
    } catch {
      try { fitAddon!.fit(); } catch {}
      return { cols: term!.cols, rows: term!.rows };
    }
  };

  const ensure = () => {
    if (!term) {
      // 终端初始化：尽量与成熟 IDE 的稳定配置对齐
      term = new Terminal({
        // 光标闪烁提升输入感知
        cursorBlink: true,
        // 光标样式：使用竖线（更接近编辑器/Windows Terminal 的“插入位”感受）
        cursorStyle: "bar",
        // 透明背景在某些机器上会影响清屏性能，若遇到问题可改为 false
        allowTransparency: true,
        // 关键：启用 sendFocus，确保在 focus/blur 时向后端发送 CSI I/O 序列，便于 Codex 感知焦点变化
        sendFocus: true,
        // Windows/ConPTY 自行处理 CR/LF，前端不应把 "\n" 强行当作 CRLF
        // 否则会与后端的换行判定叠加，放大错位风险
        convertEol: false,
        // 关键：启用 Windows 模式，禁用前端 reflow，由 ConPTY 负责软换行/重排
        windowsMode: true,
        // 明暗对比明确的配色，避免 Windows + 高 DPI 下的次像素渲染脏区
        theme: { background: "#020617", foreground: "#e2e8f0" },
        // 与容器 UI 的等宽字体保持一致
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 13,
        // 严格网格：行高与字距保持 1，减少测量误差
        lineHeight: 1,
        letterSpacing: 0,
        // 高滚动缓存，避免频繁重绘导致的“伪影残留”误判
        scrollback: 10000,
      });
      try { term.setOption("sendFocus", true); } catch {}
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      // 关键：启用 Unicode-11 宽字符算法，确保 CJK/表情等宽度计算稳定
      try {
        const unicode = new Unicode11Addon();
        term.loadAddon(unicode);
        (term as any).unicode?.activeVersion && ((term as any).unicode.activeVersion = "11");
      } catch { /* 忽略加载失败（兼容旧环境） */ }
      // 保持默认 Canvas 渲染，不主动启用 WebGL，回归最初实现的稳定渲染路径
    }
  };

  return {
    mount: (el: HTMLElement) => {
      ensure();
      container = el;
      term!.open(el);
      try { dlog(`[adapter] mount.open dpr=${window.devicePixelRatio || 1}`); } catch {}
      try {
        removeTermFocusListener?.();
      } catch {} finally { removeTermFocusListener = null; }
      try {
        removeTermBlurListener?.();
      } catch {} finally { removeTermBlurListener = null; }
      try {
        const focusDisposable = term!.onFocus(() => logFocus("focus"));
        removeTermFocusListener = () => { try { focusDisposable.dispose(); } catch {} };
      } catch { removeTermFocusListener = null; }
      try {
        const blurDisposable = term!.onBlur(() => logFocus("blur"));
        removeTermBlurListener = () => { try { blurDisposable.dispose(); } catch {} };
      } catch { removeTermBlurListener = null; }

      // 复制拦截：若存在选区，Ctrl/Cmd + C => 复制选区并阻止 ^C 透传
      try {
        const copyText = async (text: string) => {
          if (!text) return;
          try {
            if (navigator?.clipboard?.writeText) {
              await navigator.clipboard.writeText(text);
              return;
            }
          } catch {}
          try { await (window as any).host?.utils?.copyText?.(text); } catch {}
        };
        const isCopyCombo = (e: KeyboardEvent) => {
          const key = String(e.key || '').toLowerCase();
          return (
            ((e.ctrlKey || e.metaKey) && key === 'c') ||
            ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'c') ||
            ((e.ctrlKey || e.metaKey) && key === 'insert' && !e.shiftKey)
          );
        };
        const isPasteCombo = (e: KeyboardEvent) => {
          const key = String(e.key || '').toLowerCase();
          return (
            ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'v') ||
            (e.shiftKey && key === 'insert')
          );
        };
        const isStdPasteCombo = (e: KeyboardEvent) => {
          const key = String(e.key || '').toLowerCase();
          return ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'v');
        };
        const getXtermSelection = (): string => {
          try { if (term && (term as any).hasSelection?.()) return (term as any).getSelection?.() || ''; } catch {}
          return '';
        };
        const readClipboardText = async (): Promise<string> => {
          try {
            if (navigator?.clipboard?.readText) {
              const t = await navigator.clipboard.readText();
              return String(t || '');
            }
          } catch {}
          try {
            const res = await (window as any).host?.utils?.readText?.();
            if (res && res.ok) return String(res.text || '');
          } catch {}
          return '';
        };
        const pasteFromClipboard = async () => {
          try {
            const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            // 合并同一“手势”多路触发（自定义 handler + 容器捕获 + 文档捕获）
            if (now - lastManualPasteAt < 200) return;
            lastManualPasteAt = now;
            // 抑制随后可能到来的原生 paste 事件（Chromium 下有时即便 keydown.preventDefault 仍会触发）
            suppressNativePasteUntil = now + 400;
            const t = await readClipboardText();
            if (t && t.length > 0) { try { (term as any)?.paste?.(t); } catch {} }
          } catch {}
        };
        const copyAll = async () => {
          try {
            // 使用 xterm 选择 API，可靠处理换行/软换行
            const hadSel = (term as any)?.hasSelection?.() || false;
            (term as any)?.selectAll?.();
            const text = (term as any)?.getSelection?.() || '';
            if (text) await copyText(text);
            // 清理选择（不保留高亮），避免影响后续输入
            if (!hadSel) try { (term as any)?.clearSelection?.(); } catch {}
          } catch {}
        };
        const copyCurrentLogicalLine = async () => {
          try {
            const buf = (term as any)?.buffer?.active as any;
            if (!buf) return;
            const cursorAbsY = Number(buf.baseY || 0) + Number(buf.cursorY || 0);
            const len = Number(buf.length || 0);
            if (!(len > 0)) return;
            let start = Math.max(0, Math.min(cursorAbsY, len - 1));
            let end = start;
            // 向上找到逻辑行起点（首行 isWrapped=false）
            for (let y = start; y > 0; y--) {
              const line = buf.getLine?.(y);
              if (!line) break;
              if (!line.isWrapped) { start = y; break; }
              start = y - 1;
            }
            // 向下合并所有被换行包裹的行
            for (let y = start + 1; y < len; y++) {
              const line = buf.getLine?.(y);
              if (line && line.isWrapped) { end = y; }
              else break;
            }
            let out = '';
            for (let y = start; y <= end; y++) {
              const line = buf.getLine?.(y);
              if (!line) continue;
              // 对被 wrap 的行不裁剪右侧空格，末段裁剪
              const next = buf.getLine?.(y + 1);
              const isWrappedNext = !!(next && next.isWrapped);
              out += line.translateToString(!isWrappedNext);
            }
            if (out) await copyText(out);
          } catch {}
        };

        term!.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          try {
            if (isCopyCombo(e)) {
              const sel = getXtermSelection();
              if (sel && sel.length > 0) {
                copyText(sel);
                // 阻止交由 xterm 处理，从而避免向 PTY 发送 ^C
                return false;
              }
            }
            if (isPasteCombo(e) || isStdPasteCombo(e)) { pasteFromClipboard(); return false; }
          } catch {}
          return true;
        });

        // 兜底（容器级）：在容器捕获阶段拦截复制快捷键，确保在某些渲染器/浏览器差异下也不会把 ^C 透传给 PTY。
        const onKeydownCapture = (e: KeyboardEvent) => {
          try {
            if (isCopyCombo(e)) {
              const text = getXtermSelection();
              if (text && text.length > 0) {
                e.preventDefault(); e.stopPropagation();
                copyText(text);
                try { term!.refresh(0, term!.rows - 1); } catch {}
                return;
              }
            }
            if (isPasteCombo(e) || isStdPasteCombo(e)) { e.preventDefault(); e.stopPropagation(); pasteFromClipboard(); return; }
          } catch {}
        };
        container!.addEventListener('keydown', onKeydownCapture, true);
        removeKeydownCopyListener = () => {
          try { container!.removeEventListener('keydown', onKeydownCapture, true); } catch {}
        };

        // 兜底（文档级）：某些情况下事件可能落在隐藏的 textarea 或聚焦跳转，
        // 这里在捕获阶段兜底一次，但仅当事件来源/当前焦点在终端容器内时才处理，避免影响全局。
        const onDocKeydownCapture = (e: KeyboardEvent) => {
          try {
            if (!(isCopyCombo(e) || isPasteCombo(e) || isStdPasteCombo(e))) return;
            const target = e.target as any as Node | null;
            const active = (document.activeElement as any) as Node | null;
            const within = !!container && (container.contains(target || (null as any)) || container.contains(active || (null as any)));
            if (!within) return;
            if (isCopyCombo(e)) {
              const text = getXtermSelection();
              if (text && text.length > 0) {
                e.preventDefault(); e.stopPropagation();
                copyText(text);
                try { term!.refresh(0, term!.rows - 1); } catch {}
              }
            } else if (isPasteCombo(e) || isStdPasteCombo(e)) {
              e.preventDefault(); e.stopPropagation();
              pasteFromClipboard();
            }
          } catch {}
        };
        document.addEventListener('keydown', onDocKeydownCapture, true);
        removeDocKeydownCopyListener = () => {
          try { document.removeEventListener('keydown', onDocKeydownCapture, true); } catch {}
        };

        // 处理浏览器级的 copy 事件：当用户触发系统复制（菜单/快捷键）时，将 xterm 选区放入剪贴板。
        const onCopyEvent = (e: ClipboardEvent) => {
          try {
            const text = getXtermSelection();
            if (text && text.length > 0) {
              // 优先使用 ClipboardEvent 接口写入，失败则走主进程兜底
              let wrote = false;
              try {
                if (e.clipboardData) {
                  e.clipboardData.setData('text/plain', text);
                  wrote = true;
                }
              } catch {}
              if (!wrote) try { (window as any).host?.utils?.copyText?.(text); wrote = true; } catch {}
              if (wrote) {
                e.preventDefault();
                e.stopPropagation();
              }
            }
          } catch {}
        };
        container!.addEventListener('copy', onCopyEvent as any);
        removeCopyEventListener = () => {
          try { container!.removeEventListener('copy', onCopyEvent as any); } catch {}
        };

        // 粘贴事件：直接注入到终端
        const onPasteEvent = (e: ClipboardEvent) => {
          try {
            const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            // 若刚刚通过 keydown 手动触发了粘贴，则忽略这次原生 paste 事件，避免重复
            if (now < suppressNativePasteUntil) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            const data = e.clipboardData?.getData('text/plain') || '';
            if (data && data.length > 0) {
              e.preventDefault(); e.stopPropagation();
              try { (term as any)?.paste?.(data); } catch {}
            }
          } catch {}
        };
        container!.addEventListener('paste', onPasteEvent as any);
        removePasteEventListener = () => { try { container!.removeEventListener('paste', onPasteEvent as any); } catch {} };

      // 右键菜单：复制 / 粘贴
      const closeCtxMenu = () => { try { dlog('[adapter] ctxmenu.close'); } catch {}
        try { removeCtxMenuOverlay?.(); } catch {}; removeCtxMenuOverlay = null; };
        const openCtxMenu = (clientX: number, clientY: number) => {
          closeCtxMenu();
          try { dlog(`[adapter] ctxmenu.open at ${clientX},${clientY}`); } catch {}
          const backdrop = document.createElement('div');
          backdrop.style.position = 'fixed';
          backdrop.style.inset = '0';
          backdrop.style.zIndex = '10000';
          backdrop.style.background = 'transparent';
          const menu = document.createElement('div');
          menu.style.position = 'fixed';
          menu.style.left = `${clientX}px`;
          menu.style.top = `${clientY}px`;
          menu.style.minWidth = '160px';
          menu.style.background = 'rgba(255,255,255,0.95)';
          menu.style.backdropFilter = 'blur(6px)';
          menu.style.border = '1px solid rgba(0,0,0,0.08)';
          menu.style.borderRadius = '8px';
          menu.style.boxShadow = '0 10px 24px rgba(0,0,0,0.16)';
          menu.style.padding = '4px 0';
          menu.style.fontSize = '13px';
          menu.style.color = '#0f172a';
          const mkBtn = (label: string, onClick: () => void, disabled = false) => {
            const btn = document.createElement('button');
            btn.textContent = label;
            btn.style.display = 'block';
            btn.style.width = '100%';
            btn.style.textAlign = 'left';
            btn.style.padding = '8px 12px';
            btn.style.background = 'transparent';
            btn.style.border = 'none';
            btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
            btn.style.color = disabled ? 'rgba(15,23,42,0.35)' : '#0f172a';
            btn.onmouseenter = () => { if (!disabled) btn.style.background = 'rgba(0,0,0,0.05)'; };
            btn.onmouseleave = () => { btn.style.background = 'transparent'; };
            btn.onclick = (ev) => { ev.stopPropagation(); if (disabled) return; try { onClick(); } finally { closeCtxMenu(); } };
            return btn;
          };
          const selText = getXtermSelection();
          const copyBtn = mkBtn(i18n.t('terminal:ctx.copy'), () => { if (selText) copyText(selText); }, !selText);
          const copyLineBtn = mkBtn(i18n.t('terminal:ctx.copyLine'), () => { copyCurrentLogicalLine(); });
          const copyAllBtn = mkBtn(i18n.t('terminal:ctx.copyAll'), () => { copyAll(); });
          const pasteBtn = mkBtn(i18n.t('terminal:ctx.paste'), () => { pasteFromClipboard(); });
          menu.appendChild(copyBtn);
          menu.appendChild(copyLineBtn);
          menu.appendChild(copyAllBtn);
          menu.appendChild(pasteBtn);
          backdrop.appendChild(menu);
          const onBackdrop = (ev: MouseEvent) => { ev.preventDefault(); closeCtxMenu(); };
          backdrop.addEventListener('click', onBackdrop);
          backdrop.addEventListener('contextmenu', onBackdrop);
          document.body.appendChild(backdrop);
          removeCtxMenuOverlay = () => {
            try { backdrop.removeEventListener('click', onBackdrop); } catch {}
            try { backdrop.removeEventListener('contextmenu', onBackdrop); } catch {}
            try { document.body.removeChild(backdrop); } catch {}
          };
        };
        const onContextMenu = (e: MouseEvent) => { try { e.preventDefault(); e.stopPropagation(); openCtxMenu(e.clientX, e.clientY); } catch {} };
        container!.addEventListener('contextmenu', onContextMenu);
        removeContextMenuListener = () => { try { container!.removeEventListener('contextmenu', onContextMenu); } catch {} };

        // 窗口失焦或页面隐藏时，主动关闭终端右键菜单，避免透明遮罩残留拦截点击
        try {
          const onWindowBlur = () => { try { dlog('[adapter] win.blur -> ctxmenu.close'); removeCtxMenuOverlay?.(); } catch {} };
          const onVisibility = () => { try { if (document.hidden) { dlog('[adapter] doc.hidden -> ctxmenu.close'); removeCtxMenuOverlay?.(); } } catch {} };
          window.addEventListener('blur', onWindowBlur);
          document.addEventListener('visibilitychange', onVisibility);
          removeAppLevelListeners = () => {
            try { window.removeEventListener('blur', onWindowBlur); } catch {}
            try { document.removeEventListener('visibilitychange', onVisibility); } catch {}
          };
        } catch {}
      } catch { /* 忽略复制拦截异常 */ }

      // 移除强制滚轮拦截，回归 xterm 默认滚轮处理（与最初实现一致）
      removeWheelListener = null;

      // 首次渲染采用“双重 fit”：
      // 1) 立即 fitAndPin（保证即时可用且钉死整行）
      // 2) 等字体加载完成后再次精确 fitAndPin 并强制 refresh，消除度量误差引发的光标错位/重叠
      const doFit = () => { try { dlog('[adapter] doFit'); fitAndPin(true); } catch {} };
      doFit();
      try { term!.focus(); } catch {}
      try {
        if ((document as any).fonts?.ready) {
          (document as any).fonts.ready.then(() => {
            // 两帧后再 fit 一次，等待布局稳定
            requestAnimationFrame(() => requestAnimationFrame(doFit));
          });
        } else {
          // 兜底再来一次
          setTimeout(doFit, 0);
        }
      } catch { /* noop */ }

      // 监听 DPI 变更（跨显示器/系统缩放），触发重新度量
      try {
        const dppx = window.devicePixelRatio || 1;
        dprMedia = window.matchMedia(`(resolution: ${dppx}dppx)`);
        const onChange = () => { dlog('[adapter] dppx.change'); setTimeout(doFit, 0); };
        // 兼容旧浏览器 API
        if ((dprMedia as any).addEventListener) {
          (dprMedia as any).addEventListener("change", onChange);
          removeDprListener = () => (dprMedia as any).removeEventListener("change", onChange);
        } else if ((dprMedia as any).addListener) {
          (dprMedia as any).addListener(onChange);
          removeDprListener = () => (dprMedia as any).removeListener(onChange);
        }
      } catch { /* ignore */ }

      // 返回当前可用网格
      const size = { cols: term!.cols, rows: term!.rows };
      dlog(`[adapter] mount.done size=${size.cols}x${size.rows}`);
      return size;
    },
    // 在终端中拦截复制快捷键：当存在选区时，Ctrl/Cmd + C 复制文本，不向 PTY 发送 ^C
    // 说明：采用 xterm 的自定义按键处理，在 mount 后即生效。
    // 注意：保持默认行为——无选区时允许 ^C 传递（用于进程中断）。
    // 将逻辑放在 write/onData 之外，避免业务层重复判断。
    write: (data: string) => {
      term?.write(data);
    },
    // 粘贴：优先调用 xterm 内置 paste（若目标应用已启用 bracketed paste，将以原子粘贴的方式送入，减少应用层清洗）
    paste: (data: string) => {
      try {
        const anyTerm: any = term as any;
        if (anyTerm && typeof anyTerm.paste === 'function') anyTerm.paste(String(data ?? '')); else term?.write(String(data ?? ''));
      } catch { try { term?.write(String(data ?? '')); } catch {} }
    },
    onData: (cb: (data: string) => void) => {
      if (!term) ensure();
      const d = term!.onData(cb);
      return () => d.dispose();
    },
    resize: () => {
      // 每次外部要求 resize 时，执行“fit+pin”并强制 refresh
      if (!term || !fitAddon || !container) return { cols: 0, rows: 0 };
      const s = fitAndPin(true);
      dlog(`[adapter] resize -> ${s.cols}x${s.rows}`);
      return s;
    },
    // 主动聚焦隐藏 textarea，避免切换后输入法合成态残留导致的键位/光标错位
    focus: () => {
      try {
        term?.focus();
      } catch {}
      syncViewportHeight("focus");
    },
    blur: () => {
      try {
        term?.blur();
        logFocus("blur");
      } catch {}
    },
    dispose: () => {
      try { dlog('[adapter] dispose'); if (container) container.style.height = ""; } catch {}
      term?.dispose();
      term = null;
      fitAddon = null;
      container = null;
      try { removeDprListener?.(); } catch {}
      dprMedia = null;
      removeDprListener = null;
      try { removeKeydownCopyListener?.(); } catch {}
      removeKeydownCopyListener = null;
      try { removeDocKeydownCopyListener?.(); } catch {}
      removeDocKeydownCopyListener = null;
      try { removeCopyEventListener?.(); } catch {}
      removeCopyEventListener = null;
      try { removePasteEventListener?.(); } catch {}
      removePasteEventListener = null;
      try { removeContextMenuListener?.(); } catch {}
      removeContextMenuListener = null;
      try { removeWheelListener?.(); } catch {}
      removeWheelListener = null;
      try { removeCtxMenuOverlay?.(); } catch {}
      try { removeAppLevelListeners?.(); } catch {}
      removeCtxMenuOverlay = null;
      removeAppLevelListeners = null;
      try { removeTermFocusListener?.(); } catch {}
      try { removeTermBlurListener?.(); } catch {}
      removeTermFocusListener = null;
      removeTermBlurListener = null;
    }
  };
}
