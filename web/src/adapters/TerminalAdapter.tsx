// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import i18n from "@/i18n/setup";
import { copyTextCrossPlatform, readTextCrossPlatform } from "@/lib/clipboard";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  getTerminalTheme,
  normalizeTerminalAppearance,
  type TerminalAppearance,
} from "@/lib/terminal-appearance";

export type TerminalAdapterAPI = {
  mount: (el: HTMLElement) => { cols: number; rows: number };
  write: (data: string) => void;
  // 通过 xterm 的粘贴接口注入文本；在启用 Bracketed Paste 模式的应用中可避免逐字清洗
  // 若环境不支持 paste，则回退为 write
  paste: (data: string) => void;
  onData: (cb: (data: string) => void) => () => void;
  resize: () => { cols: number; rows: number };
  /** 中文说明：读取当前滚动快照（用于标签切换/隐藏恢复滚动条位置）。 */
  getScrollSnapshot: () => TerminalScrollSnapshot | null;
  /** 中文说明：同步滚动条指示与缓冲区视图；传空则以当前视图执行一次“对齐修复”（不强制滚动内容）。 */
  restoreScrollSnapshot: (snapshot?: TerminalScrollSnapshot | null) => void;
  focus?: () => void;
  blur?: () => void;
  setAppearance: (appearance: Partial<TerminalAppearance>) => void;
  dispose: () => void;
};

export type TerminalScrollSnapshot = {
  viewportY: number;
  baseY: number;
  isAtBottom: boolean;
};

export type TerminalAdapterOptions = {
  appearance?: Partial<TerminalAppearance>;
};

export function createTerminalAdapter(options?: TerminalAdapterOptions): TerminalAdapterAPI {
  // 调试辅助：统一配置（preload 注入只读缓存）
  const dbgEnabled = () => { try { return !!(globalThis as any).__cf_term_debug__; } catch { return false; } };
  const dlog = (msg: string) => { if (dbgEnabled()) { try { (window as any).host?.utils?.perfLog?.(msg); } catch {} } };
  // “整行钉死”从统一配置读取
  const pinDisabled = () => { try { return !!(globalThis as any).__cf_disable_pin__; } catch { return false; } };
  const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  // 说明：部分插件（例如 uTools）会在鼠标侧键上模拟 Ctrl+C，这里以时间窗口识别并阻断“伪 Ctrl+C”
  const AUX_MOUSE_CTRL_TIMEOUT_MS = 600;
  // 研究与工程取舍：
  // - 键击动力学的普通字母对“飞行时间”常见在 80–200ms；但“修饰键+字母”的最短间隔可显著更短。
  // - 为避免误杀真实 Ctrl+C，这里将“可疑 Ctrl→C 间隔”收紧为 30ms，仅倾向命中脚本/模拟注入；
  //   若需要在特定环境进一步调优，可通过 globalThis.__cf_synth_ctrl_c_threshold_ms 覆盖。
  const SYNTH_CTRL_C_THRESHOLD_MS = (() => {
    try {
      const v = Number((globalThis as any).__cf_synth_ctrl_c_threshold_ms);
      return isFinite(v) && v > 0 ? v : 30;
    } catch {
      return 30;
    }
  })();
  const SYNTH_CTRL_C_STALE_MS = 1500;

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
  let removeAuxMouseListener: (() => void) | null = null;
  let removeTermFocusListener: (() => void) | null = null;
  let removeTermBlurListener: (() => void) | null = null;
  let removeScrollListener: (() => void) | null = null;
  // 防重与抑制：用于避免 Ctrl+V 同时触发 keydown + paste 导致的重复粘贴
  let lastManualPasteAt = 0; // 上次手动触发粘贴时间戳（ms）
  let suppressNativePasteUntil = 0; // 在该时间点之前忽略原生 paste 事件（ms）
  let lastAuxMouseDownAt = 0; // 最近一次检测到鼠标侧键按下（ms）
  let lastCtrlKeydownAt = 0; // 最近一次 Ctrl 键按下（ms）
  // 低版本 Windows（ConPTY < 21376）降级重排开关与状态
  let legacyWinNeedsReflowHack = false;
  let legacyWinBuild = 0;
  let legacyLastCols = 0;
  let appearance: TerminalAppearance = normalizeTerminalAppearance(options?.appearance);
  let lastScrollSnapshot: TerminalScrollSnapshot | null = null;

  /**
   * 中文说明：读取 xterm 的滚动快照（以 buffer.active.viewportY/baseY 为准）。
   * 该数据与 DOM 的 scrollTop 解耦，可用于修复“内容位置正确但滚动条指示错误”的偶发不一致。
   */
  const readScrollSnapshot = (): TerminalScrollSnapshot | null => {
    if (!term) return null;
    try {
      const buf: any = (term as any)?.buffer?.active;
      if (!buf) return null;
      const viewportY = Number(buf.viewportY ?? buf.ydisp ?? 0);
      const baseY = Number(buf.baseY ?? buf.ybase ?? 0);
      if (!isFinite(viewportY) || !isFinite(baseY)) return null;
      const isAtBottom = baseY - viewportY <= 1;
      return { viewportY: Math.max(0, viewportY), baseY: Math.max(0, baseY), isAtBottom };
    } catch {
      return null;
    }
  };

  /**
   * 中文说明：将 DOM 滚动条位置与 xterm 缓冲区视图对齐。
   *
   * 设计目标
   * - 修复在 `display:none`/标签切换等场景下，出现“内容位置正确但滚动条滑块位置错误”的偶发不一致。
   *
   * 注意事项
   * - 该函数不调用 `scrollToBottom/scrollToLine`，不主动改变缓冲区视图（避免干扰用户的滚动/拖拽）。
   */
  const syncScrollbarToSnapshot = (snapshot?: TerminalScrollSnapshot | null, tag = "sync") => {
    if (!term || !container) return;
    const current = readScrollSnapshot();
    const effective = current || snapshot || lastScrollSnapshot;
    if (!effective) return;

    // 先同步 scrollArea，确保 viewport.scrollHeight 可靠
    try { syncViewportHeight(`scrollbar.${tag}`); } catch {}

    try {
      const viewport = container.querySelector(".xterm-viewport") as HTMLDivElement | null;
      if (!viewport) return;

      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const baseY = Math.max(0, Number(effective.baseY || 0));
      const viewportY = Math.max(0, Number(effective.viewportY || 0));

      let perLinePx = 0;
      try {
        const core: any = (term as any)?._core;
        const dims = core?._renderService?.dimensions?.css?.cell || {};
        const cellH = Number(dims?.height || 0);
        if (cellH && isFinite(cellH)) perLinePx = cellH;
      } catch {}
      // 若拿不到 cell 尺寸，则用最大可滚动距离反推每行像素（maxScrollTop ≈ baseY * lineHeightPx）
      if (!perLinePx && baseY > 0 && maxScrollTop > 0) {
        perLinePx = maxScrollTop / baseY;
      }
      if (!perLinePx || !isFinite(perLinePx) || perLinePx <= 0) return;

      const target = Math.round(viewportY * perLinePx);
      const clamped = Math.max(0, Math.min(target, maxScrollTop));
      // 仅在差异明显时写入，避免频繁写 scrollTop 导致抖动
      if (Math.abs((viewport.scrollTop || 0) - clamped) > 1) {
        viewport.scrollTop = clamped;
      }
    } catch {}

    lastScrollSnapshot = readScrollSnapshot();
  };

  const applyAppearanceToTerminal = (next: TerminalAppearance) => {
    appearance = next;
    if (!term) return;
    const palette = getTerminalTheme(next.theme).palette;
    let fontApplied = false;
    try {
      const setOption = (term as any).setOption;
      if (typeof setOption === "function") {
        setOption.call(term, "fontFamily", appearance.fontFamily);
        fontApplied = true;
      }
    } catch {}
    if (!fontApplied) {
      try {
        const opts: any = (term as any).options;
        if (opts && typeof opts === "object") {
          opts.fontFamily = appearance.fontFamily;
        }
      } catch {}
    }
    let themeApplied = false;
    try {
      const setOption = (term as any).setOption;
      if (typeof setOption === "function") {
        setOption.call(term, "theme", palette);
        themeApplied = true;
      }
    } catch {}
    if (!themeApplied) {
      try {
        const opts: any = (term as any).options;
        if (opts && typeof opts === "object") {
          opts.theme = palette;
        }
      } catch {}
    }
    try { fitAndPin(true); } catch {}
    try { term.refresh(0, term.rows - 1); } catch {}
  };
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
      const parentEl = container.parentElement;
      const parentRect0 = parentEl?.getBoundingClientRect() || null;
      // 缩小时以父容器尺寸为准，避免被上一次“钉住高度”干扰
      const hostW0 = parentRect0 ? parentRect0.width : rect0.width;
      const hostH0 = parentRect0 ? parentRect0.height : rect0.height;
      const before = { cols: term.cols, rows: term.rows };
      dlog(
        `[adapter] fit.start hostWH=${Math.round(hostW0)}x${Math.round(hostH0)} before=${before.cols}x${before.rows}`
      );

      // 若宿主高度为 0 或被隐藏，则跳过本次 fit/pin，避免产生 11x6 等异常度量
      try {
        const style = window.getComputedStyle(container);
        const hiddenSelf = style.display === "none" || style.visibility === "hidden";
        let hidden = hiddenSelf;
        if (!hidden && parentEl) {
          try {
            const parentStyle = window.getComputedStyle(parentEl);
            hidden = parentStyle.display === "none" || parentStyle.visibility === "hidden";
          } catch {}
        }
        const zero = hostH0 <= 1 || hostW0 <= 1;
        if (hidden || zero) {
          dlog(
            `[adapter] fit.skip hiddenOrZero hidden=${hidden} host=${Math.round(hostW0)}x${Math.round(hostH0)}`
          );
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
      const parentRect = parentEl?.getBoundingClientRect() || null;
      // 真正可用的宿主尺寸：优先使用父容器尺寸
      const hostWidth = parentRect ? parentRect.width : rect.width;
      const hostHeight = parentRect ? parentRect.height : rect.height;
      const hostH = Math.max(0, Math.floor(hostHeight));
      
      // 计算整行数，并确保终端容器高度与宿主一致（px -> 100%），再按整数行/列重算
      const rows = Math.max(2, Math.floor(hostH / cellH));
      const pinnedPx = Math.max(0, Math.round(rows * cellH));
      // 旧版本通过将容器直接钉死为 pinnedPx，导致宿主剩余几像素的空隙。这里统一改为 100%，
      // 既保留整数行策略，又让滚动条视觉上贴合底边。
      if ((container.style.height || "").trim() !== "100%") {
        container.style.height = "100%";
      }

      // 第二次 fit：让 xterm 按钉死后的高度重新计算网格
      fitAddon.fit();
      dlog(
        `[adapter] fit.pinned cell=${cellW.toFixed(2)}x${cellH.toFixed(2)} host=${Math.round(hostWidth)}x${hostH} rows=${rows} pinnedPx=${pinnedPx} after=${term.cols}x${term.rows}`
      );
      // 低版本 Windows：尝试一次“临时关闭 windowsMode + 列宽轻抖动”的降级重排
      try {
        if (legacyWinNeedsReflowHack && term && term.cols) {
          const need = legacyLastCols !== term.cols;
          if (need) {
            const targetCols = term.cols;
            const prevMode = !!((term as any)?.options?.windowsMode);
            dlog(`[adapter] legacy.reflow try build=${legacyWinBuild} targetCols=${targetCols}`);
            try {
              (term as any).options = { windowsMode: false } as any;
              try { (term as any).resize(Math.max(2, targetCols - 1), term.rows); } catch {}
              try { (term as any).resize(targetCols, term.rows); } catch {}
            } catch {} finally {
              try { (term as any).options = { windowsMode: prevMode } as any; } catch {}
            }
            legacyLastCols = targetCols;
          }
        }
      } catch {}
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
      const themePalette = getTerminalTheme(appearance.theme).palette;
      term = new Terminal({
        // 光标闪烁提升输入感知
        cursorBlink: true,
        // 光标样式：使用竖线（更接近编辑器/Windows Terminal 的“插入位”感受）
        cursorStyle: "bar",
        // 透明背景在某些机器上会影响清屏性能，若遇到问题可改为 false
        allowTransparency: true,
        // Windows/ConPTY 自行处理 CR/LF，前端不应把 "\n" 强行当作 CRLF
        // 否则会与后端的换行判定叠加，放大错位风险
        convertEol: false,
        // 关键：启用 Windows 模式，禁用前端 reflow，由 ConPTY 负责软换行/重排
        windowsMode: true,
        // 根据用户选择应用终端主题
        theme: themePalette,
        // 与容器 UI 的等宽字体保持一致
        fontFamily: appearance.fontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
        fontSize: 13,
        // 严格网格：行高与字距保持 1，减少测量误差
        lineHeight: 1,
        letterSpacing: 0,
        // 高滚动缓存，避免频繁重绘导致的“伪影残留”误判
        scrollback: 10000,
      });
      // 在 Windows + ConPTY 且系统构建号 >= 21376 时，启用 xterm 的 reflow（对滚动缓冲区重排）
      try {
        const queryWin = async () => {
          try {
            const api = (window as any).host?.utils?.getWindowsInfo;
            if (typeof api !== 'function') return;
            const info = await api();
            if (!info || info.ok === false) return;
            if (String(info.platform || '').toLowerCase() !== 'win32') return;
            const build = Number(info.buildNumber || 0);
            if (build >= 21376) {
              try {
                (term as any).options = { windowsPty: { backend: 'conpty', buildNumber: build } } as any;
                // 再次 fit 触发一次 buffer.resize，从而对历史缓冲区执行 reflow
                requestAnimationFrame(() => {
                  try { fitAddon?.fit(); term?.refresh(0, (term as any)?.rows - 1); syncViewportHeight("win.reflow"); } catch {}
                });
              } catch {}
            } else {
              // 低版本 Windows：记录需要启用降级重排策略
              legacyWinNeedsReflowHack = true;
              legacyWinBuild = build;
              legacyLastCols = (term as any)?.cols || 0;
            }
          } catch {}
        };
        // 异步查询，尽量不阻塞初始化；结果到达后自动应用
        queryWin();
      } catch {}
      // v5 无 sendFocus 选项：焦点变更由上层 TerminalManager 注入 ESC 序列处理
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
      // 记录滚动快照：用于标签切换/隐藏后恢复滚动条指示
      try {
        removeScrollListener?.();
      } catch {} finally {
        removeScrollListener = null;
      }
      try {
        const disp = term.onScroll(() => {
          lastScrollSnapshot = readScrollSnapshot();
        });
        removeScrollListener = () => disp.dispose();
      } catch {
        removeScrollListener = null;
      }
    }
  };

  return {
    mount: (el: HTMLElement) => {
      ensure();
      // 先清理上一次 mount 残留的监听与覆盖层，确保幂等
      try { removeDprListener?.(); } catch {} finally { dprMedia = null; removeDprListener = null; }
      try { removeKeydownCopyListener?.(); } catch {} finally { removeKeydownCopyListener = null; }
      try { removeDocKeydownCopyListener?.(); } catch {} finally { removeDocKeydownCopyListener = null; }
      try { removeCopyEventListener?.(); } catch {} finally { removeCopyEventListener = null; }
      try { removePasteEventListener?.(); } catch {} finally { removePasteEventListener = null; }
      try { removeContextMenuListener?.(); } catch {} finally { removeContextMenuListener = null; }
      try { removeWheelListener?.(); } catch {} finally { removeWheelListener = null; }
      try { removeAuxMouseListener?.(); } catch {} finally { removeAuxMouseListener = null; }
      try { removeCtxMenuOverlay?.(); } catch {} finally { removeCtxMenuOverlay = null; }
      try { removeAppLevelListeners?.(); } catch {} finally { removeAppLevelListeners = null; }
      container = el;
      term!.open(el);
      try { dlog(`[adapter] mount.open dpr=${window.devicePixelRatio || 1}`); } catch {}
      try {
        removeTermFocusListener?.();
      } catch {} finally { removeTermFocusListener = null; }
      try {
        removeTermBlurListener?.();
      } catch {} finally { removeTermBlurListener = null; }
      // xterm v5 无 onFocus/onBlur 事件：保留占位，焦点日志由上层切换时机驱动

      // 复制拦截：若存在选区，Ctrl/Cmd + C => 复制选区并阻止 ^C 透传
      try {
        const copyText = async (text: string) => {
          if (!text) return;
          try { await copyTextCrossPlatform(text, { preferBrowser: true }); } catch {}
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
            const text = await readTextCrossPlatform({ preferBrowser: true });
            return String(text || '');
          } catch {
            return '';
          }
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
        // 侧键识别：记录最近一次 AUX（前进/后退）鼠标按键，并在一定时间内将其视为“侧键触发”
        const hasRecentAuxMouseGesture = () => {
          try {
            if (lastAuxMouseDownAt <= 0) return false;
            const span = nowMs() - lastAuxMouseDownAt;
            if (!isFinite(span) || span < 0) return false;
            return span <= AUX_MOUSE_CTRL_TIMEOUT_MS;
          } catch {
            return false;
          }
        };
        const consumeAuxMouseGesture = () => {
          const hit = hasRecentAuxMouseGesture();
          if (hit) lastAuxMouseDownAt = 0;
          return hit;
        };
        const isAuxMouseButton = (btn: number, buttons: number | undefined) => {
          if (btn === 3 || btn === 4) return true;
          if (typeof buttons !== "number") return false;
          return (buttons & 8) === 8 || (buttons & 16) === 16;
        };
        const markAuxMouseDown = () => {
          try { lastAuxMouseDownAt = nowMs(); } catch { lastAuxMouseDownAt = Date.now(); }
        };
        // Ctrl+C 判定：若 Ctrl 与 C 在极短时间内连续触发，判定为外部模拟而非用户主动中断
        const consumeSuspiciousCtrlCombo = () => {
          if (lastCtrlKeydownAt <= 0) return false;
          try {
            const span = nowMs() - lastCtrlKeydownAt;
            if (!isFinite(span) || span < 0) {
              lastCtrlKeydownAt = 0;
              return false;
            }
            if (span <= SYNTH_CTRL_C_THRESHOLD_MS) {
              lastCtrlKeydownAt = 0;
              return true;
            }
            if (span >= SYNTH_CTRL_C_STALE_MS) {
              lastCtrlKeydownAt = 0;
            }
            return false;
          } catch {
            lastCtrlKeydownAt = 0;
            return false;
          }
        };
        const maybeMarkCtrlKeydown = (e: KeyboardEvent) => {
          try {
            const key = String(e.key || "").toLowerCase();
            if (key === "control" || key === "ctrl") {
              lastCtrlKeydownAt = nowMs();
            }
          } catch {
            lastCtrlKeydownAt = Date.now();
          }
        };
        const onPointerDownCapture = (e: PointerEvent) => {
          try {
            if (e.pointerType && e.pointerType !== "mouse") return;
            if (isAuxMouseButton(e.button, e.buttons)) markAuxMouseDown();
          } catch {}
        };
        const onMouseDownCapture = (e: MouseEvent) => {
          try {
            if (isAuxMouseButton(e.button, e.buttons)) markAuxMouseDown();
          } catch {}
        };
        // 捕获全局 auxclick：部分浏览器不会在 pointerdown/mousedown 上报侧键，但会触发 auxclick
        const onWindowAuxClickCapture = (e: MouseEvent) => {
          try {
            if (!container) return;
            if (!isAuxMouseButton(e.button, e.buttons)) return;
            const target = e.target as Node | null;
            const active = (document.activeElement as any as Node | null) || null;
            const within = container.contains(target || (null as any)) || container.contains(active || (null as any));
            if (within) markAuxMouseDown();
          } catch {}
        };
        const auxDisposers: (() => void)[] = [];
        try {
          const host = container!;
          host.addEventListener("pointerdown", onPointerDownCapture, true);
          auxDisposers.push(() => {
            try { host.removeEventListener("pointerdown", onPointerDownCapture, true); } catch {}
          });
          host.addEventListener("mousedown", onMouseDownCapture, true);
          auxDisposers.push(() => {
            try { host.removeEventListener("mousedown", onMouseDownCapture, true); } catch {}
          });
        } catch {}
        try {
          window.addEventListener("auxclick", onWindowAuxClickCapture, true);
          auxDisposers.push(() => {
            try { window.removeEventListener("auxclick", onWindowAuxClickCapture, true); } catch {}
          });
        } catch {}
        removeAuxMouseListener = () => {
          while (auxDisposers.length > 0) {
            const dispose = auxDisposers.pop();
            if (!dispose) continue;
            try { dispose(); } catch {}
          }
        };

        term!.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          try {
            maybeMarkCtrlKeydown(e);
            if (isCopyCombo(e)) {
              const sel = getXtermSelection();
              if (sel && sel.length > 0) {
                copyText(sel);
                // 阻止交由 xterm 处理，从而避免向 PTY 发送 ^C
                return false;
              }
              if (consumeAuxMouseGesture() || consumeSuspiciousCtrlCombo()) {
                // 无选区且满足“侧键/伪 Ctrl+C”条件，不向 PTY 传递中断信号
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
            maybeMarkCtrlKeydown(e);
            if (isCopyCombo(e)) {
              const text = getXtermSelection();
              if (text && text.length > 0) {
                e.preventDefault(); e.stopPropagation();
                copyText(text);
                try { term!.refresh(0, term!.rows - 1); } catch {}
                return;
              }
              if (consumeAuxMouseGesture() || consumeSuspiciousCtrlCombo()) {
                // 阻止侧键模拟的 Ctrl+C 继续冒泡，保持终端进程不被意外中断
                e.preventDefault();
                e.stopPropagation();
                return;
              }
            }
            if (isPasteCombo(e) || isStdPasteCombo(e)) { e.preventDefault(); e.stopPropagation(); pasteFromClipboard(); return; }
          } catch {}
        };
        const hostForKeydown = container!;
        hostForKeydown.addEventListener('keydown', onKeydownCapture, true);
        removeKeydownCopyListener = () => {
          try { hostForKeydown.removeEventListener('keydown', onKeydownCapture, true); } catch {}
        };

        // 兜底（文档级）：某些情况下事件可能落在隐藏的 textarea 或聚焦跳转，
        // 这里在捕获阶段兜底一次，但仅当事件来源/当前焦点在终端容器内时才处理，避免影响全局。
        const onDocKeydownCapture = (e: KeyboardEvent) => {
          try {
            maybeMarkCtrlKeydown(e);
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
              else if (consumeAuxMouseGesture() || consumeSuspiciousCtrlCombo()) {
                // 文档捕获层同样屏蔽“伪 Ctrl+C”，避免冒泡至其它快捷键处理器
                e.preventDefault();
                e.stopPropagation();
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
        const onCopyEvent = async (e: ClipboardEvent) => {
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
              if (!wrote) {
                try {
                  wrote = await copyTextCrossPlatform(text, { preferBrowser: true });
                } catch {
                  wrote = false;
                }
              }
              if (wrote) {
                e.preventDefault();
                e.stopPropagation();
              }
            }
          } catch {}
        };
        const hostForCopy = container!;
        hostForCopy.addEventListener('copy', onCopyEvent as any);
        removeCopyEventListener = () => {
          try { hostForCopy.removeEventListener('copy', onCopyEvent as any); } catch {}
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
        const hostForPaste = container!;
        hostForPaste.addEventListener('paste', onPasteEvent as any);
        removePasteEventListener = () => { try { hostForPaste.removeEventListener('paste', onPasteEvent as any); } catch {} };

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
        const hostForContextMenu = container!;
        hostForContextMenu.addEventListener('contextmenu', onContextMenu);
        removeContextMenuListener = () => { try { hostForContextMenu.removeEventListener('contextmenu', onContextMenu); } catch {} };

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
        const media = window.matchMedia(`(resolution: ${dppx}dppx)`);
        dprMedia = media;
        const onChange = () => { dlog('[adapter] dppx.change'); setTimeout(doFit, 0); };
        // 兼容旧浏览器 API
        if ((media as any).addEventListener) {
          (media as any).addEventListener("change", onChange);
          removeDprListener = () => (media as any).removeEventListener("change", onChange);
        } else if ((media as any).addListener) {
          (media as any).addListener(onChange);
          removeDprListener = () => (media as any).removeListener(onChange);
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
    getScrollSnapshot: () => {
      if (!term) ensure();
      const snapshot = readScrollSnapshot();
      lastScrollSnapshot = snapshot;
      return snapshot;
    },
    restoreScrollSnapshot: (snapshot?: TerminalScrollSnapshot | null) => {
      if (!term) ensure();
      try { syncScrollbarToSnapshot(snapshot ?? null, "restore"); } catch {}
      // 二次对齐：用于处理标签刚切回时 DOM 尚未稳定的场景
      try { requestAnimationFrame(() => { try { syncScrollbarToSnapshot(snapshot ?? null, "restore.raf"); } catch {} }); } catch {}
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
    setAppearance: (partial) => {
      const next = normalizeTerminalAppearance(partial, appearance);
      // 仅当字体与主题都未变化时才跳过，保证主题切换能即时落地
      if (next.fontFamily === appearance.fontFamily && next.theme === appearance.theme) return;
      applyAppearanceToTerminal(next);
    },
    dispose: () => {
      try { dlog('[adapter] dispose'); if (container) container.style.height = ""; } catch {}
      // 先移除所有监听与覆盖层，再置空 container，避免移除阶段拿不到宿主元素
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
      try { removeAuxMouseListener?.(); } catch {}
      removeAuxMouseListener = null;
      try { removeCtxMenuOverlay?.(); } catch {}
      try { removeAppLevelListeners?.(); } catch {}
      removeCtxMenuOverlay = null;
      removeAppLevelListeners = null;
      try { removeTermFocusListener?.(); } catch {}
      try { removeTermBlurListener?.(); } catch {}
      removeTermFocusListener = null;
      removeTermBlurListener = null;
      try { removeScrollListener?.(); } catch {}
      removeScrollListener = null;
      // 释放终端与引用
      term?.dispose();
      term = null;
      fitAddon = null;
      container = null;
      lastAuxMouseDownAt = 0;
      lastCtrlKeydownAt = 0;
      lastScrollSnapshot = null;
    }
  };
}
