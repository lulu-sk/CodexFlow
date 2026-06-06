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
  /** 只测量当前 DOM 可容纳的终端行列，不改变 xterm 当前行列。 */
  measureResize?: () => { cols: number; rows: number };
  /** 按 Manager 已提交给 PTY 的行列更新本地 xterm，保证输出解析尺寸一致。 */
  resizeTo?: (size: { cols: number; rows: number }, source?: string) => { cols: number; rows: number };
  /** 判断是否仍有 PTY 输出等待写入 xterm。 */
  hasPendingWriteWork?: () => boolean;
  /** 中文说明：读取当前滚动快照（用于标签切换/隐藏恢复滚动条位置）。 */
  getScrollSnapshot: () => TerminalScrollSnapshot | null;
  /** 中文说明：同步滚动条指示与缓冲区视图；传空则以当前视图执行一次“对齐修复”（不强制滚动内容）。 */
  restoreScrollSnapshot: (snapshot?: TerminalScrollSnapshot | null) => void;
  /** 中文说明：读取光标附近的逻辑文本快照，用于发送后判断输入区是否已真正接住粘贴内容。 */
  readCursorTextSnapshot?: (options?: TerminalCursorTextSnapshotOptions) => TerminalCursorTextSnapshot | null;
  /** 中文说明：通知适配器真实 PTY resize 已排队，resize 锚点需等到 PTY resize 下发或取消后再释放。 */
  notifyPtyResizePending?: (size: { cols: number; rows: number }, source: string) => void;
  /** 中文说明：通知适配器真实 PTY resize 已下发或取消，用于关闭 pending 窗口并重新启动释放检查。 */
  notifyPtyResizeComplete?: (size: { cols: number; rows: number }, source: string, result: "sent" | "skipped" | "failed") => void;
  /** 中文说明：通知适配器宿主布局 resize 已开始，提前保存底部跟随意图，避免浏览器 viewport clamp 污染锚点。 */
  notifyLayoutResizeStart?: (source: string) => void;
  /** 订阅因 pending reset 输出而延后的 resize 重试信号。 */
  onDeferredResizeReady?: (cb: () => void) => () => void;
  focus?: () => void;
  blur?: () => void;
  setAppearance: (appearance: Partial<TerminalAppearance>) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  dispose: () => void;
};

export type TerminalScrollSnapshot = {
  viewportY: number;
  baseY: number;
  isAtBottom: boolean;
};

type TerminalDomScrollState = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  maxScrollTop: number;
};

type TerminalBufferDebugState = {
  type: string;
  length: number;
  cursorY: number;
};

type ViewportReadAnchor = {
  viewportY: number;
  baseY: number;
  cols: number;
  rows: number;
  distanceFromBottom: number;
  ratio: number;
  isAtBottom: boolean;
  createdAt: number;
  source: string;
};

type ViewportResizeMode = "follow-bottom" | "read-anchor";

type ViewportResizeTransaction = {
  id: number;
  mode: ViewportResizeMode;
  anchor: ViewportReadAnchor;
  startedAt: number;
  lastActivityAt: number;
  observedBaseY: number;
  observedBaseYChangedAt: number;
  terminalResetObservedAt: number | null;
  outputAfterResetObservedAt: number | null;
  singleScreenRefreshAt: number | null;
  ptyResizePending: boolean;
  ptyResizePendingAt: number | null;
  ptyResizeCompletedAt: number | null;
  ptyResizeCompletedResult: "sent" | "skipped" | "failed" | null;
  outputObserved: boolean;
  restoreCount: number;
  releaseTimer: number | null;
};

export type TerminalCursorTextSnapshotOptions = {
  linesBefore?: number;
  linesAfter?: number;
  maxChars?: number;
};

export type TerminalCursorTextSnapshot = {
  bufferType: string;
  cursorAbsY: number;
  startAbsY: number;
  endAbsY: number;
  lines: string[];
  text: string;
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
  let removeViewportScrollDebugListener: (() => void) | null = null;
  // 防重与抑制：用于避免 Ctrl+V 同时触发 keydown + paste 导致的重复粘贴
  let lastManualPasteAt = 0; // 上次手动触发粘贴时间戳（ms）
  let suppressNativePasteUntil = 0; // 在该时间点之前忽略原生 paste 事件（ms）
  let lastAuxMouseDownAt = 0; // 最近一次检测到鼠标侧键按下（ms）
  let lastCtrlKeydownAt = 0; // 最近一次 Ctrl 键按下（ms）
  let lastViewportScrollLogAt = 0;
  let lastViewportScrollTop: number | null = null;
  let lastViewportScrollMaxTop: number | null = null;
  let lastViewportUserScrollLogAt = 0;
  let lastBufferScrollLogAt = 0;
  let lastBufferViewportY: number | null = null;
  let lastViewportBottomSnapshot: TerminalScrollSnapshot | null = null;
  let lastViewportBottomDom: TerminalDomScrollState | null = null;
  let lastViewportBottomObservedAt = 0;
  let viewportPointerDragActive = false;
  let viewportPointerDragUntil = 0;
  // 低版本 Windows（ConPTY < 21376）降级重排开关与状态
  let legacyWinNeedsReflowHack = false;
  let legacyWinBuild = 0;
  let legacyLastCols = 0;
  let appearance: TerminalAppearance = normalizeTerminalAppearance(options?.appearance);
  let lastScrollSnapshot: TerminalScrollSnapshot | null = null;
  const VIEWPORT_SCROLL_INTENT_WINDOW_MS = 700;
  const VIEWPORT_SCROLLBAR_DRAG_INTENT_WINDOW_MS = 1800;
  const VIEWPORT_POINTER_DRAG_MAX_MS = 8000;
  const VIEWPORT_RECONCILE_FRAMES = 4;
  const VIEWPORT_ROW_TOLERANCE = 1;
  const VIEWPORT_BOTTOM_STRICT_TOLERANCE = 0;
  const VIEWPORT_ANCHOR_RESTORE_FRAMES = 12;
  const VIEWPORT_ANCHOR_TTL_MS = 1800;
  const VIEWPORT_RESIZE_ANCHOR_IDLE_MS = 360;
  const VIEWPORT_RESIZE_FOLLOW_BOTTOM_MIN_HOLD_MS = 900;
  const VIEWPORT_RESIZE_ANCHOR_TTL_MS = 5200;
  const VIEWPORT_RESIZE_RESET_SETTLE_MS = VIEWPORT_RESIZE_ANCHOR_IDLE_MS;
  const VIEWPORT_RESIZE_RESET_SYNC_SETTLE_MS = 32;
  const VIEWPORT_RESIZE_RESET_REFRESH_INTERVAL_MS = 120;
  const VIEWPORT_RESIZE_SKIPPED_COMPLETE_PAINT_SETTLE_MS = 180;
  const VIEWPORT_RESIZE_PENDING_RESET_MAX_DEFER_MS = 240;
  const VIEWPORT_RESIZE_BOTTOM_INTENT_GRACE_MS = 1600;
  const VIEWPORT_RESIZE_LAYOUT_CLAMP_TOLERANCE_ROWS = 2;
  const VIEWPORT_DOM_BOTTOM_TOLERANCE_PX = 2;
  let userViewportScrollUntil = 0;
  let viewportReconcileRaf: number | null = null;
  let viewportReconcilePendingFrames = 0;
  let programmaticViewportScrollAllowance = 0;
  let programmaticViewportScrollAllowanceUntil = 0;
  let viewportReadAnchor: ViewportReadAnchor | null = null;
  let viewportResizeTransaction: ViewportResizeTransaction | null = null;
  let viewportResizeTransactionSeq = 0;
  let deferredResizeStartedAt: number | null = null;
  let deferredResizeNotifyRaf: number | null = null;
  const deferredResizeListeners = new Set<() => void>();

  // 输出写入合并：避免在高频输出/多终端并发时把大量小片段直接灌入 xterm，导致写入队列膨胀与 UI 假死。
  const TERM_WRITE_MAX_PENDING_CHARS = 300_000;
  const TERM_WRITE_MAX_CHARS_PER_FLUSH = 120_000;
  let pendingWriteChunks: string[] = [];
  let pendingWriteChars = 0;
  let pendingWriteDroppedChars = 0;
  let pendingWriteScheduled: number | null = null;
  let pendingWriteFlushSeq = 0;
  let pendingWriteDoneSeq = 0;
  let termWriteInFlight = 0;
  let lastTermWriteDoneAt = 0;

  /**
   * 格式化当前 xterm 写入队列状态，用于排查 resize 与输出分帧是否交错。
   */
  function formatPendingWriteState(): string {
    const writeDoneAgo = lastTermWriteDoneAt > 0 ? Math.round(nowMs() - lastTermWriteDoneAt) : "n/a";
    return `writePending=${Math.max(0, Math.round(pendingWriteChars))} writeChunks=${pendingWriteChunks.length} writeScheduled=${pendingWriteScheduled !== null ? "1" : "0"} writeInFlight=${termWriteInFlight} writeFlushSeq=${pendingWriteFlushSeq} writeDoneSeq=${pendingWriteDoneSeq} writeDoneAgo=${writeDoneAgo}`;
  }

  /**
   * 格式化 resize 重绘事务状态，用于串联 resize、PTY 输出与释放时机。
   * @param tx resize 重绘事务
   */
  function formatViewportResizeTransaction(tx: ViewportResizeTransaction | null | undefined): string {
    if (!tx) return `tx=n/a ${formatPendingWriteState()}`;
    const now = nowMs();
    const resetAgo = tx.terminalResetObservedAt === null ? "n/a" : Math.round(now - tx.terminalResetObservedAt);
    const resetOutAgo = tx.outputAfterResetObservedAt === null ? "n/a" : Math.round(now - tx.outputAfterResetObservedAt);
    const ptyPendingAgo = tx.ptyResizePendingAt === null ? "n/a" : Math.round(now - tx.ptyResizePendingAt);
    const ptyDoneAgo = tx.ptyResizeCompletedAt === null ? "n/a" : Math.round(now - tx.ptyResizeCompletedAt);
    return `tx=${tx.id} mode=${tx.mode} age=${Math.round(now - tx.startedAt)} idle=${Math.round(now - tx.lastActivityAt)} resetAgo=${resetAgo} resetOutAgo=${resetOutAgo} ptyPending=${tx.ptyResizePending ? "1" : "0"} ptyPendingAgo=${ptyPendingAgo} ptyDoneAgo=${ptyDoneAgo} ptyResult=${tx.ptyResizeCompletedResult ?? "n/a"} out=${tx.outputObserved ? "1" : "0"} restores=${tx.restoreCount} obsBase=${Math.round(tx.observedBaseY)} obsIdle=${Math.round(now - tx.observedBaseYChangedAt)} ${formatPendingWriteState()}`;
  }

  /**
   * 读取 xterm active buffer 的诊断字段。
   */
  function readBufferDebugState(): TerminalBufferDebugState | null {
    if (!term) return null;
    try {
      const buf: any = (term as any)?.buffer?.active;
      if (!buf) return null;
      return {
        type: String(buf.type || ""),
        length: Number(buf.length || 0),
        cursorY: Number(buf.cursorY || 0),
      };
    } catch {
      return null;
    }
  }

  /**
   * 判断 CSI 参数列表是否包含指定数字参数。
   * @param params CSI 参数文本
   * @param target 目标数字参数
   */
  function csiParamsContain(params: string, target: number): boolean {
    const normalized = String(params || "").replace(/[?<=>]/g, "");
    return normalized.split(/[;:]/).some((part) => Number(part || 0) === target);
  }

  /**
   * 概括终端输出中的关键控制序列，不记录原始内容，避免日志泄露命令输出。
   * @param payload 即将写入 xterm 的 PTY 输出
   */
  function summarizeTerminalControlSequences(payload: string): string {
    const text = String(payload || "");
    let clearScrollback = 0;
    let clearScreen = 0;
    let cursorHome = 0;
    let altEnter = 0;
    let altExit = 0;
    let fullReset = 0;
    text.replace(/(?:\x1b\[|\u009b)([0-?]*)([ -/]*)([@-~])/g, (_match, params: string, _intermediate: string, final: string) => {
      if (final === "J") {
        if (csiParamsContain(params, 3)) clearScrollback += 1;
        if (csiParamsContain(params, 2)) clearScreen += 1;
      } else if (final === "H" || final === "f") {
        cursorHome += 1;
      } else if (final === "h" && /\?104[79]/.test(params)) {
        altEnter += 1;
      } else if (final === "l" && /\?104[79]/.test(params)) {
        altExit += 1;
      }
      return "";
    });
    fullReset = (text.match(/\x1bc/g) || []).length;
    return `len=${text.length} clearScrollback=${clearScrollback} clearScreen=${clearScreen} cursorHome=${cursorHome} altEnter=${altEnter} altExit=${altExit} fullReset=${fullReset}`;
  }

  /**
   * 判断输出是否包含会语义性清空历史缓冲区的控制序列。
   * @param payload 即将写入 xterm 的 PTY 输出
   */
  function hasTerminalHistoryResetSequence(payload: string): boolean {
    const text = String(payload || "");
    if (text.includes("\x1bc")) return true;
    let found = false;
    text.replace(/(?:\x1b\[|\u009b)([0-?]*)([ -/]*)([@-~])/g, (_match, params: string, _intermediate: string, final: string) => {
      if (final === "J" && csiParamsContain(params, 3)) found = true;
      return "";
    });
    return found;
  }

  /**
   * 中文说明：将待写入数据分帧写入 xterm，避免一次性写入过大导致长帧/白屏。
   */
  const flushPendingWrites = () => {
    pendingWriteScheduled = null;
    if (!term) return;
    if (pendingWriteChars <= 0 || pendingWriteChunks.length === 0) return;
    const pendingBeforeFlush = pendingWriteChars;
    const chunksBeforeFlush = pendingWriteChunks.length;
    touchViewportResizeTransaction("write.before", true);
    captureViewportReadAnchor("write.before");
    const limit = TERM_WRITE_MAX_CHARS_PER_FLUSH;
    let remaining = limit;
    const out: string[] = [];
    while (pendingWriteChunks.length > 0 && remaining > 0) {
      const chunk = pendingWriteChunks[0] || "";
      if (!chunk) { pendingWriteChunks.shift(); continue; }
      if (chunk.length <= remaining) {
        out.push(chunk);
        pendingWriteChunks.shift();
        pendingWriteChars -= chunk.length;
        remaining -= chunk.length;
        continue;
      }
      out.push(chunk.slice(0, remaining));
      pendingWriteChunks[0] = chunk.slice(remaining);
      pendingWriteChars -= remaining;
      remaining = 0;
      break;
    }
    const dropped = pendingWriteDroppedChars;
    pendingWriteDroppedChars = 0;
    if (dropped > 0) {
      try { dlog(`[adapter] write.drop chars=${dropped}`); } catch {}
    }
    let payload = out.join("");
    const tx = viewportResizeTransaction;
    const controlSummary = summarizeTerminalControlSequences(payload);
    const flushSeq = ++pendingWriteFlushSeq;
    if (tx) {
      logScrollDiagnostic(`write.flush.start seq=${flushSeq} payload=${payload.length} pendingBefore=${pendingBeforeFlush} chunksBefore=${chunksBeforeFlush} remaining=${pendingWriteChars} ${formatViewportResizeTransaction(tx)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    }
    const hasHistoryReset = tx ? hasTerminalHistoryResetSequence(payload) : false;
    if (tx && hasHistoryReset) {
      tx.terminalResetObservedAt = nowMs();
      tx.outputAfterResetObservedAt = null;
    } else if (tx && tx.terminalResetObservedAt !== null) {
      tx.outputAfterResetObservedAt = nowMs();
    }
    if (tx && /clearScrollback=[1-9]|clearScreen=[1-9]|cursorHome=[1-9]|altEnter=[1-9]|altExit=[1-9]|fullReset=[1-9]/.test(controlSummary)) {
      logScrollDiagnostic(`write.control source=resize-transaction seq=${flushSeq} ${controlSummary} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    }
    try {
      termWriteInFlight += 1;
      term.write(payload, () => {
        termWriteInFlight = Math.max(0, termWriteInFlight - 1);
        pendingWriteDoneSeq += 1;
        lastTermWriteDoneAt = nowMs();
        if (tx) {
          logScrollDiagnostic(`write.done seq=${flushSeq} doneSeq=${pendingWriteDoneSeq} txCurrent=${viewportResizeTransaction === tx ? "1" : "0"} ${formatViewportResizeTransaction(tx)} current=${formatViewportResizeTransaction(viewportResizeTransaction)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
        }
        try { scheduleViewportReconcile("write.done"); } catch {}
        if (deferredResizeStartedAt !== null) scheduleDeferredResizeReady("write.done");
      });
    } catch {
      termWriteInFlight = Math.max(0, termWriteInFlight - 1);
      try { term.write(payload); } catch {}
    }
    scheduleViewportReconcile("write.after");
    // 若仍有残留，继续分帧
    if (pendingWriteChars > 0 && pendingWriteChunks.length > 0) {
      try { pendingWriteScheduled = window.requestAnimationFrame(flushPendingWrites); } catch {}
    }
  };

  /**
   * 中文说明：追加输出到待写入队列，并触发一次分帧 flush。
   * @param data - PTY 输出片段
   */
  const enqueueWrite = (data: string) => {
    if (!term) return;
    const s = String(data || "");
    if (!s) return;
    const tx = viewportResizeTransaction;
    touchViewportResizeTransaction("write.enqueue", true);
    captureViewportReadAnchor("write.enqueue");
    pendingWriteChunks.push(s);
    pendingWriteChars += s.length;
    if (tx) {
      logScrollDiagnostic(`write.enqueue len=${s.length} ${formatViewportResizeTransaction(tx)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    }
    // 过载保护：仅保留尾部，避免内存无限增长
    if (pendingWriteChars > TERM_WRITE_MAX_PENDING_CHARS) {
      let overflow = pendingWriteChars - TERM_WRITE_MAX_PENDING_CHARS;
      while (overflow > 0 && pendingWriteChunks.length > 0) {
        const first = pendingWriteChunks[0] || "";
        if (first.length <= overflow) {
          pendingWriteChunks.shift();
          overflow -= first.length;
          pendingWriteChars -= first.length;
          pendingWriteDroppedChars += first.length;
          continue;
        }
        pendingWriteChunks[0] = first.slice(overflow);
        pendingWriteChars -= overflow;
        pendingWriteDroppedChars += overflow;
        overflow = 0;
      }
    }
    if (pendingWriteScheduled !== null) return;
    try { pendingWriteScheduled = window.requestAnimationFrame(flushPendingWrites); } catch {}
  };

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
   * 中文说明：写入终端滚动诊断日志；默认关闭，仅在终端前端调试开关开启时进入 perf.log。
   */
  const logScrollDiagnostic = (message: string): void => {
    if (!dbgEnabled()) return;
    try {
      void (window as any).host?.utils?.perfLogCritical?.(`[terminal.scroll-debug adapter] ${message}`);
    } catch {}
  };

  /**
   * 中文说明：读取 xterm DOM viewport 的滚动度量。
   */
  const readDomScrollState = (): TerminalDomScrollState | null => {
    if (!container) return null;
    try {
      const viewport = container.querySelector(".xterm-viewport") as HTMLDivElement | null;
      if (!viewport) return null;
      const scrollTop = Number(viewport.scrollTop || 0);
      const scrollHeight = Number(viewport.scrollHeight || 0);
      const clientHeight = Number(viewport.clientHeight || 0);
      return {
        scrollTop,
        scrollHeight,
        clientHeight,
        maxScrollTop: Math.max(0, scrollHeight - clientHeight),
      };
    } catch {
      return null;
    }
  };

  /**
   * 中文说明：把 buffer 滚动快照压缩成单行日志字段。
   */
  const formatScrollSnapshot = (snapshot: TerminalScrollSnapshot | null | undefined): string => {
    if (!snapshot) return "buf=n/a";
    const debug = readBufferDebugState();
    const suffix = debug ? ` type=${debug.type || "n/a"} len=${Math.round(debug.length)} cy=${Math.round(debug.cursorY)}` : "";
    return `buf=${Math.round(snapshot.viewportY)}/${Math.round(snapshot.baseY)} bottom=${snapshot.isAtBottom ? "1" : "0"}${suffix}`;
  };

  /**
   * 把阅读锚点压缩成单行日志字段。
   * @param anchor 阅读锚点
   */
  function formatViewportReadAnchor(anchor: ViewportReadAnchor | null | undefined): string {
    if (!anchor) return "anchor=n/a";
    return `anchor=${Math.round(anchor.viewportY)}/${Math.round(anchor.baseY)} size=${anchor.cols}x${anchor.rows} dist=${Math.round(anchor.distanceFromBottom)} ratio=${anchor.ratio.toFixed(3)} bottom=${anchor.isAtBottom ? "1" : "0"} src=${anchor.source}`;
  }

  /**
   * 用当前稳定滚动快照创建阅读锚点。
   * @param snapshot 当前 xterm buffer 滚动快照
   * @param source 捕获来源
   */
  function createViewportReadAnchor(
    snapshot: TerminalScrollSnapshot,
    source: string,
    grid?: { cols: number; rows: number },
  ): ViewportReadAnchor {
    return {
      viewportY: snapshot.viewportY,
      baseY: snapshot.baseY,
      cols: grid?.cols ?? term?.cols ?? 0,
      rows: grid?.rows ?? term?.rows ?? 0,
      distanceFromBottom: Math.max(0, snapshot.baseY - snapshot.viewportY),
      ratio: snapshot.baseY > 0 ? Math.max(0, Math.min(1, snapshot.viewportY / snapshot.baseY)) : 0,
      isAtBottom: snapshot.isAtBottom,
      createdAt: nowMs(),
      source,
    };
  }

  /**
   * 创建并登记 resize 重绘事务。
   * @param anchor resize 前捕获的阅读锚点
   */
  function startViewportResizeTransaction(anchor: ViewportReadAnchor): ViewportResizeTransaction {
    const createdAt = nowMs();
    viewportReadAnchor = anchor;
    viewportResizeTransaction = {
      id: ++viewportResizeTransactionSeq,
      mode: anchor.isAtBottom ? "follow-bottom" : "read-anchor",
      anchor,
      startedAt: createdAt,
      lastActivityAt: createdAt,
      observedBaseY: anchor.baseY,
      observedBaseYChangedAt: createdAt,
      terminalResetObservedAt: null,
      outputAfterResetObservedAt: null,
      singleScreenRefreshAt: null,
      ptyResizePending: false,
      ptyResizePendingAt: null,
      ptyResizeCompletedAt: null,
      ptyResizeCompletedResult: null,
      outputObserved: false,
      restoreCount: 0,
      releaseTimer: null,
    };
    return viewportResizeTransaction;
  }

  /**
   * 判断滚动快照是否已经严格处于 xterm 底部。
   * @param snapshot 当前 xterm buffer 滚动快照
   */
  function isViewportAtStrictBottom(snapshot: TerminalScrollSnapshot | null | undefined): boolean {
    if (!snapshot) return false;
    if (snapshot.baseY <= 0) return false;
    return Math.max(0, snapshot.baseY - snapshot.viewportY) <= VIEWPORT_BOTTOM_STRICT_TOLERANCE;
  }

  /**
   * 判断 DOM viewport 滚动条是否已经位于底部。
   * @param dom 当前 DOM 滚动度量
   */
  function isDomViewportAtBottom(dom: TerminalDomScrollState | null | undefined): boolean {
    if (!dom) return false;
    return Math.max(0, dom.maxScrollTop - dom.scrollTop) <= VIEWPORT_DOM_BOTTOM_TOLERANCE_PX;
  }

  /**
   * 记录最近一次可信的底部状态，用于窗口 resize 时抵抗浏览器 viewport clamp 的短暂污染。
   * @param snapshot 当前 xterm buffer 快照
   * @param dom 当前 DOM viewport 滚动度量
   */
  function rememberViewportBottomEvidence(
    snapshot: TerminalScrollSnapshot | null | undefined,
    dom?: TerminalDomScrollState | null,
  ): void {
    if (!snapshot || snapshot.baseY <= 0 || !snapshot.isAtBottom) return;
    if (isViewportUserScrollActive()) return;
    if (dom && !isDomViewportAtBottom(dom)) return;
    lastViewportBottomSnapshot = {
      viewportY: snapshot.baseY,
      baseY: snapshot.baseY,
      isAtBottom: true,
    };
    lastViewportBottomDom = dom
      ? {
        scrollTop: dom.scrollTop,
        scrollHeight: dom.scrollHeight,
        clientHeight: dom.clientHeight,
        maxScrollTop: dom.maxScrollTop,
      }
      : null;
    lastViewportBottomObservedAt = nowMs();
  }

  /**
   * 判断当前非底部状态是否只是窗口高度变化后浏览器对 scrollTop 的 clamp。
   * @param snapshot 当前 xterm buffer 快照
   * @param dom 当前 DOM viewport 滚动度量
   */
  function isRecentViewportBottomClamp(
    snapshot: TerminalScrollSnapshot | null | undefined,
    dom: TerminalDomScrollState | null | undefined,
  ): boolean {
    if (!snapshot || snapshot.baseY <= 0 || !dom || !lastViewportBottomSnapshot) return false;
    if (!isDomViewportAtBottom(dom)) return false;
    if (nowMs() - lastViewportBottomObservedAt > VIEWPORT_RESIZE_BOTTOM_INTENT_GRACE_MS) return false;
    if (isViewportUserScrollActive()) return false;

    const distanceFromBottom = Math.max(0, snapshot.baseY - snapshot.viewportY);
    const lineHeight = readTerminalLineHeightPx();
    const previousClientHeight = Math.max(0, Number(lastViewportBottomDom?.clientHeight || 0));
    const heightDelta = previousClientHeight > 0
      ? Math.max(0, dom.clientHeight - previousClientHeight)
      : 0;
    const expectedClampRows = lineHeight > 0
      ? Math.ceil(heightDelta / lineHeight) + VIEWPORT_RESIZE_LAYOUT_CLAMP_TOLERANCE_ROWS
      : VIEWPORT_RESIZE_LAYOUT_CLAMP_TOLERANCE_ROWS;
    const baseDelta = Math.abs(snapshot.baseY - lastViewportBottomSnapshot.baseY);
    return baseDelta <= VIEWPORT_ROW_TOLERANCE
      && distanceFromBottom > VIEWPORT_BOTTOM_STRICT_TOLERANCE
      && distanceFromBottom <= Math.max(VIEWPORT_RESIZE_LAYOUT_CLAMP_TOLERANCE_ROWS, expectedClampRows);
  }

  /**
   * 为窗口/布局 resize 解析底部跟随锚点。仅在严格底部或最近底部被 layout clamp 污染时返回。
   * @param snapshot 当前 xterm buffer 快照
   * @param dom 当前 DOM viewport 滚动度量
   */
  function resolveLayoutResizeBottomAnchorSnapshot(
    snapshot: TerminalScrollSnapshot | null | undefined,
    dom: TerminalDomScrollState | null | undefined,
  ): { snapshot: TerminalScrollSnapshot; reason: string } | null {
    if (snapshot && snapshot.baseY > 0 && snapshot.isAtBottom) {
      return {
        snapshot: {
          viewportY: snapshot.baseY,
          baseY: snapshot.baseY,
          isAtBottom: true,
        },
        reason: "strict-bottom",
      };
    }
    if (isRecentViewportBottomClamp(snapshot, dom)) {
      const baseY = Math.max(0, snapshot?.baseY ?? lastViewportBottomSnapshot?.baseY ?? 0);
      return {
        snapshot: {
          viewportY: baseY,
          baseY,
          isAtBottom: true,
        },
        reason: "layout-clamp",
      };
    }
    return null;
  }

  /**
   * 中文说明：把 DOM 滚动度量压缩成单行日志字段。
   */
  const formatDomScrollState = (state: TerminalDomScrollState | null | undefined): string => {
    if (!state) return "dom=n/a";
    return `domTop=${Math.round(state.scrollTop)} domMax=${Math.round(state.maxScrollTop)} domClient=${Math.round(state.clientHeight)} domHeight=${Math.round(state.scrollHeight)}`;
  };

  /**
   * 判断当前是否应接受 DOM scroll 事件回写 xterm buffer 视口。
   */
  function canAcceptViewportDomScroll(): boolean {
    if (isViewportUserScrollActive()) return true;
    if (programmaticViewportScrollAllowance > 0 && nowMs() <= programmaticViewportScrollAllowanceUntil) {
      programmaticViewportScrollAllowance -= 1;
      return true;
    }
    return false;
  }

  /**
   * 判断当前是否仍处在用户主动滚动窗口内。
   */
  function isViewportUserScrollActive(): boolean {
    const now = nowMs();
    return now <= userViewportScrollUntil || isViewportPointerDragActive(now);
  }

  /**
   * 判断终端 viewport 是否仍处在有效的指针拖拽窗口内。
   * @param now 当前时间戳
   */
  function isViewportPointerDragActive(now = nowMs()): boolean {
    if (!viewportPointerDragActive) return false;
    if (now <= viewportPointerDragUntil) return true;
    viewportPointerDragActive = false;
    viewportPointerDragUntil = 0;
    return false;
  }

  /**
   * 标记终端 viewport 指针拖拽已经开始。
   * @param source 触发来源
   */
  function markViewportPointerDragStart(source: string): void {
    const now = nowMs();
    viewportPointerDragActive = true;
    viewportPointerDragUntil = now + VIEWPORT_POINTER_DRAG_MAX_MS;
    markViewportUserScroll(source, VIEWPORT_SCROLLBAR_DRAG_INTENT_WINDOW_MS);
  }

  /**
   * 标记终端 viewport 指针拖拽已经结束。
   * @param source 触发来源
   */
  function markViewportPointerDragEnd(source: string): void {
    if (!viewportPointerDragActive) return;
    viewportPointerDragActive = false;
    viewportPointerDragUntil = 0;
    userViewportScrollUntil = Math.max(userViewportScrollUntil, nowMs() + VIEWPORT_SCROLL_INTENT_WINDOW_MS);
    logScrollDiagnostic(`viewport.pointer-drag.end source=${source} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
  }

  /**
   * 判断 DOM viewport 的 scroll 事件是否应被推断为用户拖动滚动条。
   * @param snapshot 当前 xterm buffer 滚动快照
   * @param state 当前 DOM viewport 滚动度量
   * @param changed 本次 scrollTop 是否有可观测变化
   * @param accepted 是否已经由显式用户意图或程序性豁免接受
   * @param previousTop 上一次 DOM scrollTop
   * @param previousMaxTop 上一次 DOM 最大 scrollTop
   */
  function shouldInferViewportUserScrollFromDom(
    snapshot: TerminalScrollSnapshot | null,
    state: TerminalDomScrollState,
    changed: boolean,
    accepted: boolean,
    previousTop: number | null,
    previousMaxTop: number | null,
  ): boolean {
    if (accepted || !changed) return false;
    if (viewportResizeTransaction) return false;
    if (state.maxScrollTop <= 0) return false;
    if (!hasViewportMismatch(snapshot, state)) return false;
    if (snapshot?.isAtBottom) return false;
    if (
      isDomViewportAtBottom(state)
      && previousTop !== null
      && previousMaxTop !== null
      && Math.max(0, previousMaxTop - previousTop) <= VIEWPORT_DOM_BOTTOM_TOLERANCE_PX
    ) return false;
    return true;
  }

  /**
   * 标记一次由用户输入触发的 viewport 滚动窗口。
   * @param source 触发来源
   * @param durationMs 用户滚动意图保留时长
   */
  function markViewportUserScroll(source: string, durationMs = VIEWPORT_SCROLL_INTENT_WINDOW_MS): void {
    const now = nowMs();
    userViewportScrollUntil = Math.max(userViewportScrollUntil, now + durationMs);
    viewportReadAnchor = null;
    lastViewportBottomSnapshot = null;
    lastViewportBottomDom = null;
    lastViewportBottomObservedAt = 0;
    if (viewportResizeTransaction) releaseViewportResizeTransaction(`user.${source}`);
    if (now - lastViewportUserScrollLogAt > 300) {
      lastViewportUserScrollLogAt = now;
      logScrollDiagnostic(`viewport.user-scroll source=${source} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    }
  }

  /**
   * 给下一次程序写入 scrollTop 预留通过窗口，避免被非用户 scroll 拦截器吞掉。
   * @param count 允许通过的 scroll 事件数量
   */
  function allowProgrammaticViewportScroll(count = 1): void {
    programmaticViewportScrollAllowance = Math.max(programmaticViewportScrollAllowance, count);
    programmaticViewportScrollAllowanceUntil = nowMs() + 250;
  }

  /**
   * 生成 resize 重绘事务的 idle 释放来源，避免连续等待时不断叠加 idle 前缀。
   * @param source 当前触发来源
   */
  function toViewportResizeIdleSource(source: string): string {
    return source.startsWith("idle.") ? source : `idle.${source}`;
  }

  /**
   * 安排下一次 resize 重绘事务释放检查。
   * @param source 触发来源
   * @param resetExisting 是否重置已经存在的释放计时器
   */
  function scheduleViewportResizeReleaseCheck(source: string, resetExisting: boolean): void {
    const tx = viewportResizeTransaction;
    if (!tx) return;
    if (tx.releaseTimer !== null) {
      if (!resetExisting) return;
      try { window.clearTimeout(tx.releaseTimer); } catch {}
      tx.releaseTimer = null;
    }
    try {
      let timer: number | null = null;
      timer = window.setTimeout(() => {
        if (viewportResizeTransaction === tx && tx.releaseTimer === timer) {
          tx.releaseTimer = null;
        }
        try { releaseViewportResizeTransaction(toViewportResizeIdleSource(source)); } catch {}
      }, VIEWPORT_RESIZE_ANCHOR_IDLE_MS);
      tx.releaseTimer = timer;
    } catch {}
  }

  /**
   * 继续等待 resize 重绘事务恢复，但不刷新真实活动时间。
   * @param source 等待来源
   */
  function waitViewportResizeTransaction(source: string): void {
    scheduleViewportResizeReleaseCheck(source, false);
  }

  /**
   * 标记 resize 重绘事务发生了新活动，并延后释放窗口。
   * @param source 活动来源
   * @param outputObserved 是否观察到 PTY 输出
   */
  function touchViewportResizeTransaction(source: string, outputObserved = false): void {
    const tx = viewportResizeTransaction;
    if (!tx) return;
    const now = nowMs();
    tx.lastActivityAt = now;
    tx.outputObserved = tx.outputObserved || outputObserved;
    scheduleViewportResizeReleaseCheck(source, true);
  }

  /**
   * 记录 resize 重绘事务中观察到的 buffer 高度变化。
   * @param snapshot 当前 xterm buffer 滚动快照
   */
  function observeViewportResizeBaseY(snapshot: TerminalScrollSnapshot | null | undefined): void {
    const tx = viewportResizeTransaction;
    if (!tx || !snapshot) return;
    const baseY = Math.max(0, Number(snapshot.baseY || 0));
    if (Math.abs(baseY - tx.observedBaseY) <= VIEWPORT_ROW_TOLERANCE) return;
    tx.observedBaseY = baseY;
    tx.observedBaseYChangedAt = nowMs();
  }

  /**
   * 判断 resize 重绘事务是否已经进入安静窗口。
   * @param tx resize 重绘事务
   */
  function isViewportResizeTransactionIdle(tx: ViewportResizeTransaction): boolean {
    if (tx.ptyResizePending) return false;
    return nowMs() - tx.lastActivityAt >= VIEWPORT_RESIZE_ANCHOR_IDLE_MS;
  }

  /**
   * 判断过期的 resize 重绘事务是否允许作为兜底释放。
   * @param tx resize 重绘事务
   */
  function canExpireViewportResizeTransaction(tx: ViewportResizeTransaction): boolean {
    if (nowMs() - tx.startedAt <= VIEWPORT_RESIZE_ANCHOR_TTL_MS) return false;
    if (tx.ptyResizePending) {
      const pendingAt = tx.ptyResizePendingAt ?? tx.startedAt;
      return nowMs() - pendingAt > VIEWPORT_RESIZE_ANCHOR_TTL_MS;
    }
    return isViewportResizeTransactionIdle(tx);
  }

  /**
   * 判断清历史后的 xterm buffer 是否已经收敛为当前视口内的单屏内容。
   * @param snapshot 当前 xterm buffer 滚动快照
   */
  function isResetSingleScreenSnapshot(
    snapshot: TerminalScrollSnapshot | null | undefined,
  ): boolean {
    if (!snapshot) return false;
    if (snapshot.baseY > 0) return false;
    if (snapshot.viewportY > VIEWPORT_ROW_TOLERANCE) return false;
    const debug = readBufferDebugState();
    const rows = Math.max(0, Number(term?.rows || 0));
    if (!debug || rows <= 0) return false;
    return debug.length <= rows + VIEWPORT_ROW_TOLERANCE;
  }

  /**
   * 判断 follow-bottom 事务是否仍处在清历史后的空 buffer 窗口。
   * @param tx resize 重绘事务
   * @param snapshot 当前 xterm buffer 滚动快照
   */
  function isFollowBottomResetStillEmpty(
    tx: ViewportResizeTransaction,
    snapshot: TerminalScrollSnapshot | null | undefined,
  ): boolean {
    return tx.mode === "follow-bottom"
      && tx.anchor.isAtBottom
      && isResetSingleScreenSnapshot(snapshot);
  }

  /**
   * 判断 follow-bottom 单屏 reset 是否已有可信稳定窗口。
   * @param tx resize 重绘事务
   */
  function hasFollowBottomResetSingleScreenQuietWindow(tx: ViewportResizeTransaction): boolean {
    if (isViewportResizeTransactionIdle(tx)) return true;
    if (tx.ptyResizePending) return false;
    if (tx.ptyResizeCompletedResult !== "skipped") return false;
    if (tx.ptyResizeCompletedAt === null) return false;
    if (tx.ptyResizeCompletedAt < tx.lastActivityAt - 1) return false;
    return nowMs() - tx.ptyResizeCompletedAt >= VIEWPORT_RESIZE_SKIPPED_COMPLETE_PAINT_SETTLE_MS;
  }

  /**
   * 判断 follow-bottom 模式下清历史后的单屏重绘是否已经稳定。
   * @param tx resize 重绘事务
   * @param snapshot 当前 xterm buffer 滚动快照
   */
  function isFollowBottomResetEmptyScreenSettled(
    tx: ViewportResizeTransaction,
    snapshot: TerminalScrollSnapshot | null | undefined,
  ): boolean {
    if (!isFollowBottomResetStillEmpty(tx, snapshot)) return false;
    if (tx.terminalResetObservedAt === null) return false;
    if (tx.outputAfterResetObservedAt === null) return false;
    if (!hasFollowBottomResetSingleScreenQuietWindow(tx)) return false;
    if (hasPendingTerminalWriteWork()) return false;
    if (nowMs() - tx.outputAfterResetObservedAt < VIEWPORT_RESIZE_RESET_SETTLE_MS) return false;
    return true;
  }

  /**
   * 判断 reset 后单屏内容是否已经可先同步 viewport；该判断只用于刷新显示，不释放事务。
   * @param tx resize 重绘事务
   * @param snapshot 当前 xterm buffer 滚动快照
   */
  function canSyncFollowBottomResetSingleScreen(
    tx: ViewportResizeTransaction,
    snapshot: TerminalScrollSnapshot | null | undefined,
  ): boolean {
    if (!isFollowBottomResetStillEmpty(tx, snapshot)) return false;
    if (tx.terminalResetObservedAt === null) return false;
    if (tx.outputAfterResetObservedAt === null) return false;
    if (hasPendingTerminalWriteWork()) return false;
    return nowMs() - tx.outputAfterResetObservedAt >= VIEWPORT_RESIZE_RESET_SYNC_SETTLE_MS;
  }

  /**
   * 判断 resize 期间的清历史输出是否已经稳定落地。
   * @param tx resize 重绘事务
   * @param snapshot 当前 xterm buffer 滚动快照
   */
  function isViewportResizeTerminalResetSettled(
    tx: ViewportResizeTransaction,
    snapshot: TerminalScrollSnapshot | null | undefined,
  ): boolean {
    if (tx.terminalResetObservedAt === null) return false;
    if (!snapshot) return false;
    const singleScreenSettled = isFollowBottomResetEmptyScreenSettled(tx, snapshot);
    if (!isViewportResizeTransactionIdle(tx) && !singleScreenSettled) return false;
    if (nowMs() - tx.terminalResetObservedAt < VIEWPORT_RESIZE_RESET_SETTLE_MS) return false;
    if (isFollowBottomResetStillEmpty(tx, snapshot) && !singleScreenSettled) return false;
    return true;
  }

  /**
   * 判断 read-anchor 在清历史重绘后旧锚点是否已经被应用输出废弃。
   * @param tx resize 重绘事务
   * @param snapshot 当前 xterm buffer 滚动快照
   */
  function isReadAnchorResetAnchorInvalidated(
    tx: ViewportResizeTransaction,
    snapshot: TerminalScrollSnapshot | null | undefined,
  ): boolean {
    if (tx.mode !== "read-anchor" || tx.anchor.isAtBottom) return false;
    if (tx.terminalResetObservedAt === null || tx.outputAfterResetObservedAt === null) return false;
    if (!snapshot) return false;
    if (!isViewportResizeTransactionIdle(tx)) return false;
    if (hasPendingTerminalWriteWork()) return false;
    const now = nowMs();
    if (now - tx.terminalResetObservedAt < VIEWPORT_RESIZE_RESET_SETTLE_MS) return false;
    if (now - tx.outputAfterResetObservedAt < VIEWPORT_RESIZE_RESET_SETTLE_MS) return false;

    const baseY = Math.max(0, Math.round(snapshot.baseY || 0));
    const anchorViewportY = Math.max(0, Math.round(tx.anchor.viewportY || 0));
    return baseY < anchorViewportY - VIEWPORT_ROW_TOLERANCE;
  }

  /**
   * 判断 resize 重绘事务是否已经可以安全释放。
   */
  function canReleaseViewportResizeTransaction(): boolean {
    const tx = viewportResizeTransaction;
    if (!tx) return false;
    const txExpired = canExpireViewportResizeTransaction(tx);
    if (tx.ptyResizePending && !txExpired) {
      logScrollDiagnostic(`resize-anchor.release-check result=hold reason=pty-resize-pending ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      return false;
    }
    if (tx.mode === "follow-bottom" && nowMs() - tx.startedAt < VIEWPORT_RESIZE_FOLLOW_BOTTOM_MIN_HOLD_MS) {
      logScrollDiagnostic(`resize-anchor.release-check result=hold reason=follow-bottom-min-hold ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      return false;
    }
    const snapshot = readScrollSnapshot();
    observeViewportResizeBaseY(snapshot);
    if (!snapshot) {
      logScrollDiagnostic(`resize-anchor.release-check result=hold reason=missing-buffer ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      return false;
    }
    if (!isViewportResizeTransactionIdle(tx) && !isFollowBottomResetEmptyScreenSettled(tx, snapshot)) return false;
    if (isReadAnchorResetAnchorInvalidated(tx, snapshot)) {
      logScrollDiagnostic(`resize-anchor.release-check result=release reason=terminal-reset-anchor-invalidated ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      return true;
    }
    const anchorWaitReason = getViewportReadAnchorWaitReason(tx.anchor, snapshot);
    if (anchorWaitReason) {
      logScrollDiagnostic(`resize-anchor.release-check result=hold reason=${anchorWaitReason} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      return false;
    }
    if (isViewportResizeTerminalResetSettled(tx, snapshot)) {
      logScrollDiagnostic(`resize-anchor.release-check result=release reason=terminal-reset ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      return true;
    }
    const rebuildReason = getViewportResizeRebuildReason(snapshot);
    if (rebuildReason) {
      logScrollDiagnostic(`resize-anchor.release-check result=hold reason=${rebuildReason} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      return false;
    }
    const target = resolveViewportAnchorTarget(tx.anchor, snapshot);
    const restored = tx.anchor.isAtBottom
      ? isViewportAtStrictBottom(snapshot)
      : Math.abs(snapshot.viewportY - target) <= VIEWPORT_ROW_TOLERANCE;
    logScrollDiagnostic(`resize-anchor.release-check result=${restored ? "release" : "hold"} target=${target} strictBottom=${isViewportAtStrictBottom(snapshot) ? "1" : "0"} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
    return restored;
  }

  /**
   * 判断当前 buffer 是否仍处于 resize 触发后的清屏/重建中间态。
   * @param snapshot 当前 xterm buffer 滚动快照
   */
  function getViewportResizeRebuildReason(snapshot: TerminalScrollSnapshot | null | undefined): string | null {
    const tx = viewportResizeTransaction;
    if (!tx || tx.anchor.baseY <= 0) return null;
    if (!snapshot) return "missing-buffer";
    if (isViewportResizeTerminalResetSettled(tx, snapshot)) return null;
    if (isFollowBottomResetEmptyScreenSettled(tx, snapshot)) return null;
    if (snapshot.baseY <= 0) return "empty-buffer";
    return null;
  }

  /**
   * 判断是否仍有 PTY 输出正在分帧写入 xterm。
   */
  function hasPendingTerminalWriteWork(): boolean {
    return pendingWriteChars > 0
      || pendingWriteScheduled !== null
      || termWriteInFlight > 0;
  }

  /**
   * 判断当前写入队列中是否存在清屏/清历史重绘输出。
   */
  function hasPendingTerminalResetWriteWork(): boolean {
    if (termWriteInFlight > 0 && viewportResizeTransaction && viewportResizeTransaction.terminalResetObservedAt !== null) return true;
    return pendingWriteChunks.some((chunk) => hasTerminalHistoryResetSequence(chunk));
  }

  /**
   * 读取 fit-addon 将要计算出的目标尺寸，但不改变 xterm 当前尺寸。
   */
  function proposeTerminalFitSize(): { cols: number; rows: number } | null {
    try {
      const proposed = (fitAddon as any)?.proposeDimensions?.();
      const cols = Math.max(0, Math.floor(Number(proposed?.cols || 0)));
      const rows = Math.max(0, Math.floor(Number(proposed?.rows || 0)));
      if (!cols || !rows) return null;
      return { cols, rows };
    } catch {
      return null;
    }
  }

  /**
   * 只测量当前宿主 DOM 对应的候选行列，不提交到 xterm。
   */
  function measureTerminalResize(): { cols: number; rows: number } {
    if (!term || !fitAddon || !container) return { cols: 0, rows: 0 };
    const proposed = proposeTerminalFitSize();
    const size = proposed || { cols: term.cols, rows: term.rows };
    try {
      const rect = container.getBoundingClientRect();
      const parentRect = container.parentElement?.getBoundingClientRect() || null;
      const hostWidth = parentRect ? parentRect.width : rect.width;
      const hostHeight = parentRect ? parentRect.height : rect.height;
      logScrollDiagnostic(`adapter.resize.measure size=${size.cols}x${size.rows} host=${Math.round(hostWidth)}x${Math.round(hostHeight)} current=${term.cols}x${term.rows} ${formatPendingWriteState()} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    } catch {}
    return size;
  }

  /**
   * 按已提交给 PTY 的行列更新本地 xterm，避免本地 fit 抢跑真实 resize。
   * @param size 已提交或确认无需下发的 PTY 行列
   * @param source 提交来源
   */
  function commitTerminalResize(
    size: { cols: number; rows: number },
    source: string,
  ): { cols: number; rows: number } {
    if (!term || !container) return { cols: 0, rows: 0 };
    const cols = Math.max(2, Math.floor(Number(size?.cols || 0)));
    const rows = Math.max(2, Math.floor(Number(size?.rows || 0)));
    if (!cols || !rows) return { cols: term.cols, rows: term.rows };

    const beforeSize = { cols: term.cols, rows: term.rows };
    const beforeSnapshot = readScrollSnapshot();
    const beforeDom = readDomScrollState();
    const hadResizeTransaction = !!viewportResizeTransaction;
    const changed = beforeSize.cols !== cols || beforeSize.rows !== rows;

    if (changed && !viewportResizeTransaction && beforeSnapshot && beforeSnapshot.baseY > 0) {
      const anchor = createViewportReadAnchor(beforeSnapshot, `resize.${source}`, beforeSize);
      viewportResizeTransaction = startViewportResizeTransaction(anchor);
      logScrollDiagnostic(`resize-anchor.capture source=${source} reason=size-commit ${formatViewportResizeTransaction(viewportResizeTransaction)} anchor=${formatViewportReadAnchor(anchor)} beforeSize=${beforeSize.cols}x${beforeSize.rows} afterSize=${cols}x${rows} ${formatScrollSnapshot(beforeSnapshot)} ${formatDomScrollState(beforeDom)}`);
    }

    try {
      if ((container.style.height || "").trim() !== "100%") {
        container.style.height = "100%";
      }
    } catch {}

    try {
      if (changed) term.resize(cols, rows);
    } catch {}

    if (changed) touchViewportResizeTransaction(source);
    else waitViewportResizeTransaction(source);

    try {
      if (legacyWinNeedsReflowHack && term && changed) {
        const need = legacyLastCols !== term.cols;
        if (need) {
          const targetCols = term.cols;
          const prevMode = !!((term as any)?.options?.windowsMode);
          logScrollDiagnostic(`legacy.reflow.try build=${legacyWinBuild} targetCols=${targetCols} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
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

    try { term.refresh(0, Math.max(0, term.rows - 1)); } catch {}
    syncViewportHeight(source);
    tryRestoreViewportReadAnchor(source);
    scheduleViewportReconcile(source);
    logScrollDiagnostic(`adapter.resize.commit source=${source} size=${term.cols}x${term.rows} same=${changed ? "0" : "1"} txBefore=${hadResizeTransaction ? "1" : "0"} txAfter=${viewportResizeTransaction ? "1" : "0"} ${formatViewportResizeTransaction(viewportResizeTransaction)} before=${formatScrollSnapshot(beforeSnapshot)} ${formatDomScrollState(beforeDom)} after=${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    return { cols: term.cols, rows: term.rows };
  }

  /**
   * 通知 Manager 重新执行 resize 测量；只在 reset 输出落地或达到最大等待窗口后触发。
   */
  function scheduleDeferredResizeReady(source: string): void {
    if (deferredResizeNotifyRaf !== null) return;
    const run = () => {
      deferredResizeNotifyRaf = null;
      if (deferredResizeStartedAt === null) return;
      const age = nowMs() - deferredResizeStartedAt;
      if (hasPendingTerminalWriteWork() && age < VIEWPORT_RESIZE_PENDING_RESET_MAX_DEFER_MS) {
        try { deferredResizeNotifyRaf = window.requestAnimationFrame(run); } catch {}
        return;
      }
      deferredResizeStartedAt = null;
      logScrollDiagnostic(`adapter.resize.defer.ready source=${source} age=${Math.round(age)} ${formatPendingWriteState()} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      for (const listener of Array.from(deferredResizeListeners)) {
        try { listener(); } catch {}
      }
    };
    try { deferredResizeNotifyRaf = window.requestAnimationFrame(run); } catch {}
  }

  /**
   * 判断本次本地 xterm resize 是否应等待已排队的 reset 重绘先落地。
   * @param beforeSize resize 前 xterm 尺寸
   * @param proposed fit-addon 计算出的目标尺寸
   */
  function shouldDeferResizeForPendingResetOutput(
    beforeSize: { cols: number; rows: number },
    proposed: { cols: number; rows: number } | null,
  ): boolean {
    if (!proposed) return false;
    if (beforeSize.cols === proposed.cols && beforeSize.rows === proposed.rows) return false;
    if (!hasPendingTerminalResetWriteWork()) return false;
    const startedAt = deferredResizeStartedAt ?? nowMs();
    deferredResizeStartedAt = startedAt;
    if (nowMs() - startedAt >= VIEWPORT_RESIZE_PENDING_RESET_MAX_DEFER_MS) {
      deferredResizeStartedAt = null;
      return false;
    }
    return true;
  }

  /**
   * 判断非底部阅读锚点是否需要等待 buffer 重建后再恢复。
   * @param anchor 阅读锚点
   * @param snapshot 当前 xterm buffer 滚动快照
   */
  function getViewportReadAnchorWaitReason(
    anchor: ViewportReadAnchor,
    snapshot: TerminalScrollSnapshot | null | undefined,
  ): string | null {
    if (anchor.isAtBottom) return null;
    if (!snapshot) return "missing-buffer";

    const baseY = Math.max(0, Number(snapshot.baseY || 0));
    const anchorViewportY = Math.max(0, Math.round(anchor.viewportY));
    const anchorBaseY = Math.max(anchorViewportY, Math.round(anchor.baseY));
    const currentCols = term?.cols || 0;
    const sameCols = !anchor.cols || !currentCols || anchor.cols === currentCols;
    if (!sameCols) return null;

    if (baseY < anchorViewportY - VIEWPORT_ROW_TOLERANCE) return "anchor-beyond-buffer";
    if (hasPendingTerminalWriteWork() && baseY < anchorBaseY - VIEWPORT_ROW_TOLERANCE) return "buffer-rebuilding";
    return null;
  }

  /**
   * 按当前 buffer 强制重绘可见终端行。
   * @param source 触发来源
   * @param clearRenderer 是否先清理 xterm 渲染层缓存
   */
  function refreshVisibleTerminalRows(source: string, clearRenderer = false): void {
    if (!term) return;
    try {
      if (clearRenderer) {
        const core: any = (term as any)?._core;
        try { core?._renderService?.clear?.(); } catch {}
        try { term.clearTextureAtlas?.(); } catch {}
      }
      try { term.refresh(0, Math.max(0, term.rows - 1)); } catch {}
      if (clearRenderer) {
        logScrollDiagnostic(`viewport.render-refresh source=${source} clear=1 ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      }
    } catch {}
  }

  /**
   * 在 follow-bottom 语义已经成立时，只把 DOM 滚动条投影同步到 maxScrollTop。
   * @param source 触发来源
   */
  function syncFollowBottomDomScrollbar(source: string): void {
    if (!term || !container) return;
    const snapshot = readScrollSnapshot();
    if (!isViewportAtStrictBottom(snapshot)) return;
    try {
      const viewport = container.querySelector(".xterm-viewport") as HTMLDivElement | null;
      if (!viewport) return;
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (Math.abs((viewport.scrollTop || 0) - maxScrollTop) <= VIEWPORT_DOM_BOTTOM_TOLERANCE_PX) return;
      const beforeDom = readDomScrollState();
      allowProgrammaticViewportScroll(1);
      viewport.scrollTop = maxScrollTop;
      logScrollDiagnostic(`scrollbar.bottom-sync source=${source} target=${Math.round(maxScrollTop)} ${formatScrollSnapshot(snapshot)} before=${formatDomScrollState(beforeDom)} after=${formatDomScrollState(readDomScrollState())}`);
    } catch {}
  }

  /**
   * 在释放 resize 事务前强制刷新可见视口，修正 xterm 渲染层与 buffer/DOM 状态偶发脱节。
   * @param anchor 当前 resize 事务锚点
   * @param source 触发来源
   */
  function forceRevealViewportAnchor(anchor: ViewportReadAnchor, source: string): void {
    if (!term) return;
    try {
      allowProgrammaticViewportScroll(2);
      if (anchor.isAtBottom) term.scrollToBottom();
      else term.scrollToLine(resolveViewportAnchorTarget(anchor, readScrollSnapshot() || {
        viewportY: anchor.viewportY,
        baseY: anchor.baseY,
        isAtBottom: anchor.isAtBottom,
      }));
      try { syncViewportHeight(`force-reveal.${source}`); } catch {}
      if (anchor.isAtBottom) syncFollowBottomDomScrollbar(`force-reveal.${source}`);
      refreshVisibleTerminalRows(`force-reveal.${source}`);
      logScrollDiagnostic(`viewport.force-reveal source=${source} anchor=${formatViewportReadAnchor(anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    } catch {}
  }

  /**
   * 在后续渲染帧再次刷新 reset 单屏内容，覆盖 rows 回落和浏览器 scrollTop clamp 的异步边界。
   * @param source 触发来源
   */
  function scheduleFollowBottomResetSingleScreenRefresh(source: string): void {
    const currentTerm = term;
    if (!currentTerm) return;
    let frame = 0;
    const run = () => {
      if (!term || term !== currentTerm) return;
      frame += 1;
      try {
        syncViewportHeight(`terminal-reset-single-screen.${source}.raf${frame}`);
        refreshVisibleTerminalRows(`terminal-reset-single-screen.${source}.raf${frame}`, true);
        logScrollDiagnostic(`viewport.refresh-single-screen.raf frame=${frame} source=${source} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      } catch {}
      if (frame < 2) {
        try { window.requestAnimationFrame(run); } catch {}
      }
    };
    try { window.requestAnimationFrame(run); } catch {}
  }

  /**
   * 刷新 reset 后的单屏 follow-bottom 视图，不主动滚动到底部。
   * @param source 触发来源
   */
  function refreshFollowBottomResetSingleScreen(source: string): void {
    if (!term) return;
    try {
      syncViewportHeight(`terminal-reset-single-screen.${source}`);
      refreshVisibleTerminalRows(`terminal-reset-single-screen.${source}`, true);
      scheduleFollowBottomResetSingleScreenRefresh(source);
      logScrollDiagnostic(`viewport.refresh-single-screen source=${source} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    } catch {}
  }

  /**
   * 在事务仍等待真实 resize settle 时刷新 reset 单屏画面，但不主动滚动也不结束事务。
   * @param tx resize 重绘事务
   * @param source 触发来源
   */
  function refreshFollowBottomResetSingleScreenDuringTransaction(tx: ViewportResizeTransaction, source: string): void {
    if (!term) return;
    const now = nowMs();
    if (tx.singleScreenRefreshAt !== null && now - tx.singleScreenRefreshAt < VIEWPORT_RESIZE_RESET_REFRESH_INTERVAL_MS) return;
    tx.singleScreenRefreshAt = now;
    try {
      refreshVisibleTerminalRows(`terminal-reset-single-screen.tx.${source}`, true);
      logScrollDiagnostic(`viewport.refresh-single-screen.pending source=${source} ${formatViewportResizeTransaction(tx)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    } catch {}
  }

  /**
   * 在宿主布局 resize 刚开始时提前保存底部跟随事务，避免后续 DOM 高度变化把底部污染成 read-anchor。
   * @param source 触发来源
   */
  function notifyViewportLayoutResizeStart(source: string): void {
    if (!term) return;
    if (isViewportUserScrollActive()) return;
    const snapshot = readScrollSnapshot();
    const dom = readDomScrollState();
    rememberViewportBottomEvidence(snapshot, dom);

    const existing = viewportResizeTransaction;
    if (existing) {
      waitViewportResizeTransaction(`layout-resize.${source}`);
      logScrollDiagnostic(`resize-anchor.keep source=layout-resize.${source} reason=existing ${formatViewportResizeTransaction(existing)} anchor=${formatViewportReadAnchor(existing.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(dom)}`);
      return;
    }

    const resolved = resolveLayoutResizeBottomAnchorSnapshot(snapshot, dom);
    if (!resolved) {
      logScrollDiagnostic(`resize-anchor.layout-skip source=${source} reason=no-bottom-intent ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(dom)}`);
      return;
    }

    const anchor = createViewportReadAnchor(resolved.snapshot, `layout-resize.${source}`, {
      cols: term.cols,
      rows: term.rows,
    });
    anchor.viewportY = anchor.baseY;
    anchor.distanceFromBottom = 0;
    anchor.ratio = 1;
    anchor.isAtBottom = true;
    const tx = startViewportResizeTransaction(anchor);
    scheduleViewportReconcile(`layout-resize.${source}`);
    scheduleViewportResizeReleaseCheck(`layout-resize.${source}`, true);
    logScrollDiagnostic(`resize-anchor.capture source=layout-resize.${source} reason=${resolved.reason} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(dom)}`);
  }

  /**
   * 标记真实 PTY resize 已进入 Manager 的延迟下发窗口。
   * @param size Manager 计划下发到 PTY 的目标行列
   * @param source 触发来源
   */
  function notifyViewportPtyResizePending(size: { cols: number; rows: number }, source: string): void {
    const snapshot = readScrollSnapshot();
    let tx = viewportResizeTransaction;
    if (!tx && snapshot && snapshot.baseY > 0) {
      const anchor = createViewportReadAnchor(snapshot, `pty-resize.${source}`, {
        cols: term?.cols || size.cols || 0,
        rows: term?.rows || size.rows || 0,
      });
      tx = startViewportResizeTransaction(anchor);
      logScrollDiagnostic(`resize-anchor.capture source=pty-resize.pending reason=manager-pending ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(anchor)} targetSize=${size.cols}x${size.rows} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
    }
    if (!tx) return;
    const now = nowMs();
    if (!tx.ptyResizePending) tx.ptyResizePendingAt = now;
    tx.ptyResizePending = true;
    tx.ptyResizeCompletedAt = null;
    tx.ptyResizeCompletedResult = null;
    tx.lastActivityAt = now;
    scheduleViewportResizeReleaseCheck(`pty-resize.pending.${source}`, true);
    logScrollDiagnostic(`resize-anchor.pty-pending source=${source} targetSize=${size.cols}x${size.rows} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
  }

  /**
   * 标记 Manager 的真实 PTY resize 排队窗口已经结束。
   * @param size Manager 最终处理的目标行列
   * @param source 触发来源
   * @param result 下发结果
   */
  function notifyViewportPtyResizeComplete(
    size: { cols: number; rows: number },
    source: string,
    result: "sent" | "skipped" | "failed",
  ): void {
    const tx = viewportResizeTransaction;
    if (!tx) return;
    const now = nowMs();
    tx.ptyResizePending = false;
    tx.ptyResizeCompletedAt = now;
    tx.ptyResizeCompletedResult = result;
    tx.lastActivityAt = now;
    scheduleViewportResizeReleaseCheck(`pty-resize.${result}.${source}`, true);
    scheduleViewportReconcile(`pty-resize.${result}.${source}`);
    logScrollDiagnostic(`resize-anchor.pty-complete source=${source} result=${result} targetSize=${size.cols}x${size.rows} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
  }

  /**
   * 读取当前真实滚动快照。
   *
   * resize 事务只保存恢复意图，不能向外暴露旧锚点快照，否则标签恢复/滚动条同步会把旧 buffer 状态写回 DOM。
   */
  function readStableScrollSnapshot(): TerminalScrollSnapshot | null {
    const snapshot = readScrollSnapshot();
    rememberViewportBottomEvidence(snapshot, readDomScrollState());
    return snapshot;
  }

  /**
   * 结束 resize 重绘事务。
   * @param source 释放来源
   */
  function releaseViewportResizeTransaction(source: string): void {
    const tx = viewportResizeTransaction;
    if (!tx) return;
    const forceRelease = source === "dispose" || source.startsWith("user.");
    const snapshot = readScrollSnapshot();
    const rebuildReason = getViewportResizeRebuildReason(snapshot);
    const txExpired = canExpireViewportResizeTransaction(tx);
    const anchorWaitReason = getViewportReadAnchorWaitReason(tx.anchor, snapshot);
    const readAnchorResetInvalidated = isReadAnchorResetAnchorInvalidated(tx, snapshot);
    const terminalResetSettled = isViewportResizeTerminalResetSettled(tx, snapshot);
    const followBottomMinHold = tx.mode === "follow-bottom" && nowMs() - tx.startedAt < VIEWPORT_RESIZE_FOLLOW_BOTTOM_MIN_HOLD_MS;
    if (!forceRelease && followBottomMinHold) {
      logScrollDiagnostic(`resize-anchor.keep source=${source} reason=follow-bottom-min-hold ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      scheduleViewportReconcile(source);
      waitViewportResizeTransaction(source);
      return;
    }
    if (!forceRelease && tx.ptyResizePending && !txExpired) {
      logScrollDiagnostic(`resize-anchor.keep source=${source} reason=pty-resize-pending ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      scheduleViewportReconcile(source);
      waitViewportResizeTransaction(source);
      return;
    } else if (!forceRelease && tx.ptyResizePending && txExpired) {
      logScrollDiagnostic(`resize-anchor.expire source=${source} reason=pty-resize-pending ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
    }
    if (!forceRelease && rebuildReason && !txExpired) {
      logScrollDiagnostic(`resize-anchor.keep source=${source} reason=${rebuildReason} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      scheduleViewportReconcile(source);
      waitViewportResizeTransaction(source);
      return;
    } else if (!forceRelease && rebuildReason && txExpired) {
      logScrollDiagnostic(`resize-anchor.expire source=${source} reason=${rebuildReason} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
    }
    if (!forceRelease && anchorWaitReason && !readAnchorResetInvalidated && !txExpired) {
      logScrollDiagnostic(`resize-anchor.keep source=${source} reason=${anchorWaitReason} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      scheduleViewportReconcile(source);
      waitViewportResizeTransaction(source);
      return;
    } else if (!forceRelease && anchorWaitReason && !readAnchorResetInvalidated && txExpired) {
      logScrollDiagnostic(`resize-anchor.expire source=${source} reason=${anchorWaitReason} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      if (!tx.anchor.isAtBottom) {
        if (tx.releaseTimer !== null) {
          try { window.clearTimeout(tx.releaseTimer); } catch {}
        }
        viewportResizeTransaction = null;
        if (viewportReadAnchor === tx.anchor) viewportReadAnchor = null;
        try { syncViewportHeight(`expired.${source}`); } catch {}
        logScrollDiagnostic(`resize-anchor.release-expired-unavailable source=${source} reason=${anchorWaitReason} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
        return;
      }
    }
    if (source.startsWith("idle.") && !txExpired && !canReleaseViewportResizeTransaction()) {
      logScrollDiagnostic(`resize-anchor.keep source=${source} reason=not-restored ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      scheduleViewportReconcile(source);
      waitViewportResizeTransaction(source);
      return;
    }
    if (tx.releaseTimer !== null) {
      try { window.clearTimeout(tx.releaseTimer); } catch {}
    }
    if (terminalResetSettled && tx.mode === "follow-bottom") {
      if (isFollowBottomResetEmptyScreenSettled(tx, snapshot)) {
        refreshFollowBottomResetSingleScreen(source);
        logScrollDiagnostic(`resize-anchor.release-terminal-reset-bottom-single-screen source=${source} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      } else {
        forceRevealViewportAnchor(tx.anchor, `terminal-reset.${source}`);
        logScrollDiagnostic(`resize-anchor.release-terminal-reset-bottom source=${source} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      }
    } else if (readAnchorResetInvalidated) {
      try { syncViewportHeight(`terminal-reset-invalidated.${source}`); } catch {}
      logScrollDiagnostic(`resize-anchor.release-terminal-reset-invalidated source=${source} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    } else if (terminalResetSettled) {
      try { syncViewportHeight(`terminal-reset.${source}`); } catch {}
      logScrollDiagnostic(`resize-anchor.release-terminal-reset source=${source} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    } else if (tx.mode === "follow-bottom") {
      forceRevealViewportAnchor(tx.anchor, source);
    } else {
      try { syncViewportHeight(`release.${source}`); } catch {}
      const afterSyncSnapshot = readScrollSnapshot();
      const afterSyncDom = readDomScrollState();
      const target = afterSyncSnapshot ? resolveViewportAnchorTarget(tx.anchor, afterSyncSnapshot) : tx.anchor.viewportY;
      const drifted = !afterSyncSnapshot
        || Math.abs(afterSyncSnapshot.viewportY - target) > VIEWPORT_ROW_TOLERANCE
        || hasViewportMismatch(afterSyncSnapshot, afterSyncDom);
      if (drifted && !forceRelease) {
        logScrollDiagnostic(`resize-anchor.release-read-anchor.post-sync-drift source=${source} target=${target} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(afterSyncSnapshot)} ${formatDomScrollState(afterSyncDom)}`);
        scheduleViewportReconcile(source);
        waitViewportResizeTransaction(source);
        return;
      }
      logScrollDiagnostic(`resize-anchor.release-read-anchor source=${source} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
    }
    viewportResizeTransaction = null;
    if (viewportReadAnchor === tx.anchor) viewportReadAnchor = null;
    logScrollDiagnostic(`resize-anchor.release source=${source} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(tx.anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
  }

  /**
   * 依据当前 buffer 视口捕获阅读锚点，用于输出重绘或窗口尺寸变化后恢复用户正在看的位置。
   * @param source 捕获来源
   */
  function captureViewportReadAnchor(source: string): ViewportReadAnchor | null {
    const snapshot = readScrollSnapshot();
    if (viewportResizeTransaction) {
      waitViewportResizeTransaction(source);
      logScrollDiagnostic(`resize-anchor.keep source=${source} reason=locked ${formatViewportResizeTransaction(viewportResizeTransaction)} existing=${formatViewportReadAnchor(viewportResizeTransaction.anchor)} current=${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      return viewportResizeTransaction.anchor;
    }
    if (!snapshot || snapshot.baseY <= 0) return null;
    if (
      viewportReadAnchor
      && !viewportReadAnchor.isAtBottom
      && (
        snapshot.viewportY < viewportReadAnchor.viewportY - VIEWPORT_ROW_TOLERANCE
        || snapshot.baseY < viewportReadAnchor.baseY
      )
    ) {
      logScrollDiagnostic(`anchor.keep source=${source} reason=buffer-shrunk existing=${formatViewportReadAnchor(viewportReadAnchor)} current=${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      return viewportReadAnchor;
    }
    if (snapshot.isAtBottom) {
      viewportReadAnchor = null;
      return null;
    }
    const anchor = createViewportReadAnchor(snapshot, source);
    viewportReadAnchor = anchor;
    logScrollDiagnostic(`anchor.capture source=${source} anchor=${formatViewportReadAnchor(anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
    return anchor;
  }

  /**
   * 根据当前 buffer 长度计算锚点应恢复到的 viewportY。
   * @param anchor 阅读锚点
   * @param snapshot 当前滚动快照
   */
  function resolveViewportAnchorTarget(
    anchor: ViewportReadAnchor,
    snapshot: TerminalScrollSnapshot,
  ): number {
    const baseY = Math.max(0, snapshot.baseY);
    if (anchor.isAtBottom) return baseY;
    const currentCols = term?.cols || 0;
    if (!anchor.cols || !currentCols || anchor.cols === currentCols) {
      return Math.max(0, Math.min(baseY, Math.round(anchor.viewportY)));
    }
    return Math.max(0, Math.min(baseY, Math.round(baseY * anchor.ratio)));
  }

  /**
   * 尝试恢复阅读锚点，成功恢复或锚点过期时返回 true。
   * @param source 触发来源
   */
  function tryRestoreViewportReadAnchor(source: string): boolean {
    const anchor = viewportReadAnchor || viewportResizeTransaction?.anchor || null;
    if (!anchor || !term) return false;
    if (viewportResizeTransaction?.anchor === anchor && viewportReadAnchor !== anchor) viewportReadAnchor = anchor;
    if (isViewportUserScrollActive()) return false;
    const tx = viewportResizeTransaction && viewportResizeTransaction.anchor === anchor ? viewportResizeTransaction : null;
    const txExpired = !!tx && nowMs() - tx.startedAt > VIEWPORT_RESIZE_ANCHOR_TTL_MS;
    const txCanExpire = !!tx && canExpireViewportResizeTransaction(tx);
    const age = nowMs() - anchor.createdAt;
    if (age > VIEWPORT_ANCHOR_TTL_MS) {
      if (tx && !txExpired) {
        waitViewportResizeTransaction(source);
      } else if (!tx) {
        logScrollDiagnostic(`anchor.drop source=${source} reason=expired age=${Math.round(age)} anchor=${formatViewportReadAnchor(anchor)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
        viewportReadAnchor = null;
        return true;
      }
    }
    const snapshot = readScrollSnapshot();
    observeViewportResizeBaseY(snapshot);
    if (!snapshot) {
      if (txCanExpire) releaseViewportResizeTransaction(`expired.no-snapshot.${source}`);
      else if (tx) waitViewportResizeTransaction(source);
      return false;
    }
    if (!anchor.isAtBottom && !tx && snapshot.baseY >= anchor.baseY && Math.abs(snapshot.viewportY - anchor.viewportY) <= VIEWPORT_ROW_TOLERANCE) {
      viewportReadAnchor = null;
      return true;
    }
    const rebuildReason = tx ? getViewportResizeRebuildReason(snapshot) : null;
    if (tx && rebuildReason) {
      if (txCanExpire) {
        logScrollDiagnostic(`resize-anchor.stalled source=${source} reason=${rebuildReason} action=expire ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
        releaseViewportResizeTransaction(`stalled-expired.${source}`);
        return true;
      }
      waitViewportResizeTransaction(source);
      logScrollDiagnostic(`resize-anchor.wait source=${source} reason=${rebuildReason} ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      return false;
    }
    if (tx && isViewportResizeTerminalResetSettled(tx, snapshot)) {
      releaseViewportResizeTransaction(`terminal-reset.${source}`);
      return true;
    }
    const anchorWaitReason = getViewportReadAnchorWaitReason(anchor, snapshot);
    if (anchorWaitReason) {
      if (tx && txCanExpire) {
        logScrollDiagnostic(`resize-anchor.stalled source=${source} reason=${anchorWaitReason} action=expire ${formatViewportResizeTransaction(tx)} anchor=${formatViewportReadAnchor(anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
        releaseViewportResizeTransaction(`stalled-expired.${source}`);
        return true;
      }
      if (tx) waitViewportResizeTransaction(source);
      scheduleViewportReconcile(source);
      logScrollDiagnostic(`${tx ? "resize-anchor" : "anchor"}.wait source=${source} reason=${anchorWaitReason} ${tx ? formatViewportResizeTransaction(tx) : formatPendingWriteState()} anchor=${formatViewportReadAnchor(anchor)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      return false;
    }
    const target = resolveViewportAnchorTarget(anchor, snapshot);
    const restored = anchor.isAtBottom
      ? isViewportAtStrictBottom(snapshot)
      : Math.abs(snapshot.viewportY - target) <= VIEWPORT_ROW_TOLERANCE;
    if (restored) {
      if (anchor.isAtBottom) {
        try { syncFollowBottomDomScrollbar(`anchor-settled.${source}`); } catch {}
      }
      logScrollDiagnostic(`${tx ? "resize-anchor" : "anchor"}.restore.skip source=${source} reason=settled target=${target} diff=${Math.round(Math.abs(snapshot.viewportY - target))} strictBottom=${isViewportAtStrictBottom(snapshot) ? "1" : "0"} ${tx ? formatViewportResizeTransaction(tx) : formatPendingWriteState()} anchor=${formatViewportReadAnchor(anchor)} current=${formatScrollSnapshot(snapshot)} ${formatDomScrollState(readDomScrollState())}`);
      if (tx) {
        if (txExpired && canReleaseViewportResizeTransaction()) releaseViewportResizeTransaction(`settled-expired.${source}`);
        else waitViewportResizeTransaction(source);
        return true;
      }
      viewportReadAnchor = null;
      return true;
    }
    try {
      allowProgrammaticViewportScroll(2);
      if (anchor.isAtBottom) term.scrollToBottom();
      else term.scrollToLine(target);
      try { syncViewportHeight(`anchor.${source}`); } catch {}
      if (anchor.isAtBottom) syncFollowBottomDomScrollbar(`anchor.${source}`);
      const after = readScrollSnapshot();
      logScrollDiagnostic(`${tx ? "resize-anchor" : "anchor"}.restore source=${source} target=${target} ${tx ? formatViewportResizeTransaction(tx) : formatPendingWriteState()} anchor=${formatViewportReadAnchor(anchor)} before=${formatScrollSnapshot(snapshot)} after=${formatScrollSnapshot(after)} ${formatDomScrollState(readDomScrollState())}`);
      if (tx) {
        tx.restoreCount += 1;
        if (txExpired && canReleaseViewportResizeTransaction()) releaseViewportResizeTransaction(`restored-expired.${source}`);
        else waitViewportResizeTransaction(source);
      } else {
        viewportReadAnchor = null;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 读取当前 xterm 渲染行高。
   */
  function readTerminalLineHeightPx(): number {
    try {
      const core: any = (term as any)?._core;
      const dims = core?._renderService?.dimensions?.css?.cell || {};
      const cellH = Number(dims?.height || 0);
      if (cellH && isFinite(cellH)) return cellH;
    } catch {}
    const dom = readDomScrollState();
    const snapshot = readScrollSnapshot();
    if (dom && snapshot && snapshot.baseY > 0 && dom.maxScrollTop > 0) {
      const guessed = dom.maxScrollTop / snapshot.baseY;
      if (guessed && isFinite(guessed) && guessed > 0) return guessed;
    }
    return 0;
  }

  /**
   * 判断 DOM 滚动条投影是否已经偏离 xterm buffer 视口。
   * @param snapshot xterm buffer 滚动快照
   * @param dom DOM viewport 滚动度量
   */
  function hasViewportMismatch(
    snapshot: TerminalScrollSnapshot | null | undefined,
    dom: TerminalDomScrollState | null | undefined,
  ): boolean {
    if (!snapshot || !dom) return false;
    const lineHeight = readTerminalLineHeightPx();
    if (!lineHeight || !isFinite(lineHeight) || lineHeight <= 0) return false;
    const domViewportY = Math.round(dom.scrollTop / lineHeight);
    return Math.abs(domViewportY - snapshot.viewportY) > VIEWPORT_ROW_TOLERANCE;
  }

  /**
   * 把 DOM viewport 重新对齐到 xterm 当前 buffer 视口，避免浏览器 clamp 后反向污染 ydisp。
   * @param source 触发来源
   */
  function scheduleViewportReconcile(source: string): void {
    if (!term || !container) return;
    viewportReconcilePendingFrames = Math.max(
      viewportReconcilePendingFrames,
      viewportReadAnchor ? VIEWPORT_ANCHOR_RESTORE_FRAMES : VIEWPORT_RECONCILE_FRAMES,
    );
    if (viewportReconcileRaf !== null) return;
    /**
     * 执行单帧 viewport 对齐。
     */
    const run = () => {
      viewportReconcileRaf = null;
      if (!term || !container || viewportReconcilePendingFrames <= 0) return;
      if (isViewportUserScrollActive()) {
        if (!viewportReadAnchor) {
          viewportReconcilePendingFrames = 0;
          return;
        }
        try { viewportReconcileRaf = window.requestAnimationFrame(run); } catch { viewportReconcileRaf = null; }
        return;
      }
      viewportReconcilePendingFrames -= 1;
      const beforeSnapshot = readScrollSnapshot();
      const beforeDom = readDomScrollState();
      try { syncViewportHeight(`reconcile.${source}`); } catch {}
      const hadAnchor = !!viewportReadAnchor;
      tryRestoreViewportReadAnchor(source);
      const afterSnapshot = readScrollSnapshot();
      const afterDom = readDomScrollState();
      if (!viewportReadAnchor && hasViewportMismatch(afterSnapshot, afterDom)) {
        syncScrollbarToSnapshot(afterSnapshot, `reconcile.${source}`);
      }
      const finalSnapshot = readScrollSnapshot();
      const finalDom = readDomScrollState();
      if (hasViewportMismatch(finalSnapshot, finalDom) || hasDomScrollDelta(beforeDom, finalDom) || hadAnchor) {
        logScrollDiagnostic(`viewport.reconcile source=${source} framesLeft=${viewportReconcilePendingFrames} anchorPending=${viewportReadAnchor ? "1" : "0"} before=${formatScrollSnapshot(beforeSnapshot)} ${formatDomScrollState(beforeDom)} after=${formatScrollSnapshot(finalSnapshot)} ${formatDomScrollState(finalDom)}`);
      }
      if (viewportReconcilePendingFrames > 0) {
        try { viewportReconcileRaf = window.requestAnimationFrame(run); } catch { viewportReconcileRaf = null; }
      }
    };
    try { viewportReconcileRaf = window.requestAnimationFrame(run); } catch { viewportReconcileRaf = null; }
  }

  /**
   * 中文说明：判断两次 DOM 滚动度量是否存在值得记录的差异。
   */
  const hasDomScrollDelta = (
    before: TerminalDomScrollState | null | undefined,
    after: TerminalDomScrollState | null | undefined,
  ): boolean => {
    if (!before || !after) return !!before !== !!after;
    return Math.abs(before.scrollTop - after.scrollTop) > 1
      || Math.abs(before.scrollHeight - after.scrollHeight) > 1
      || Math.abs(before.clientHeight - after.clientHeight) > 1
      || Math.abs(before.maxScrollTop - after.maxScrollTop) > 1;
  };

  /**
   * 中文说明：按事件源记录一次当前滚动状态。
   */
  const logCurrentScrollState = (source: string, extra = ""): void => {
    const suffix = extra ? ` ${extra}` : "";
    logScrollDiagnostic(`${source} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}${suffix}`);
  };

  /**
   * 中文说明：安装 DOM viewport 滚动监听，捕获用户滚动、程序写 scrollTop 与浏览器锚点修正产生的实际结果。
   */
  const installViewportScrollDebugListener = (): void => {
    try { removeViewportScrollDebugListener?.(); } catch {}
    removeViewportScrollDebugListener = null;
    if (!container) return;
    try {
      const viewport = container.querySelector(".xterm-viewport") as HTMLDivElement | null;
      if (!viewport) return;
      const host = container;
      const onUserScrollIntent = () => {
        try { markViewportUserScroll("viewport.input"); } catch {}
        viewportReadAnchor = null;
      };
      const onWheelIntent = (_event: WheelEvent) => {
        try { markViewportUserScroll("wheel"); } catch {}
        viewportReadAnchor = null;
      };
      const onPointerDownIntent = () => {
        try { markViewportPointerDragStart("pointerdown"); } catch {}
        viewportReadAnchor = null;
      };
      const onPointerEndIntent = () => {
        try { markViewportPointerDragEnd("pointerup"); } catch {}
      };
      const onPointerCancelIntent = () => {
        try { markViewportPointerDragEnd("pointercancel"); } catch {}
      };
      const onViewportScroll = () => {
        const state = readDomScrollState();
        if (!state) return;
        const now = nowMs();
        const previousTop = lastViewportScrollTop;
        const previousMaxTop = lastViewportScrollMaxTop;
        const changed = previousTop === null || Math.abs(state.scrollTop - previousTop) > 1;
        if (!changed && now - lastViewportScrollLogAt < 160) return;
        lastViewportScrollLogAt = now;
        lastViewportScrollTop = state.scrollTop;
        lastViewportScrollMaxTop = state.maxScrollTop;
        const snapshot = readScrollSnapshot();
        if (viewportResizeTransaction && hasViewportMismatch(snapshot, state)) {
          logScrollDiagnostic(`dom.scroll.ignored prevTop=${previousTop === null ? "n/a" : Math.round(previousTop)} reason=resize-transaction ${formatViewportResizeTransaction(viewportResizeTransaction)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(state)}`);
          return;
        }
        const accepted = canAcceptViewportDomScroll();
        if (!accepted && shouldInferViewportUserScrollFromDom(snapshot, state, changed, accepted, previousTop, previousMaxTop)) {
          markViewportUserScroll("dom.scroll", VIEWPORT_SCROLLBAR_DRAG_INTENT_WINDOW_MS);
          logScrollDiagnostic(`dom.scroll.infer-user prevTop=${previousTop === null ? "n/a" : Math.round(previousTop)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(state)}`);
          return;
        }
        if (!accepted && hasViewportMismatch(snapshot, state)) {
          logScrollDiagnostic(`dom.scroll.ignored prevTop=${previousTop === null ? "n/a" : Math.round(previousTop)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(state)}`);
          return;
        }
        logScrollDiagnostic(`dom.scroll prevTop=${previousTop === null ? "n/a" : Math.round(previousTop)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(state)}`);
      };
      try { host.addEventListener("wheel", onWheelIntent, { passive: true, capture: true }); } catch {}
      viewport.addEventListener("wheel", onUserScrollIntent, { passive: true });
      viewport.addEventListener("pointerdown", onPointerDownIntent, true);
      window.addEventListener("pointerup", onPointerEndIntent, true);
      window.addEventListener("pointercancel", onPointerCancelIntent, true);
      window.addEventListener("blur", onPointerCancelIntent, true);
      viewport.addEventListener("touchstart", onUserScrollIntent, { passive: true });
      viewport.addEventListener("scroll", onViewportScroll, { passive: true });
      removeViewportScrollDebugListener = () => {
        try { host.removeEventListener("wheel", onWheelIntent, true); } catch {}
        try { viewport.removeEventListener("wheel", onUserScrollIntent); } catch {}
        try { viewport.removeEventListener("pointerdown", onPointerDownIntent, true); } catch {}
        try { window.removeEventListener("pointerup", onPointerEndIntent, true); } catch {}
        try { window.removeEventListener("pointercancel", onPointerCancelIntent, true); } catch {}
        try { window.removeEventListener("blur", onPointerCancelIntent, true); } catch {}
        try { viewport.removeEventListener("touchstart", onUserScrollIntent); } catch {}
        try { viewport.removeEventListener("scroll", onViewportScroll); } catch {}
      };
      logCurrentScrollState("dom.scroll.listener-ready");
    } catch {}
  };

  /**
   * 中文说明：记录 xterm buffer 滚动事件，限频避免长输出时 perf.log 被刷爆。
   */
  const logBufferScrollEvent = (): void => {
    const snapshot = readScrollSnapshot();
    if (!snapshot) return;
    const dom = readDomScrollState();
    rememberViewportBottomEvidence(snapshot, dom);
    const now = nowMs();
    const previousY = lastBufferViewportY;
    const changed = previousY === null || Math.abs(snapshot.viewportY - previousY) > 0.1;
    if (!changed && now - lastBufferScrollLogAt < 250) return;
    lastBufferScrollLogAt = now;
    lastBufferViewportY = snapshot.viewportY;
    logScrollDiagnostic(`buffer.scroll prevY=${previousY === null ? "n/a" : Math.round(previousY)} ${formatScrollSnapshot(snapshot)} ${formatDomScrollState(dom)}`);
    scheduleViewportReconcile("buffer.scroll");
  };

  /**
   * 中文说明：读取指定绝对行所在的逻辑行，并自动合并 wrap 后续行。
   * @param buf xterm 当前活动缓冲区
   * @param anchorAbsY 逻辑行中的任意绝对行号
   * @returns 逻辑行范围与文本；不可读时返回 null
   */
  const readLogicalLineAt = (
    buf: any,
    anchorAbsY: number,
  ): { startAbsY: number; endAbsY: number; text: string } | null => {
    try {
      const len = Number(buf?.length || 0);
      if (!(len > 0)) return null;
      let startAbsY = Math.max(0, Math.min(Math.floor(anchorAbsY), len - 1));
      while (startAbsY > 0) {
        const line = buf.getLine?.(startAbsY);
        if (!line?.isWrapped) break;
        startAbsY -= 1;
      }
      let endAbsY = startAbsY;
      while (endAbsY + 1 < len) {
        const next = buf.getLine?.(endAbsY + 1);
        if (!next?.isWrapped) break;
        endAbsY += 1;
      }
      let out = "";
      for (let y = startAbsY; y <= endAbsY; y++) {
        const current = buf.getLine?.(y);
        if (!current) continue;
        const next = buf.getLine?.(y + 1);
        const isWrappedNext = !!(next && next.isWrapped);
        out += current.translateToString(!isWrappedNext);
      }
      return { startAbsY, endAbsY, text: out };
    } catch {
      return null;
    }
  };

  /**
   * 中文说明：读取光标附近若干逻辑行的文本快照。
   * @param options.linesBefore 光标所在逻辑行之前额外读取的逻辑行数
   * @param options.linesAfter 光标所在逻辑行之后额外读取的逻辑行数
   * @param options.maxChars 返回文本允许的最大字符数（超出时仅保留尾部）
   * @returns 光标附近的逻辑文本快照；不可读时返回 null
   */
  const readCursorTextSnapshot = (
    options?: TerminalCursorTextSnapshotOptions,
  ): TerminalCursorTextSnapshot | null => {
    if (!term) return null;
    try {
      const buf: any = (term as any)?.buffer?.active;
      if (!buf) return null;
      const len = Number(buf.length || 0);
      if (!(len > 0)) return null;
      const linesBefore = Math.max(0, Math.floor(Number(options?.linesBefore) || 0));
      const linesAfter = Math.max(0, Math.floor(Number(options?.linesAfter) || 0));
      const maxChars = Math.max(64, Math.floor(Number(options?.maxChars) || 4096));
      const cursorAbsY = Math.max(
        0,
        Math.min(Number(buf.baseY || 0) + Number(buf.cursorY || 0), len - 1),
      );
      const current = readLogicalLineAt(buf, cursorAbsY);
      if (!current) return null;

      const entries: Array<{ startAbsY: number; endAbsY: number; text: string }> = [current];
      let probeAbsY = current.startAbsY - 1;
      for (let i = 0; i < linesBefore && probeAbsY >= 0; i++) {
        const previous = readLogicalLineAt(buf, probeAbsY);
        if (!previous) break;
        entries.unshift(previous);
        probeAbsY = previous.startAbsY - 1;
      }
      probeAbsY = current.endAbsY + 1;
      for (let i = 0; i < linesAfter && probeAbsY < len; i++) {
        const next = readLogicalLineAt(buf, probeAbsY);
        if (!next) break;
        entries.push(next);
        probeAbsY = next.endAbsY + 1;
      }

      const lines = entries.map((entry) => entry.text);
      let text = lines.join("\n");
      if (text.length > maxChars) text = text.slice(-maxChars);
      return {
        bufferType: String(buf.type || ""),
        cursorAbsY,
        startAbsY: entries[0]?.startAbsY ?? current.startAbsY,
        endAbsY: entries[entries.length - 1]?.endAbsY ?? current.endAbsY,
        lines,
        text,
      };
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
    if (viewportResizeTransaction) {
      logScrollDiagnostic(`scrollbar.skip tag=${tag} reason=resize-transaction snapshot=${formatScrollSnapshot(snapshot ?? null)} current=${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      return;
    }
    const current = readStableScrollSnapshot();
    if (!current || current.baseY <= 0) {
      logScrollDiagnostic(`scrollbar.skip tag=${tag} reason=unstable-current snapshot=${formatScrollSnapshot(snapshot ?? null)} current=${formatScrollSnapshot(current)} last=${formatScrollSnapshot(lastScrollSnapshot)} ${formatDomScrollState(readDomScrollState())}`);
      return;
    }
    const effective = current;
    if (!effective) return;
    const beforeDom = readDomScrollState();

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
        logScrollDiagnostic(`scrollbar.write tag=${tag} target=${clamped} perLine=${perLinePx.toFixed(3)} effective=${formatScrollSnapshot(effective)} current=${formatScrollSnapshot(current)} before=${formatDomScrollState(beforeDom)}`);
        allowProgrammaticViewportScroll();
        viewport.scrollTop = clamped;
        logCurrentScrollState(`scrollbar.after-write tag=${tag}`);
      } else if (tag.startsWith("restore")) {
        logScrollDiagnostic(`scrollbar.keep tag=${tag} target=${clamped} effective=${formatScrollSnapshot(effective)} current=${formatScrollSnapshot(current)} before=${formatDomScrollState(beforeDom)} after=${formatDomScrollState(readDomScrollState())}`);
      }
    } catch {}

    lastScrollSnapshot = readStableScrollSnapshot();
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
    const beforeDom = readDomScrollState();
    const beforeSnapshot = readScrollSnapshot();
    const rebuildReason = getViewportResizeRebuildReason(beforeSnapshot);
    const resizeTx = viewportResizeTransaction;
    const allowResetSingleScreenSync = !!resizeTx
      && rebuildReason === "empty-buffer"
      && canSyncFollowBottomResetSingleScreen(resizeTx, beforeSnapshot);
    if (rebuildReason && resizeTx && !allowResetSingleScreenSync) {
      waitViewportResizeTransaction(tag);
      logScrollDiagnostic(`viewport.sync.skip tag=${tag} reason=${rebuildReason} anchor=${formatViewportReadAnchor(resizeTx.anchor)} before=${formatScrollSnapshot(beforeSnapshot)} ${formatDomScrollState(beforeDom)} after=${formatDomScrollState(readDomScrollState())}`);
      return;
    }
    try {
      const core: any = (term as any)?._core;
      const viewport = core?.viewport;
      if (viewport && typeof viewport.syncScrollArea === "function") {
        viewport.syncScrollArea(true);
        const afterDom = readDomScrollState();
        const afterSnapshot = readScrollSnapshot();
        rememberViewportBottomEvidence(afterSnapshot, afterDom);
        if (hasDomScrollDelta(beforeDom, afterDom) || tag.startsWith("scrollbar") || tag === "fitAndPin") {
          logScrollDiagnostic(`viewport.sync tag=${tag} before=${formatScrollSnapshot(beforeSnapshot)} ${formatDomScrollState(beforeDom)} after=${formatScrollSnapshot(afterSnapshot)} ${formatDomScrollState(afterDom)}`);
        }
        if (allowResetSingleScreenSync && resizeTx) {
          refreshFollowBottomResetSingleScreenDuringTransaction(resizeTx, tag);
        }
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
      logScrollDiagnostic(`fit.start host=${Math.round(hostW0)}x${Math.round(hostH0)} before=${before.cols}x${before.rows} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);

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
          logScrollDiagnostic(`fit.skip hidden=${hidden ? "1" : "0"} host=${Math.round(hostW0)}x${Math.round(hostH0)} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
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
        logScrollDiagnostic(`fit.noCellH size=${term.cols}x${term.rows} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
        if (forceRefresh) try { term.refresh(0, term.rows - 1); } catch {}
        return { cols: term.cols, rows: term.rows };
      }

      if (pinDisabled()) {
        // 调试开关：禁用“整行钉死”，仅执行常规 fit
        fitAddon.fit();
        dlog(`[adapter] dims cell=${cellW.toFixed(2)}x${cellH.toFixed(2)} dpr=${(window.devicePixelRatio||1).toFixed(2)}`);
        logScrollDiagnostic(`fit.pinDisabled cell=${cellW.toFixed(2)}x${cellH.toFixed(2)} after=${term.cols}x${term.rows} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
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
      logScrollDiagnostic(`fit.pinned cell=${cellW.toFixed(2)}x${cellH.toFixed(2)} host=${Math.round(hostWidth)}x${hostH} rows=${rows} pinnedPx=${pinnedPx} after=${term.cols}x${term.rows} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      // 低版本 Windows：尝试一次“临时关闭 windowsMode + 列宽轻抖动”的降级重排
      try {
        if (legacyWinNeedsReflowHack && term && term.cols) {
          const need = legacyLastCols !== term.cols;
          if (need) {
            const targetCols = term.cols;
            const prevMode = !!((term as any)?.options?.windowsMode);
            dlog(`[adapter] legacy.reflow try build=${legacyWinBuild} targetCols=${targetCols}`);
            logScrollDiagnostic(`legacy.reflow.try build=${legacyWinBuild} targetCols=${targetCols} ${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
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
      tryRestoreViewportReadAnchor("fitAndPin");
      scheduleViewportReconcile("fitAndPin");
      return { cols: term.cols, rows: term.rows };
    } catch {
      try { fitAddon!.fit(); } catch {}
      tryRestoreViewportReadAnchor("fitAndPin.catch");
      scheduleViewportReconcile("fitAndPin.catch");
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
          lastScrollSnapshot = readStableScrollSnapshot();
          try { logBufferScrollEvent(); } catch {}
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
      try { installViewportScrollDebugListener(); } catch {}
      try { logCurrentScrollState("mount.open", `dpr=${(window.devicePixelRatio || 1).toFixed(2)}`); } catch {}
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
        /**
         * 判断按键是否表达了用户查看历史输出的意图。
         * @param e 键盘事件
         */
        const isHistoryScrollKey = (e: KeyboardEvent): boolean => {
          const key = String(e.key || "").toLowerCase();
          return key === "pageup" || key === "pagedown";
        };
        /**
         * 中文说明：解析终端滚动端点快捷键，仅响应 Ctrl + Home / Ctrl + End。
         */
        const getBoundaryScrollAction = (e: KeyboardEvent): "top" | "bottom" | null => {
          const key = String(e.key || "").toLowerCase();
          if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return null;
          if (key === "home") return "top";
          if (key === "end") return "bottom";
          return null;
        };
        /**
         * 中文说明：判断当前终端是否适合处理端点滚动快捷键，避免影响全屏程序等 alternate buffer 场景。
         */
        const canHandleBoundaryScrollAction = (action: "top" | "bottom"): boolean => {
          try {
            const buffer = term?.buffer.active;
            if (!buffer || buffer.type !== "normal") return false;
            const viewportY = Number(buffer.viewportY || 0);
            const baseY = Number(buffer.baseY || 0);
            if (action === "top") return viewportY > 0;
            return baseY > 0 && viewportY < baseY;
          } catch {
            return false;
          }
        };
        /**
         * 中文说明：执行终端滚动端点快捷操作；返回 true 表示事件已被当前终端消费。
         */
        const handleBoundaryScrollAction = (e: KeyboardEvent): boolean => {
          const action = getBoundaryScrollAction(e);
          if (!action || !canHandleBoundaryScrollAction(action)) return false;
          try {
            markViewportUserScroll(`key.${action}`);
            viewportReadAnchor = null;
            if (action === "top") term?.scrollToTop();
            else term?.scrollToBottom();
          } catch {}
          return true;
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
            if (!getBoundaryScrollAction(e) && isHistoryScrollKey(e)) markViewportUserScroll("key.history");
            if (handleBoundaryScrollAction(e)) return false;
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
            if (!getBoundaryScrollAction(e) && isHistoryScrollKey(e)) markViewportUserScroll("key.history");
            if (handleBoundaryScrollAction(e)) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
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
            const boundaryAction = getBoundaryScrollAction(e);
            if (!(boundaryAction || isHistoryScrollKey(e) || isCopyCombo(e) || isPasteCombo(e) || isStdPasteCombo(e))) return;
            const target = e.target as any as Node | null;
            const active = (document.activeElement as any) as Node | null;
            const within = !!container && (container.contains(target || (null as any)) || container.contains(active || (null as any)));
            if (!within) return;
            if (!boundaryAction && isHistoryScrollKey(e)) markViewportUserScroll("key.history");
            if (handleBoundaryScrollAction(e)) {
              e.preventDefault();
              e.stopPropagation();
            }
            else if (isCopyCombo(e)) {
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
      if (!term) ensure();
      enqueueWrite(data);
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
    measureResize: () => {
      if (!term) ensure();
      return measureTerminalResize();
    },
    resizeTo: (size: { cols: number; rows: number }, source = "resizeTo") => {
      if (!term) ensure();
      return commitTerminalResize(size, source);
    },
    hasPendingWriteWork: () => {
      return hasPendingTerminalWriteWork();
    },
    resize: () => {
      // 每次外部要求 resize 时，执行“fit+pin”并强制 refresh
      if (!term || !fitAddon || !container) return { cols: 0, rows: 0 };
      const beforeSize = { cols: term.cols, rows: term.rows };
      const beforeSnapshot = readScrollSnapshot();
      const beforeDom = readDomScrollState();
      const hadResizeTransaction = !!viewportResizeTransaction;
      const proposedSize = proposeTerminalFitSize();
      if (shouldDeferResizeForPendingResetOutput(beforeSize, proposedSize)) {
        scheduleDeferredResizeReady("adapter.resize");
        logScrollDiagnostic(`adapter.resize.defer reason=pending-reset-output target=${proposedSize ? `${proposedSize.cols}x${proposedSize.rows}` : "n/a"} current=${beforeSize.cols}x${beforeSize.rows} txBefore=${hadResizeTransaction ? "1" : "0"} ${formatViewportResizeTransaction(viewportResizeTransaction)} ${formatScrollSnapshot(beforeSnapshot)} ${formatDomScrollState(beforeDom)}`);
        return beforeSize;
      }
      const s = fitAndPin(true);
      const changed = s.cols !== beforeSize.cols || s.rows !== beforeSize.rows;
      if (changed) {
        if (!viewportResizeTransaction && beforeSnapshot && beforeSnapshot.baseY > 0) {
          const anchor = createViewportReadAnchor(beforeSnapshot, "resize.adapter.resize", beforeSize);
          viewportResizeTransaction = startViewportResizeTransaction(anchor);
          logScrollDiagnostic(`resize-anchor.capture source=adapter.resize reason=size-changed ${formatViewportResizeTransaction(viewportResizeTransaction)} anchor=${formatViewportReadAnchor(anchor)} beforeSize=${beforeSize.cols}x${beforeSize.rows} afterSize=${s.cols}x${s.rows} ${formatScrollSnapshot(beforeSnapshot)} ${formatDomScrollState(beforeDom)}`);
        }
        touchViewportResizeTransaction("adapter.resize");
      } else {
        waitViewportResizeTransaction("adapter.resize");
      }
      logScrollDiagnostic(`adapter.resize size=${s.cols}x${s.rows} same=${s.cols === beforeSize.cols && s.rows === beforeSize.rows ? "1" : "0"} txBefore=${hadResizeTransaction ? "1" : "0"} txAfter=${viewportResizeTransaction ? "1" : "0"} ${formatViewportResizeTransaction(viewportResizeTransaction)} before=${formatScrollSnapshot(beforeSnapshot)} ${formatDomScrollState(beforeDom)} after=${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      dlog(`[adapter] resize -> ${s.cols}x${s.rows}`);
      return s;
    },
    notifyPtyResizePending: (size: { cols: number; rows: number }, source: string) => {
      notifyViewportPtyResizePending(size, source);
    },
    notifyPtyResizeComplete: (size: { cols: number; rows: number }, source: string, result: "sent" | "skipped" | "failed") => {
      notifyViewportPtyResizeComplete(size, source, result);
    },
    notifyLayoutResizeStart: (source: string) => {
      notifyViewportLayoutResizeStart(source);
    },
    onDeferredResizeReady: (cb: () => void) => {
      deferredResizeListeners.add(cb);
      return () => {
        deferredResizeListeners.delete(cb);
      };
    },
    getScrollSnapshot: () => {
      if (!term) ensure();
      const snapshot = readStableScrollSnapshot();
      lastScrollSnapshot = snapshot;
      return snapshot;
    },
    restoreScrollSnapshot: (snapshot?: TerminalScrollSnapshot | null) => {
      if (!term) ensure();
      viewportReadAnchor = null;
      logScrollDiagnostic(`restore.request snapshot=${formatScrollSnapshot(snapshot ?? null)} current=${formatScrollSnapshot(readScrollSnapshot())} ${formatDomScrollState(readDomScrollState())}`);
      try { syncScrollbarToSnapshot(snapshot ?? null, "restore"); } catch {}
      // 二次对齐：用于处理标签刚切回时 DOM 尚未稳定的场景
      try { requestAnimationFrame(() => { try { syncScrollbarToSnapshot(snapshot ?? null, "restore.raf"); logCurrentScrollState("restore.raf.done"); } catch {} }); } catch {}
    },
    readCursorTextSnapshot: (options?: TerminalCursorTextSnapshotOptions) => {
      if (!term) ensure();
      return readCursorTextSnapshot(options);
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
    scrollToTop: () => {
      try {
        viewportReadAnchor = null;
        markViewportUserScroll("api.top");
        term?.scrollToTop();
      } catch {}
    },
    scrollToBottom: () => {
      try {
        viewportReadAnchor = null;
        markViewportUserScroll("api.bottom");
        term?.scrollToBottom();
      } catch {}
    },
    dispose: () => {
      try { dlog('[adapter] dispose'); if (container) container.style.height = ""; } catch {}
      // 先取消 pending write，避免在 dispose 后的下一帧仍尝试写入（导致异常或泄漏）。
      try { if (pendingWriteScheduled !== null) cancelAnimationFrame(pendingWriteScheduled); } catch {}
      try { if (viewportReconcileRaf !== null) cancelAnimationFrame(viewportReconcileRaf); } catch {}
      try { if (deferredResizeNotifyRaf !== null) cancelAnimationFrame(deferredResizeNotifyRaf); } catch {}
      pendingWriteScheduled = null;
      viewportReconcileRaf = null;
      deferredResizeNotifyRaf = null;
      deferredResizeStartedAt = null;
      viewportPointerDragActive = false;
      viewportPointerDragUntil = 0;
      userViewportScrollUntil = 0;
      deferredResizeListeners.clear();
      viewportReconcilePendingFrames = 0;
      programmaticViewportScrollAllowance = 0;
      try { releaseViewportResizeTransaction("dispose"); } catch {}
      viewportReadAnchor = null;
      pendingWriteChunks = [];
      pendingWriteChars = 0;
      pendingWriteDroppedChars = 0;
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
      try { removeViewportScrollDebugListener?.(); } catch {}
      removeViewportScrollDebugListener = null;
      // 释放终端与引用
      term?.dispose();
      term = null;
      fitAddon = null;
      container = null;
      lastAuxMouseDownAt = 0;
      lastCtrlKeydownAt = 0;
      lastScrollSnapshot = null;
      lastViewportScrollLogAt = 0;
      lastViewportScrollTop = null;
      lastViewportScrollMaxTop = null;
      lastBufferScrollLogAt = 0;
      lastBufferViewportY = null;
    }
  };
}
