// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import {
  createTerminalAdapter,
  type TerminalAdapterAPI,
  type TerminalCursorTextSnapshot,
  type TerminalScrollSnapshot,
} from '@/adapters/TerminalAdapter';
import { isWindowsLikeTerminal, type TerminalMode } from '@/lib/shell';
import {
  normalizeTerminalAppearance,
  type TerminalAppearance,
} from '@/lib/terminal-appearance';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildBracketedPastePayload,
  getPasteEnterDelayMs,
  getPasteSubmitMinWaitMs,
  isClaudeProvider,
  isGeminiProvider,
  stripTrailingNewlines,
  writeBracketedPaste,
} from '@/lib/terminal-send';

type TerminalSendScreenAckMatch = {
  matchedMarker: string;
  snapshot: TerminalCursorTextSnapshot;
};

type TerminalSendScreenAckProbe = {
  markers: string[];
  read: () => TerminalSendScreenAckMatch | null;
  readSnapshot: () => TerminalCursorTextSnapshot | null;
};

type GeminiPasteChunkPlan = {
  chunks: string[];
  ackText: string;
  dispatchDurationMs: number;
};

type GeminiExternalEditorKind = "windows" | "wsl";

type GeminiExternalEditorTransport = {
  kind: GeminiExternalEditorKind;
  writeSource: (args: { tabId: string; content: string }) => Promise<any>;
  readStatus: (args: { tabId: string }) => Promise<any>;
};

type TerminalSendOptions = {
  providerId?: string | null;
  terminalMode?: TerminalMode | null;
  projectWinRoot?: string;
  projectWslRoot?: string;
  projectName?: string;
  distro?: string;
  geminiWindowsEditorReady?: boolean;
  geminiWslEditorReady?: boolean;
};

const TERMINAL_SEND_SCREEN_ACK_POLL_MS = 40;
const TERMINAL_SEND_SCREEN_ACK_STABLE_POLLS = 2;
const CLAUDE_LARGE_PASTE_LINE_THRESHOLD = 5;
const CLAUDE_LARGE_PASTE_CHAR_THRESHOLD = 1000;
const CODEX_LARGE_PASTE_CHAR_THRESHOLD = 1000;
const CODEX_WINDOWS_FAST_SUBMIT_DELAY_MS = 32;
const GEMINI_LARGE_PASTE_LINE_THRESHOLD = 5;
const GEMINI_LARGE_PASTE_CHAR_THRESHOLD = 500;
const GEMINI_HUGE_PASTE_CHUNK_THRESHOLD = 900;
const GEMINI_HUGE_PASTE_CHUNK_SIZE = 128;
const GEMINI_HUGE_PASTE_CHUNK_MAX_LINES = 1;
const GEMINI_HUGE_PASTE_FINAL_CHUNK_SIZE = 80;
const GEMINI_HUGE_PASTE_CHUNK_DELAY_MS = 96;
const GEMINI_HUGE_PASTE_CHUNK_YIELD_EVERY = 4;
const GEMINI_HUGE_PASTE_CHUNK_YIELD_MS = 384;
const GEMINI_WINDOWS_EDITOR_STATUS_POLL_MS = 40;
const GEMINI_WINDOWS_EDITOR_STATUS_TIMEOUT_MS = 15000;
const GEMINI_WSL_EDITOR_TRIGGER_CHAR_THRESHOLD = 12000;
const GEMINI_WSL_EDITOR_TRIGGER_DISPATCH_THRESHOLD_MS = 2500;

/**
 * 渲染进程侧的 PTY 接口抽象，便于将 TerminalManager 从具体的 window.host.pty 解耦以实现复用。
 */
export interface HostPtyAPI {
  onData: (id: string, handler: (data: string) => void) => (() => void);
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
  close: (id: string) => void;
  // 可选：暂停/恢复数据流及清屏（与 ConPTY 同步）
  pause?: (id: string) => void;
  resume?: (id: string) => void;
  clear?: (id: string) => void;
  /** 中文说明：读取 PTY 的尾部输出缓存（用于渲染进程 reload/HMR 后恢复滚动区）。 */
  backlog?: (id: string, args?: { maxChars?: number }) => Promise<{ ok: boolean; data?: string; error?: string }>;
  onExit?: (handler: (payload: { id: string; exitCode?: number }) => void) => (() => void);
}

/**
 * TerminalManager 负责：
 * - 为每个 tab 创建并持有一个持久化的 DOM container（避免因 React 卸载而销毁 xterm 实例）
 * - 管理 TerminalAdapter 实例的创建、mount、dispose
 * - 负责将 PTY I/O 与对应 adapter 进行桥接（onData / onKey）
 *
 * 设计目标：将和具体 host/pty 实现解耦，便于在未来提取成独立包或在不同宿主上复用。
 */
export default class TerminalManager {
  // 调试辅助：统一配置
  private dbgEnabled(): boolean { try { return !!(globalThis as any).__cf_term_debug__; } catch { return false; } }
  private dlog(msg: string): void { if (this.dbgEnabled()) { try { (window as any).host?.utils?.perfLog?.(`[tm] ${msg}`); } catch {} } }
  private sendTraceSeq = 0;
  private adapters: Record<string, TerminalAdapterAPI | null> = {};
  private containers: Record<string, HTMLDivElement | null> = {};
  private scrollSnapshotByTab: Record<string, TerminalScrollSnapshot | null> = {};
  private unsubByTab: Record<string, (() => void) | null> = {};
  private inputUnsubByTab: Record<string, (() => void) | null> = {};
  private resizeUnsubByTab: Record<string, (() => void) | null> = {};
  private windowResizeCleanupByTab: Record<string, (() => void) | null> = {};
  private hostResizeObserverByTab: Record<string, ResizeObserver | null> = {};
  private lastSentSizeByTab: Record<string, { cols: number; rows: number } | undefined> = {};
  private pendingTimerByTab: Record<string, number | undefined> = {};
  private pendingSizeByTab: Record<string, { cols: number; rows: number } | undefined> = {};
  private isAnimatingByTab: Record<string, boolean> = {};
  private hostElByTab: Record<string, HTMLElement | null> = {};
  private backlogHydratedPtyByTab: Record<string, string | undefined> = {};
  private getPtyId: (tabId: string) => string | undefined;
  private hostPty: HostPtyAPI;
  private appearance: TerminalAppearance = normalizeTerminalAppearance();
  private lastFocusedTabId: string | null = null;

  /**
   * 中文说明：保存指定 tab 的滚动快照。
   * 设计目标：在标签页隐藏/切换后，能够恢复“滚动位置 + 滚动条指示”，避免出现内容在底部但滚动条回到顶部的错位。
   */
  private saveScrollSnapshot(tabId: string, source: string): void {
    const adapter = this.adapters[tabId];
    if (!adapter) return;
    try {
      const snapshot = adapter.getScrollSnapshot?.() ?? null;
      if (snapshot) {
        this.scrollSnapshotByTab[tabId] = snapshot;
        this.dlog(`scroll.save tab=${tabId} source=${source} y=${snapshot.viewportY}/${snapshot.baseY} bottom=${snapshot.isAtBottom ? '1' : '0'}`);
      }
    } catch {}
  }

  /**
   * 中文说明：恢复指定 tab 的滚动快照；若无快照，则执行一次“对齐修复”（以当前 buffer 视图为准）。
   */
  private restoreScrollSnapshot(tabId: string, source: string): void {
    const adapter = this.adapters[tabId];
    if (!adapter) return;
    const snapshot = this.scrollSnapshotByTab[tabId] ?? null;
    try {
      adapter.restoreScrollSnapshot?.(snapshot);
      this.dlog(`scroll.restore tab=${tabId} source=${source} has=${snapshot ? '1' : '0'}`);
    } catch {}
  }

  /**
   * 中文说明：判断当前发送是否需要输出强制诊断日志。
   * 说明：仅对已知有“长文本发送时序问题”的 Provider 开启，避免 perf.log 噪音过大。
   * @param providerId providerId
   * @returns 是否输出强制诊断日志
   */
  private shouldTraceSendDiagnostics(providerId?: string | null): boolean {
    const normalized = String(providerId || "").trim().toLowerCase();
    return normalized === "codex" || normalized === "gemini";
  }

  /**
   * 中文说明：为单次发送生成短 traceId，便于在 perf.log 中串起同一轮发送的关键时序。
   * @param providerId providerId
   * @returns 形如 `codex-mhxxxx-1` 的短 traceId
   */
  private nextSendTraceId(providerId?: string | null): string {
    this.sendTraceSeq += 1;
    const prefix = String(providerId || "unknown").trim().toLowerCase() || "unknown";
    return `${prefix}-${Date.now().toString(36)}-${this.sendTraceSeq.toString(36)}`;
  }

  /**
   * 中文说明：写入单次发送的强制诊断日志。
   * 说明：走 `perfLogCritical`，默认会写入 `perf.log`，无需依赖普通终端调试开关。
   * @param traceId 单次发送 traceId
   * @param message 诊断消息
   */
  private logSendDiagnostic(traceId: string | null | undefined, message: string): void {
    if (!traceId) return;
    try { (window as any).host?.utils?.perfLogCritical?.(`[tm.send ${traceId}] ${message}`); } catch {}
  }

  /**
   * 中文说明：统一规范化发送文本与屏幕快照文本，便于做稳定的局部匹配。
   * @param value 原始文本
   * @returns 统一为 LF 的文本
   */
  private normalizeSendProbeText(value: string): string {
    return String(value ?? "").replace(/\r\n?/g, "\n");
  }

  /**
   * 中文说明：折叠空白字符，降低软换行/重排对局部屏幕匹配的影响。
   * @param value 原始文本
   * @returns 折叠空白后的文本
   */
  private collapseSendProbeWhitespace(value: string): string {
    return this.normalizeSendProbeText(value).replace(/\s+/g, " ").trim();
  }

  /**
   * 中文说明：生成用于日志的局部屏幕快照预览，避免 perf.log 写入整段长文本。
   * @param snapshot 局部屏幕快照
   * @returns 折叠空白并截断后的尾部预览
   */
  private formatSendScreenAckSnapshotPreview(snapshot: TerminalCursorTextSnapshot | null | undefined): string {
    const collapsed = this.collapseSendProbeWhitespace(snapshot?.text || "");
    if (!collapsed) return "";
    return collapsed.slice(-Math.min(160, collapsed.length));
  }

  /**
   * 中文说明：为 Gemini 的超长文本构造分块粘贴计划，降低单次 paste 过大时 CLI 卡顿风险。
   * - 允许输入区逐步出现半截内容；
   * - 但提交键只会在最后一块稳定落到输入区后才发送。
   *
   * @param text 已规范化的待发送文本
   * @returns 分块计划；短文本时仅返回单块
   */
  private createGeminiPasteChunkPlan(text: string): GeminiPasteChunkPlan {
    const normalized = this.normalizeSendProbeText(text);
    const codePoints = Array.from(normalized);
    if (codePoints.length <= GEMINI_HUGE_PASTE_CHUNK_THRESHOLD) {
      return {
        chunks: [normalized],
        ackText: normalized,
        dispatchDurationMs: 0,
      };
    }

    const chunks: string[] = [];
    let currentChunk = "";
    let currentChars = 0;
    let currentLines = 1;
    for (const codePoint of codePoints) {
      const shouldSplitByChars = currentChars >= GEMINI_HUGE_PASTE_CHUNK_SIZE;
      const shouldSplitByLines = codePoint === "\n" && currentLines >= GEMINI_HUGE_PASTE_CHUNK_MAX_LINES;
      if (currentChunk && (shouldSplitByChars || shouldSplitByLines)) {
        chunks.push(currentChunk);
        currentChunk = "";
        currentChars = 0;
        currentLines = 1;
      }
      currentChunk += codePoint;
      currentChars += 1;
      if (codePoint === "\n") currentLines += 1;
    }
    if (currentChunk) chunks.push(currentChunk);

    const lastChunk = chunks[chunks.length - 1] || "";
    const lastChunkCodePoints = Array.from(lastChunk);
    if (chunks.length > 0 && lastChunkCodePoints.length > GEMINI_HUGE_PASTE_FINAL_CHUNK_SIZE) {
      const head = lastChunkCodePoints
        .slice(0, lastChunkCodePoints.length - GEMINI_HUGE_PASTE_FINAL_CHUNK_SIZE)
        .join("");
      const tail = lastChunkCodePoints
        .slice(lastChunkCodePoints.length - GEMINI_HUGE_PASTE_FINAL_CHUNK_SIZE)
        .join("");
      if (head) chunks[chunks.length - 1] = head;
      else chunks.pop();
      if (tail) chunks.push(tail);
    }

    const finalChunk = chunks[chunks.length - 1] || normalized;
    const gapCount = Math.max(0, chunks.length - 1);
    const yieldCount = Math.floor(gapCount / GEMINI_HUGE_PASTE_CHUNK_YIELD_EVERY);
    return {
      chunks,
      ackText: finalChunk || normalized,
      dispatchDurationMs: gapCount * GEMINI_HUGE_PASTE_CHUNK_DELAY_MS + yieldCount * GEMINI_HUGE_PASTE_CHUNK_YIELD_MS,
    };
  }

  /**
   * 中文说明：逐块发送 Gemini 文本，并按固定节奏平滑灌入后续 chunk。
   * 设计目标：
   * - 允许半截内容先显示在输入区；
   * - 避免忽快忽慢的 ACK/超时抖动；
   * - 也避免“塞太多、塞太快”把 Gemini CLI 卡死。
   *
   * @param chunks 待发送文本块
   * @param adapter 当前终端适配器
   * @param sendChunk 单块发送函数
   * @param traceId 单次发送 traceId
   */
  private dispatchGeminiPasteChunks(
    chunks: string[],
    _adapter: TerminalAdapterAPI | null,
    sendChunk: (chunk: string) => void,
    traceId?: string | null,
    onComplete?: () => void,
  ): void {
    const total = Math.max(0, chunks.length);
    if (total === 0) return;
    const dispatchAt = (index: number) => {
      const chunk = chunks[index] || "";
      if (!chunk) return;
      this.logSendDiagnostic(traceId, `trigger.chunk index=${index + 1}/${total} chars=${chunk.length}`);
      sendChunk(chunk);
      if (index + 1 >= total) {
        try { onComplete?.(); } catch {}
        return;
      }
      const dispatchedCount = index + 1;
      const needsYieldPause = dispatchedCount % GEMINI_HUGE_PASTE_CHUNK_YIELD_EVERY === 0;
      const delayMs = GEMINI_HUGE_PASTE_CHUNK_DELAY_MS + (needsYieldPause ? GEMINI_HUGE_PASTE_CHUNK_YIELD_MS : 0);
      this.logSendDiagnostic(
        traceId,
        `trigger.chunk.defer index=${index + 1}/${total} mode=steady delayMs=${delayMs} yield=${needsYieldPause ? 1 : 0}`
      );
      window.setTimeout(() => {
        dispatchAt(index + 1);
      }, delayMs);
    };
    dispatchAt(0);
  }

  /**
   * 中文说明：为 Gemini 的超长文本创建“单次 bracketed paste 会话”的流式写入器。
   *
   * 设计目标：
   * - 连续多次 `adapter.paste()` 会形成多次独立 paste 完成事件，目标 CLI 可能把中间某一段当成已完成输入；
   * - 这里改为只发送一次 `ESC[200~` 开始标记，正文分块持续灌入，最后再统一发送 `ESC[201~`；
   * - 这样在整段文本灌完前，Gemini 始终只会看到“同一次 paste 仍在进行中”，避免半路误发送。
   *
   * @param ptyId 当前 PTY id
   * @param traceId 单次发送 traceId
   * @returns 连续 paste 会话的正文写入器与收尾器
   */
  private createGeminiStreamedPasteWriter(
    ptyId: string,
    traceId?: string | null,
  ): { sendChunk: (chunk: string) => void; finish: () => void } {
    let started = false;
    let finished = false;
    const ensureStarted = () => {
      if (started) return;
      started = true;
      this.hostPty.write(ptyId, BRACKETED_PASTE_START);
      this.logSendDiagnostic(traceId, "trigger.mode=host.stream-start");
    };

    return {
      sendChunk: (chunk: string) => {
        if (!chunk) return;
        ensureStarted();
        this.hostPty.write(ptyId, chunk);
        this.logSendDiagnostic(traceId, `trigger.mode=host.stream-chunk chars=${chunk.length}`);
      },
      finish: () => {
        if (finished) return;
        finished = true;
        ensureStarted();
        this.hostPty.write(ptyId, BRACKETED_PASTE_END);
        this.logSendDiagnostic(traceId, "trigger.mode=host.stream-end");
      },
    };
  }

  /**
   * 中文说明：构造 Codex 大粘贴在输入区中显示的占位符文本。
   * @param text 已规范化的待发送文本
   * @returns 若会折叠为占位符，则返回占位符；否则返回 null
   */
  private buildCodexScreenAckMarker(text: string): string | null {
    const normalized = this.normalizeSendProbeText(text);
    const charCount = Array.from(normalized).length;
    if (charCount <= CODEX_LARGE_PASTE_CHAR_THRESHOLD) return null;
    return `[Pasted Content ${charCount} chars]`;
  }

  /**
   * 中文说明：构造 Gemini 大粘贴在输入区中显示的占位符文本。
   * @param text 已规范化的待发送文本
   * @returns 若会折叠为占位符，则返回占位符；否则返回 null
   */
  private buildGeminiScreenAckMarker(text: string): string | null {
    const normalized = this.normalizeSendProbeText(text);
    const lineCount = normalized.split("\n").length;
    if (lineCount > GEMINI_LARGE_PASTE_LINE_THRESHOLD) return `[Pasted Text: ${lineCount} lines]`;
    if (normalized.length > GEMINI_LARGE_PASTE_CHAR_THRESHOLD) return `[Pasted Text: ${normalized.length} chars]`;
    return null;
  }

  /**
   * 中文说明：为 Claude 的长文本粘贴构造局部屏幕 ACK 标记。
   * @param text 已规范化的待发送文本
   * @returns Claude 输入区可能出现的占位符或稳定后缀
   */
  private buildClaudeScreenAckMarkers(text: string): string[] {
    const normalized = this.normalizeSendProbeText(text);
    const markers: string[] = [];
    const pushMarker = (value: string | null | undefined) => {
      const marker = String(value || "").trim();
      if (!marker) return;
      if (!markers.includes(marker)) markers.push(marker);
    };
    const lineCount = normalized ? normalized.split("\n").length : 0;
    if (lineCount > CLAUDE_LARGE_PASTE_LINE_THRESHOLD) {
      const plusLineCount = Math.max(1, lineCount - 1);
      pushMarker(`[Pasted text #1 +${plusLineCount} lines]`);
      pushMarker(`[Pasted text #1 +${lineCount} lines]`);
      pushMarker(`+${plusLineCount} lines]`);
      pushMarker(`+${lineCount} lines]`);
      pushMarker("[Pasted text #");
      return markers;
    }
    if (normalized.length > CLAUDE_LARGE_PASTE_CHAR_THRESHOLD)
      pushMarker("[Pasted text #");
    return markers;
  }

  /**
   * 中文说明：为当前发送构造“局部屏幕 ACK”匹配标记。
   * @param providerId providerId
   * @param text 已规范化的待发送文本
   * @returns 匹配标记列表；为空表示不启用局部屏幕 ACK
   */
  private buildSendScreenAckMarkers(providerId: string | null | undefined, text: string): string[] {
    const normalized = this.normalizeSendProbeText(text);
    if (!normalized) return [];
    const markers: string[] = [];
    const pushMarker = (value: string | null | undefined) => {
      const marker = String(value || "").trim();
      if (!marker) return;
      if (!markers.includes(marker)) markers.push(marker);
    };

    const provider = String(providerId || "").trim().toLowerCase();
    const placeholderMarkers =
      provider === "codex"
        ? [this.buildCodexScreenAckMarker(normalized)]
        : provider === "gemini"
          ? [this.buildGeminiScreenAckMarker(normalized)]
          : provider === "claude"
            ? this.buildClaudeScreenAckMarkers(normalized)
            : [];
    placeholderMarkers.forEach((marker) => pushMarker(marker));

    const lines = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const lastLine = lines[lines.length - 1] || "";
    if (lastLine.length >= 8) pushMarker(lastLine.slice(-Math.min(96, lastLine.length)));
    if (lines.length >= 2) {
      const lastTwoLines = lines.slice(-2).join("\n");
      if (lastTwoLines.length >= 20) pushMarker(lastTwoLines.slice(-Math.min(160, lastTwoLines.length)));
    }

    const tail = normalized.trim();
    if (tail.length >= 24) pushMarker(tail.slice(-Math.min(160, tail.length)));

    return markers;
  }

  /**
   * 中文说明：创建单次发送的局部屏幕 ACK 探针。
   * @param adapter 当前终端适配器
   * @param providerId providerId
   * @param text 已规范化的待发送文本
   * @returns 可执行探针；若当前条件不适合启用，则返回 null
   */
  private createSendScreenAckProbe(
    adapter: TerminalAdapterAPI | null,
    providerId: string | null | undefined,
    text: string,
  ): TerminalSendScreenAckProbe | null {
    if (!adapter || typeof adapter.readCursorTextSnapshot !== "function") return null;
    const markers = this.buildSendScreenAckMarkers(providerId, text)
      .map((marker) => this.collapseSendProbeWhitespace(marker))
      .filter((marker) => marker.length > 0);
    if (markers.length === 0) return null;
    const readSnapshot = () => {
      return adapter.readCursorTextSnapshot?.({
        linesBefore: 2,
        linesAfter: 1,
        maxChars: 2048,
      }) ?? null;
    };

    return {
      markers,
      readSnapshot,
      read: () => {
        const snapshot = readSnapshot();
        if (!snapshot || !snapshot.text) return null;
        const haystack = this.collapseSendProbeWhitespace(snapshot.text);
        if (!haystack) return null;
        for (const marker of markers) {
          if (haystack.includes(marker)) return { matchedMarker: marker, snapshot };
        }
        return null;
      },
    };
  }

  /**
   * 中文说明：执行“发送文本 -> 等待 PTY 回显静默 -> 补发真实 Enter”的保守提交流程。
   *
   * 设计背景：
   * - 在某些终端/CLI 组合里，“前端已经把 paste 发出去”并不等于“目标 CLI 已完整接收并可提交”；
   * - 若可读取 xterm 光标附近的局部屏幕文本，则优先等待“输入区已出现目标占位符/尾部文本”的屏幕 ACK；
   * - 若拿不到屏幕 ACK，则退回到 PTY 回显静默与最终超时兜底；
   * - 可选的 provider 级额外延迟仍通过 `getPasteEnterDelayMs` 叠加，兼容 Gemini 这类防误触窗口。
   *
   * @param ptyId 当前标签页绑定的 PTY id
   * @param text 已规范化的待发送文本（不含尾随换行）
   * @param options 发送选项（包含发送触发器、屏幕 ACK、静默窗口与超时）
   */
  private sendTextAndEnterAfterPtyQuiet(
    ptyId: string,
    text: string,
    options: {
      allowQuietSubmit?: boolean;
      providerId?: string | null;
      echoQuietWindowMs?: number;
      hardTimeoutMs?: number;
      minWaitMs?: number;
      screenAckProbe?: TerminalSendScreenAckProbe | null;
      screenAckCanFinish?: (() => boolean) | null;
      traceId?: string | null;
      strategy?: string;
      terminalMode?: TerminalMode | null;
      triggerSend: (normalizedText: string) => void;
    }
  ): void {
    const allowQuietSubmit = options.allowQuietSubmit !== false;
    const enterDelayMs = getPasteEnterDelayMs(options.providerId);
    const echoQuietWindowMs = typeof options.echoQuietWindowMs === 'number' ? Math.max(16, Math.floor(options.echoQuietWindowMs)) : 32;
    const hardTimeoutMs = typeof options.hardTimeoutMs === 'number' ? Math.max(200, Math.floor(options.hardTimeoutMs)) : 1200;
    const minWaitMs = typeof options.minWaitMs === 'number' ? Math.max(0, Math.floor(options.minWaitMs)) : 0;
    const screenAckProbe = options.screenAckProbe ?? null;
    const screenAckCanFinish = options.screenAckCanFinish ?? null;
    const traceId = options.traceId ?? null;
    const strategy = String(options.strategy || "quiet-submit");
    const startedAt = Date.now();
    let idleTimer: number | undefined;
    let hardTimer: number | undefined;
    let gateTimer: number | undefined;
    let screenAckTimer: number | undefined;
    let done = false;
    let unsub: (() => void) | undefined;
    let dataEventCount = 0;
    let screenAckStableCount = 0;
    let lastScreenAckMarker = "";
    let lastScreenAckBlockedMarker = "";

    this.logSendDiagnostic(
      traceId,
      `start strategy=${strategy} provider=${String(options.providerId || "")} terminal=${String(options.terminalMode || "")} pty=${ptyId} chars=${text.length} minWaitMs=${minWaitMs} quietMs=${echoQuietWindowMs} hardMs=${hardTimeoutMs} enterDelayMs=${enterDelayMs} allowQuiet=${allowQuietSubmit ? 1 : 0} screenAck=${screenAckProbe ? 1 : 0} screenAckMarkers=${screenAckProbe?.markers.length || 0}`
    );

    const sendEnter = () => {
      this.logSendDiagnostic(traceId, `enter elapsedMs=${Math.max(0, Date.now() - startedAt)} dataEvents=${dataEventCount}`);
      try { this.hostPty.write(ptyId, "\r"); } catch {}
    };
    const clearTimers = () => {
      if (idleTimer) {
        try { window.clearTimeout(idleTimer); } catch {}
        idleTimer = undefined;
      }
      if (hardTimer) {
        try { window.clearTimeout(hardTimer); } catch {}
        hardTimer = undefined;
      }
      if (gateTimer) {
        try { window.clearTimeout(gateTimer); } catch {}
        gateTimer = undefined;
      }
      if (screenAckTimer) {
        try { window.clearInterval(screenAckTimer); } catch {}
        screenAckTimer = undefined;
      }
    };
    const finish = (reason: string) => {
      if (done) return;
      done = true;
      try { unsub?.(); } catch {}
      clearTimers();
       this.logSendDiagnostic(
        traceId,
        `finish reason=${reason} elapsedMs=${Math.max(0, Date.now() - startedAt)} dataEvents=${dataEventCount} enterDelayMs=${enterDelayMs}`
      );
      if (enterDelayMs > 0) {
        try { window.setTimeout(sendEnter, enterDelayMs); } catch { sendEnter(); }
        return;
      }
      sendEnter();
    };
    const attemptFinish = (reason: string) => {
      if (done) return;
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const remainMs = Math.max(0, minWaitMs - elapsedMs);
      if (remainMs <= 0) {
        finish(reason);
        return;
      }
      if (gateTimer) {
        try { window.clearTimeout(gateTimer); } catch {}
      }
      this.dlog(`submit.defer pty=${ptyId} reason=${reason} remain=${remainMs}`);
      this.logSendDiagnostic(traceId, `gate reason=${reason} elapsedMs=${elapsedMs} remainMs=${remainMs}`);
      gateTimer = window.setTimeout(() => {
        gateTimer = undefined;
        finish(`${reason}+minwait`);
      }, remainMs);
    };
    const scheduleIdle = () => {
      if (!allowQuietSubmit) return;
      if (idleTimer) {
        try { window.clearTimeout(idleTimer); } catch {}
      }
      if (gateTimer) {
        try { window.clearTimeout(gateTimer); } catch {}
        gateTimer = undefined;
      }
      idleTimer = window.setTimeout(() => {
        attemptFinish('quiet');
      }, echoQuietWindowMs);
    };
    const startScreenAckPolling = () => {
      if (!screenAckProbe) return;
      screenAckTimer = window.setInterval(() => {
        if (done) return;
        let match: TerminalSendScreenAckMatch | null = null;
        try {
          match = screenAckProbe.read() ?? null;
        } catch {}
        if (!match) {
          screenAckStableCount = 0;
          lastScreenAckMarker = "";
          lastScreenAckBlockedMarker = "";
          return;
        }
        if (match.matchedMarker !== lastScreenAckMarker) {
          lastScreenAckMarker = match.matchedMarker;
          screenAckStableCount = 1;
          lastScreenAckBlockedMarker = "";
          this.logSendDiagnostic(
            traceId,
            `screen-ack.hit elapsedMs=${Math.max(0, Date.now() - startedAt)} stable=${screenAckStableCount} buffer=${match.snapshot.bufferType} cursorAbsY=${match.snapshot.cursorAbsY} marker=${match.matchedMarker}`
          );
          return;
        }
        screenAckStableCount += 1;
        if (screenAckStableCount < TERMINAL_SEND_SCREEN_ACK_STABLE_POLLS) return;
        if (screenAckCanFinish && !screenAckCanFinish()) {
          if (lastScreenAckBlockedMarker !== match.matchedMarker) {
            lastScreenAckBlockedMarker = match.matchedMarker;
            this.logSendDiagnostic(
              traceId,
              `screen-ack.blocked elapsedMs=${Math.max(0, Date.now() - startedAt)} stable=${screenAckStableCount} marker=${match.matchedMarker} reason=await-dispatch`
            );
          }
          return;
        }
        lastScreenAckBlockedMarker = "";
        this.logSendDiagnostic(
          traceId,
          `screen-ack.ready elapsedMs=${Math.max(0, Date.now() - startedAt)} stable=${screenAckStableCount} buffer=${match.snapshot.bufferType} cursorAbsY=${match.snapshot.cursorAbsY} marker=${match.matchedMarker}`
        );
        attemptFinish('screen-ack');
      }, TERMINAL_SEND_SCREEN_ACK_POLL_MS);
    };

    unsub = this.hostPty.onData(ptyId, (data) => {
      if (!data) return;
      dataEventCount += 1;
      if (dataEventCount <= 3 || data.includes("[Pasted Content")) {
        this.logSendDiagnostic(
          traceId,
          `pty-data index=${dataEventCount} elapsedMs=${Math.max(0, Date.now() - startedAt)} len=${data.length} pastedMarker=${data.includes("[Pasted Content") ? 1 : 0}`
        );
      }
      scheduleIdle();
    });

    try {
      options.triggerSend(text);
      this.logSendDiagnostic(traceId, `trigger.sent elapsedMs=${Math.max(0, Date.now() - startedAt)}`);
      startScreenAckPolling();
    } catch {
      this.logSendDiagnostic(traceId, `trigger.error elapsedMs=${Math.max(0, Date.now() - startedAt)}`);
      try { unsub?.(); } catch {}
      clearTimers();
      return;
    }

    hardTimer = window.setTimeout(() => {
      if (screenAckProbe) {
        try {
          const snapshot = screenAckProbe.readSnapshot();
          const preview = this.formatSendScreenAckSnapshotPreview(snapshot);
          this.logSendDiagnostic(
            traceId,
            `screen-ack.timeout elapsedMs=${Math.max(0, Date.now() - startedAt)} preview=${preview || "<empty>"}`
          );
        } catch {}
      }
      attemptFinish('hard-timeout');
    }, hardTimeoutMs);
  }

  /**
   * 中文说明：Gemini 提交时，优先走 xterm paste 通道，再等待 PTY 回显稳定后补发真实 Enter。
   *
   * 设计背景：
   * - Gemini CLI 在“不可信终端”中，会把“paste 完成后 40ms 内”的 Enter 当作换行而非提交。
   * - 长文本通过 PTY 进入子进程时，真正被 Gemini CLI 完整接收并渲染到输入区，可能晚于我们开始写入的时刻。
   * - 因此优先通过 `adapter.paste()` 走更接近真实粘贴的链路，并等待输入区出现占位符或原文尾部等“局部屏幕 ACK”；若拿不到，再走超时兜底。
   *
   * @param ptyId 当前标签页绑定的 PTY id
   * @param text 已规范化的待发送文本（不含尾随换行）
   * @param adapter 当前 tab 绑定的终端适配器（用于读取局部屏幕 ACK）
   * @param providerId providerId（用于复用 provider 级延迟策略）
   */
  private async sendGeminiTextAndEnter(
    ptyId: string,
    text: string,
    adapter: TerminalAdapterAPI | null,
    options?: TerminalSendOptions,
    traceId?: string | null,
  ): Promise<void> {
    const chunkPlan = this.createGeminiPasteChunkPlan(text);
    const minWaitMs = getPasteSubmitMinWaitMs({ providerId: options?.providerId, textLength: text.length }) + chunkPlan.dispatchDurationMs;
    const screenAckProbe = this.createSendScreenAckProbe(adapter, options?.providerId, chunkPlan.ackText);
    const hardTimeoutMs = screenAckProbe ? Math.max(5000, minWaitMs + 3000) : Math.max(2200, minWaitMs);
    let screenAckCanFinish = chunkPlan.chunks.length <= 1;
    this.sendTextAndEnterAfterPtyQuiet(ptyId, text, {
      allowQuietSubmit: !screenAckProbe,
      providerId: options?.providerId,
      echoQuietWindowMs: 32,
      hardTimeoutMs,
      minWaitMs,
      screenAckProbe,
      screenAckCanFinish: screenAckProbe ? () => screenAckCanFinish : null,
      traceId,
      strategy: 'gemini-paste-quiet',
      terminalMode: options?.terminalMode,
      triggerSend: () => {
        if (chunkPlan.chunks.length > 1) {
          const streamWriter = this.createGeminiStreamedPasteWriter(ptyId, traceId);
          this.dispatchGeminiPasteChunks(chunkPlan.chunks, adapter, (chunk) => {
            streamWriter.sendChunk(chunk);
          }, traceId, () => {
            streamWriter.finish();
            screenAckCanFinish = true;
            this.logSendDiagnostic(traceId, `trigger.chunk.complete total=${chunkPlan.chunks.length}`);
          });
          return;
        }
        const sendChunk = (chunk: string) => {
          if (adapter && typeof (adapter as any).paste === 'function') {
            try {
              (adapter as any).paste(chunk);
              this.logSendDiagnostic(traceId, `trigger.mode=adapter.paste chars=${chunk.length}`);
              return;
            } catch {}
          }
          this.logSendDiagnostic(traceId, `trigger.mode=host.write chars=${chunk.length}`);
          this.hostPty.write(ptyId, buildBracketedPastePayload(chunk));
        };
        this.dispatchGeminiPasteChunks(chunkPlan.chunks, adapter, sendChunk, traceId, () => {
          screenAckCanFinish = true;
          this.logSendDiagnostic(traceId, `trigger.chunk.complete total=${chunkPlan.chunks.length}`);
        });
      },
    });
  }

  /**
   * 中文说明：Codex 在 Windows/PowerShell 短文本场景下，快速写入正文并在最小 settle 后提交。
   *
   * 设计背景：
   * - 短文本不需要等待局部屏幕 ACK；等待 ACK 失败时会退到数秒级 hard timeout，造成“短消息偶现几秒后才发送”；
   * - Codex TUI 的 Windows paste-burst 保护会在短窗口内把 Enter 当作正文换行，因此提交前仍复用 Codex 的最小等待时间；
   * - 多行短文本仍保留显式 bracketed paste，避免 PowerShell/ConPTY 将内嵌换行拆成多次提交；
   * - 单行短文本优先复用 xterm paste 通道，失败时再直接写入 PTY。
   *
   * @param ptyId 当前标签页绑定的 PTY id
   * @param text 已规范化的待发送文本（不含尾随换行）
   * @param adapter 当前 tab 绑定的终端适配器
   * @param terminalMode 当前终端类型
   * @param traceId 可选诊断 trace id
   */
  private sendCodexWindowsFastTextAndEnter(
    ptyId: string,
    text: string,
    adapter: TerminalAdapterAPI | null,
    terminalMode: TerminalMode,
    traceId?: string | null,
  ): void {
    const normalizedText = String(text ?? "");
    const submitDelayMs = Math.max(
      CODEX_WINDOWS_FAST_SUBMIT_DELAY_MS,
      getPasteSubmitMinWaitMs({ providerId: "codex", terminalMode, textLength: normalizedText.length }),
    );
    const sendEnter = () => {
      this.logSendDiagnostic(traceId, `fast.enter delayMs=${submitDelayMs}`);
      try { this.hostPty.write(ptyId, "\r"); } catch {}
    };
    const scheduleEnter = () => {
      try { window.setTimeout(sendEnter, submitDelayMs); } catch { sendEnter(); }
    };

    if (this.shouldForceCodexWindowsBracketedPaste("codex", terminalMode, normalizedText)) {
      this.logSendDiagnostic(traceId, `trigger.mode=host.bracketed.fast chars=${normalizedText.length}`);
      try { this.hostPty.write(ptyId, buildBracketedPastePayload(normalizedText)); } catch {}
      scheduleEnter();
      return;
    }

    if (adapter && typeof (adapter as any).paste === "function") {
      try {
        (adapter as any).paste(normalizedText);
        this.logSendDiagnostic(traceId, `trigger.mode=adapter.paste.fast chars=${normalizedText.length}`);
        scheduleEnter();
        return;
      } catch {}
    }

    this.logSendDiagnostic(traceId, `trigger.mode=host.write.fast chars=${normalizedText.length}`);
    try { this.hostPty.write(ptyId, normalizedText); } catch {}
    scheduleEnter();
  }

  /**
   * 中文说明：Codex 在 Windows/PowerShell 长文本场景下，使用“等待 PTY 回显静默后再回车”的保守提交策略。
   *
   * 设计背景：
   * - 仅监听 xterm 的 outbound 数据，只能说明“前端已把 paste 发出”，不能说明 Codex CLI 已真正消化完成；
   * - 长文本下，PowerShell / ConPTY 链路里常出现“paste 已发出但 CLI 尚未可提交”的时间差；
   * - 多行正文若退化为普通输入，内嵌换行可能被 CLI 提前当成独立提交，因此这里对多行正文强制发送显式 bracketed paste；
   * - 因此这里优先等待输入区出现 `[Pasted Content ...]` 等局部屏幕 ACK，再补 Enter；屏幕 ACK 缺失时再走超时兜底。
   *
   * @param ptyId 当前标签页绑定的 PTY id
   * @param text 已规范化的待发送文本（不含尾随换行）
   * @param adapter 当前 tab 绑定的终端适配器
   * @param terminalMode 当前终端类型
   */
  private sendCodexWindowsTextAndEnter(ptyId: string, text: string, adapter: TerminalAdapterAPI | null, terminalMode: TerminalMode, traceId?: string | null): void {
    const minWaitMs = getPasteSubmitMinWaitMs({ providerId: 'codex', terminalMode, textLength: text.length });
    const screenAckProbe = this.createSendScreenAckProbe(adapter, 'codex', text);
    const hardTimeoutMs = screenAckProbe ? Math.max(4500, minWaitMs + 2800) : Math.max(2200, minWaitMs);
    this.sendTextAndEnterAfterPtyQuiet(ptyId, text, {
      allowQuietSubmit: !screenAckProbe,
      providerId: 'codex',
      echoQuietWindowMs: 32,
      hardTimeoutMs,
      minWaitMs,
      screenAckProbe,
      traceId,
      strategy: 'codex-paste-quiet',
      terminalMode,
      triggerSend: (normalizedText) => {
        if (this.shouldForceCodexWindowsBracketedPaste('codex', terminalMode, normalizedText)) {
          this.logSendDiagnostic(traceId, `trigger.mode=host.bracketed chars=${normalizedText.length}`);
          this.hostPty.write(ptyId, buildBracketedPastePayload(normalizedText));
          return;
        }
        if (adapter && typeof (adapter as any).paste === 'function') {
          try {
            (adapter as any).paste(normalizedText);
            this.logSendDiagnostic(traceId, `trigger.mode=adapter.paste chars=${normalizedText.length}`);
            return;
          } catch {}
        }
        this.logSendDiagnostic(traceId, `trigger.mode=host.write chars=${normalizedText.length}`);
        this.hostPty.write(ptyId, normalizedText);
      },
    });
  }

  /**
   * 中文说明：Claude 在 Windows / PowerShell 长文本场景下，采用“等待 PTY 回显稳定后再回车”的保守提交策略。
   * 设计背景：
   * - Claude CLI 在长文本 paste 后，输入区常会先显示 `[Pasted text #... +... lines]` 占位符；
   * - 若 Enter 抢跑，CLI 可能仍停留在 paste 占位态，导致文本看似已注入但没有真正提交；
   * - 因此这里复用 PTY 静默 + 局部屏幕 ACK + 最终超时兜底的组合策略，避免 PowerShell / ConPTY 下的时序抢跑。
   *
   * @param ptyId 当前标签页绑定的 PTY id
   * @param text 已规范化的待发送文本（不含尾随换行）
   * @param adapter 当前 tab 绑定的终端适配器
   * @param terminalMode 当前终端类型
   * @param traceId 可选诊断 trace id
   */
  private sendClaudeWindowsTextAndEnter(ptyId: string, text: string, adapter: TerminalAdapterAPI | null, terminalMode: TerminalMode, traceId?: string | null): void {
    const minWaitMs = getPasteSubmitMinWaitMs({ providerId: "claude", terminalMode, textLength: text.length });
    const screenAckProbe = this.createSendScreenAckProbe(adapter, "claude", text);
    const hardTimeoutMs = screenAckProbe ? Math.max(5000, minWaitMs + 3000) : Math.max(2400, minWaitMs + 400);
    this.sendTextAndEnterAfterPtyQuiet(ptyId, text, {
      allowQuietSubmit: !screenAckProbe,
      providerId: "claude",
      echoQuietWindowMs: 32,
      hardTimeoutMs,
      minWaitMs,
      screenAckProbe,
      traceId,
      strategy: "claude-paste-quiet",
      terminalMode,
      triggerSend: (normalizedText) => {
        if (adapter && typeof (adapter as any).paste === "function") {
          try {
            (adapter as any).paste(normalizedText);
            this.logSendDiagnostic(traceId, `trigger.mode=adapter.paste chars=${normalizedText.length}`);
            return;
          } catch {}
        }
        this.logSendDiagnostic(traceId, `trigger.mode=host.write chars=${normalizedText.length}`);
        this.hostPty.write(ptyId, normalizedText);
      },
    });
  }

  /**
   * 中文说明：等待指定毫秒数，便于把“轮询状态/短暂 settle”等异步步骤统一封装。
   * @param ms 等待时长（毫秒）
   * @returns 等待完成的 Promise
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      try { window.setTimeout(resolve, Math.max(0, Math.floor(ms))); } catch { resolve(); }
    });
  }

  /**
   * 中文说明：根据当前运行环境返回 Gemini 外部编辑器桥接的读写通道。
   * @param kind 外部编辑器桥接类型
   * @param distro WSL 发行版名称（仅 WSL 需要）
   * @returns 已绑定参数的读写通道；不可用时返回空
   */
  private getGeminiExternalEditorTransport(
    kind: GeminiExternalEditorKind,
    distro?: string | null,
  ): GeminiExternalEditorTransport | null {
    const utils = (window as any).host?.utils;
    if (!utils)
      return null;
    if (kind === "windows") {
      if (
        typeof utils.writeGeminiWindowsEditorSource !== "function"
        || typeof utils.readGeminiWindowsEditorStatus !== "function"
      ) {
        return null;
      }
      return {
        kind,
        writeSource: async (args) => await utils.writeGeminiWindowsEditorSource(args),
        readStatus: async (args) => await utils.readGeminiWindowsEditorStatus(args),
      };
    }

    const normalizedDistro = String(distro || "").trim();
    if (
      !normalizedDistro
      || typeof utils.writeGeminiWslEditorSource !== "function"
      || typeof utils.readGeminiWslEditorStatus !== "function"
    ) {
      return null;
    }
    return {
      kind,
      writeSource: async (args) => await utils.writeGeminiWslEditorSource({ ...args, distro: normalizedDistro }),
      readStatus: async (args) => await utils.readGeminiWslEditorStatus({ ...args, distro: normalizedDistro }),
    };
  }

  /**
   * 中文说明：轮询 Gemini 外部编辑器的状态文件，直到命中当前 requestId 的 `done/error` 或超时。
   * @param transport 已绑定参数的桥接读写通道
   * @param tabId 标签页 id
   * @param requestId 本次发送 requestId
   * @param traceId 诊断 trace id
   * @returns 命中的状态；超时时返回 `timeout`
   */
  private async waitForGeminiExternalEditorStatus(
    transport: GeminiExternalEditorTransport,
    tabId: string,
    requestId: string,
    traceId?: string | null,
  ): Promise<{ state: "done" | "error" | "timeout"; message?: string }> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < GEMINI_WINDOWS_EDITOR_STATUS_TIMEOUT_MS) {
      try {
        const res = await transport.readStatus({ tabId });
        if (res && res.ok) {
          const status = res.status;
          const matchedRequestId = String(status?.requestId || "");
          const state = String(status?.state || "");
          const isMatchingResult = matchedRequestId === requestId && (state === "done" || state === "error");
          const isAnonymousError = !matchedRequestId && state === "error";
          if (isMatchingResult || isAnonymousError) {
            this.logSendDiagnostic(
              traceId,
              `gemini.editor.status kind=${transport.kind} state=${state} requestId=${requestId} elapsedMs=${Math.max(0, Date.now() - startedAt)} message=${String(status?.message || "")}`,
            );
            return {
              state: state as "done" | "error",
              message: String(status?.message || ""),
            };
          }
        }
      } catch (error: any) {
        this.logSendDiagnostic(traceId, `gemini.editor.status.read.error kind=${transport.kind} error=${String(error?.message || error)}`);
      }
      await this.sleep(GEMINI_WINDOWS_EDITOR_STATUS_POLL_MS);
    }

    this.logSendDiagnostic(
      traceId,
      `gemini.editor.status timeout kind=${transport.kind} requestId=${requestId} timeoutMs=${GEMINI_WINDOWS_EDITOR_STATUS_TIMEOUT_MS}`,
    );
    return { state: "timeout" };
  }

  /**
   * 中文说明：Gemini 通过 `Ctrl+X + 外部编辑器` 发送正文。
   * - Windows 下用于彻底绕开 PowerShell/ConPTY 的超长 paste 链路；
   * - WSL 下仅在超长文本命中阈值时启用，用于降低超大分块 paste 的等待成本；
   * - 失败时统一自动回退到当前的 paste 策略。
   *
   * @param transport 已绑定参数的桥接读写通道
   * @param tabId 标签页 id
   * @param ptyId 当前 PTY id
   * @param text 待发送文本
   * @param adapter 当前 tab 终端适配器
   * @param options 发送上下文
   * @param traceId 诊断 trace id
   * @returns 是否已接管本次发送
   */
  private sendGeminiExternalEditorTextAndEnter(
    transport: GeminiExternalEditorTransport,
    tabId: string,
    ptyId: string,
    text: string,
    adapter: TerminalAdapterAPI | null,
    options?: TerminalSendOptions,
    traceId?: string | null,
  ): boolean {
    void (async () => {
      try {
        const writeRes = await transport.writeSource({ tabId, content: text });
        if (!writeRes || !writeRes.ok || !writeRes.requestId) {
          this.logSendDiagnostic(
            traceId,
            `gemini.editor.writeSource.failed kind=${transport.kind} error=${String(writeRes?.error || "unknown")}`,
          );
          await this.sendGeminiTextAndEnter(ptyId, text, adapter, options, traceId);
          return;
        }

        const requestId = String(writeRes.requestId);
        this.logSendDiagnostic(
          traceId,
          `gemini.editor.writeSource.ok kind=${transport.kind} requestId=${requestId} chars=${text.length}`,
        );

        try {
          this.hostPty.write(ptyId, "\x18");
          this.logSendDiagnostic(traceId, `trigger.mode=host.write ctrlX=1 kind=${transport.kind}`);
        } catch (error: any) {
          this.logSendDiagnostic(
            traceId,
            `gemini.editor.ctrlX.failed kind=${transport.kind} error=${String(error?.message || error)}`,
          );
          await this.sendGeminiTextAndEnter(ptyId, text, adapter, options, traceId);
          return;
        }

        const status = await this.waitForGeminiExternalEditorStatus(transport, tabId, requestId, traceId);
        if (status.state === "error") {
          this.logSendDiagnostic(
            traceId,
            `gemini.editor.helper.error kind=${transport.kind} message=${String(status.message || "")}`,
          );
          await this.sendGeminiTextAndEnter(ptyId, text, adapter, options, traceId);
          return;
        }
        if (status.state !== "done")
          return;

        const settleMs = Math.max(16, getPasteEnterDelayMs(options?.providerId));
        await this.sleep(settleMs);
        try {
          this.hostPty.write(ptyId, "\r");
          this.logSendDiagnostic(traceId, `gemini.editor.enter kind=${transport.kind} settleMs=${settleMs}`);
        } catch (error: any) {
          this.logSendDiagnostic(
            traceId,
            `gemini.editor.enter.failed kind=${transport.kind} error=${String(error?.message || error)}`,
          );
        }
      } catch (error: any) {
        this.logSendDiagnostic(
          traceId,
          `gemini.editor.unhandled kind=${transport.kind} error=${String(error?.message || error)}`,
        );
        await this.sendGeminiTextAndEnter(ptyId, text, adapter, options, traceId);
      }
    })();

    return true;
  }

  /**
   * 中文说明：Gemini 在 Windows/Pwsh 下使用外部编辑器桥接发送正文。
   * @param tabId 标签页 id
   * @param ptyId 当前 PTY id
   * @param text 待发送文本
   * @param adapter 当前 tab 终端适配器
   * @param options 发送上下文
   * @param traceId 诊断 trace id
   * @returns 是否已接管本次发送
   */
  private sendGeminiWindowsTextAndEnter(
    tabId: string,
    ptyId: string,
    text: string,
    adapter: TerminalAdapterAPI | null,
    options?: TerminalSendOptions,
    traceId?: string | null,
  ): boolean {
    const transport = this.getGeminiExternalEditorTransport("windows");
    if (!transport)
      return false;
    return this.sendGeminiExternalEditorTextAndEnter(transport, tabId, ptyId, text, adapter, options, traceId);
  }

  /**
   * 中文说明：Gemini 在 WSL 超长文本场景下使用外部编辑器桥接发送正文。
   * @param tabId 标签页 id
   * @param ptyId 当前 PTY id
   * @param text 待发送文本
   * @param adapter 当前 tab 终端适配器
   * @param options 发送上下文
   * @param traceId 诊断 trace id
   * @returns 是否已接管本次发送
   */
  private sendGeminiWslTextAndEnter(
    tabId: string,
    ptyId: string,
    text: string,
    adapter: TerminalAdapterAPI | null,
    options?: TerminalSendOptions,
    traceId?: string | null,
  ): boolean {
    const transport = this.getGeminiExternalEditorTransport("wsl", options?.distro);
    if (!transport)
      return false;
    return this.sendGeminiExternalEditorTextAndEnter(transport, tabId, ptyId, text, adapter, options, traceId);
  }

  /**
   * 中文说明：判断当前发送是否应启用 Codex Windows 的保守提交策略。
   * @param providerId providerId
   * @param terminalMode 当前标签页运行终端类型
   * @returns 是否启用“等待 PTY 回显静默后再回车”
   */
  private shouldUseCodexWindowsSubmitStrategy(providerId?: string | null, terminalMode?: TerminalMode | null): boolean {
    return String(providerId || '').trim().toLowerCase() === 'codex'
      && !!terminalMode
      && isWindowsLikeTerminal(terminalMode);
  }

  /**
   * 中文说明：判断 Codex Windows 当前文本是否需要启用屏幕 ACK/静默等待的保守提交策略。
   * 设计目标：多行文本和大文本都可能触发 Codex 的 paste-burst 保护，需等待输入区稳定后再提交。
   * @param providerId providerId
   * @param terminalMode 当前标签页运行终端类型
   * @param text 待发送正文
   * @returns 是否启用保守提交策略
   */
  private shouldUseCodexWindowsQuietSubmitStrategy(providerId?: string | null, terminalMode?: TerminalMode | null, text?: string): boolean {
    if (!this.shouldUseCodexWindowsSubmitStrategy(providerId, terminalMode))
      return false;
    const normalized = this.normalizeSendProbeText(text || "");
    const lineCount = normalized ? normalized.split("\n").length : 0;
    const charCount = Array.from(normalized).length;
    return lineCount > 1 || charCount > CODEX_LARGE_PASTE_CHAR_THRESHOLD;
  }

  /**
   * 中文说明：判断 Codex 在 Windows 终端下是否需要强制走显式 bracketed paste。
   * 设计目标：统一覆盖“发送并回车”与“仅写入正文”两条链路，避免多行正文退化成普通输入后被拆成多条消息。
   * @param providerId providerId
   * @param terminalMode 当前标签页运行终端类型
   * @param text 待发送正文
   * @returns 是否强制走显式 bracketed paste
   */
  private shouldForceCodexWindowsBracketedPaste(
    providerId?: string | null,
    terminalMode?: TerminalMode | null,
    text?: string,
  ): boolean {
    return this.shouldUseCodexWindowsSubmitStrategy(providerId, terminalMode)
      && /[\r\n]/.test(String(text ?? ""));
  }

  /**
   * 中文说明：判断 Claude 在 Windows / PowerShell 下是否需要启用保守提交策略。
   * @param providerId providerId
   * @param terminalMode 当前标签页运行终端类型
   * @param text 待发送正文
   * @returns 是否启用“等待 PTY 回显稳定后再回车”
   */
  private shouldUseClaudeWindowsSubmitStrategy(providerId?: string | null, terminalMode?: TerminalMode | null, text?: string): boolean {
    if (!isClaudeProvider(providerId) || !terminalMode || !isWindowsLikeTerminal(terminalMode))
      return false;
    const normalized = this.normalizeSendProbeText(text || "");
    const lineCount = normalized ? normalized.split("\n").length : 0;
    return lineCount > CLAUDE_LARGE_PASTE_LINE_THRESHOLD || normalized.length > CLAUDE_LARGE_PASTE_CHAR_THRESHOLD;
  }

  /**
   * 中文说明：判断当前 Gemini 发送是否应启用 Windows 外部编辑器策略。
   * @param providerId providerId
   * @param terminalMode 当前标签页运行终端类型
   * @param geminiWindowsEditorReady 当前 tab 是否已成功注入专用 `EDITOR/VISUAL`
   * @returns 是否启用 `Ctrl+X + 外部编辑器` 发送
   */
  private shouldUseGeminiWindowsEditorStrategy(
    providerId?: string | null,
    terminalMode?: TerminalMode | null,
    geminiWindowsEditorReady?: boolean,
  ): boolean {
    return isGeminiProvider(providerId)
      && !!terminalMode
      && isWindowsLikeTerminal(terminalMode)
      && geminiWindowsEditorReady === true;
  }

  /**
   * 中文说明：判断当前 Gemini 发送是否应启用 WSL 外部编辑器策略。
   * - 仅在 WSL 下命中超长文本阈值时启用，避免影响普通短文本发送。
   *
   * @param providerId providerId
   * @param terminalMode 当前标签页运行终端类型
   * @param geminiWslEditorReady 当前 tab 是否已成功注入专用 `EDITOR/VISUAL`
   * @param text 待发送正文
   * @returns 是否启用 `Ctrl+X + 外部编辑器` 发送
   */
  private shouldUseGeminiWslEditorStrategy(
    providerId?: string | null,
    terminalMode?: TerminalMode | null,
    geminiWslEditorReady?: boolean,
    text?: string,
  ): boolean {
    if (
      !isGeminiProvider(providerId)
      || terminalMode !== "wsl"
      || geminiWslEditorReady !== true
    ) {
      return false;
    }

    const normalizedText = String(text || "");
    if (normalizedText.length >= GEMINI_WSL_EDITOR_TRIGGER_CHAR_THRESHOLD)
      return true;

    const chunkPlan = this.createGeminiPasteChunkPlan(normalizedText);
    return chunkPlan.dispatchDurationMs >= GEMINI_WSL_EDITOR_TRIGGER_DISPATCH_THRESHOLD_MS;
  }

  /**
   * 构造函数
   * @param getPtyId - 回调，用于根据 tabId 查询当前绑定的 PTY id（由上层 state 驱动）
   * @param hostPty - 实现 PTY I/O 的宿主接口（默认为 window.host.pty）
   */
  constructor(
    getPtyId?: (tabId: string) => string | undefined,
    hostPty?: HostPtyAPI,
    appearance?: Partial<TerminalAppearance>
  ) {
    this.getPtyId = getPtyId || (() => undefined);
    // 若未提供 hostPty，则回退到全局 window.host.pty（兼容当前代码库）
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    this.hostPty = hostPty || (window as any).host?.pty as HostPtyAPI;
    this.appearance = normalizeTerminalAppearance(appearance);
  }

  /**
   * 判断宿主元素是否处于不可下发阶段：隐藏、尺寸为 0、正在动画、或窗口不可见
   */
  private isHostInactive(tabId: string): boolean {
    const hostEl = this.hostElByTab[tabId];
    const docHidden = typeof document !== 'undefined' ? document.hidden : false;
    if (!hostEl) return docHidden; // 若无宿主，仅依据文档可见性
    try {
      const rect = hostEl.getBoundingClientRect();
      const style = window.getComputedStyle(hostEl);
      const zero = rect.width === 0 || rect.height === 0;
      // 注意：不再将 opacity:0 视为隐藏，因为布局尺寸已稳定且可参与度量
      const hidden = style.display === 'none' || style.visibility === 'hidden';
      const inactive = docHidden || zero || hidden;
      if (this.dbgEnabled()) {
        try { (window as any).host?.utils?.perfLog?.(`[tm] isHostInactive=${inactive} zero=${zero} hidden=${hidden} docHidden=${docHidden} rect=${Math.round(rect.width)}x${Math.round(rect.height)} disp=${style.display} vis=${style.visibility} op=${style.opacity}`); } catch {}
      }
      return inactive;
    } catch {
      return docHidden;
    }
  }

  /**
   * 根据阈值与去重判断是否需要向 PTY 下发 resize。
   * 规则：Δrows≥1 或 Δcols≥2；并忽略与上次下发相同的值。
   */
  private shouldSendResize(tabId: string, size: { cols: number; rows: number }, force = false): boolean {
    if (!size || !size.cols || !size.rows) return false;
    const last = this.lastSentSizeByTab[tabId];
    if (!last) { this.dlog(`shouldSendResize noLast -> true size=${size.cols}x${size.rows}`); return true; }
    const dCols = Math.abs(size.cols - last.cols);
    const dRows = Math.abs(size.rows - last.rows);
    if (dCols === 0 && dRows === 0) { this.dlog(`shouldSendResize same(${last.cols}x${last.rows}) -> false force=${force}`); return false; } // 完全重复
    // force 模式：用在 mouseup/transitionend/visibilitychange 或防抖“尾触发”，确保最终与 PTY 完全一致
    if (force) { const ok = dRows >= 1 || dCols >= 1; this.dlog(`shouldSendResize force dCols=${dCols} dRows=${dRows} -> ${ok}`); return ok; }
    const ok = dRows >= 1 || dCols >= 2;
    this.dlog(`shouldSendResize dCols=${dCols} dRows=${dRows} last=${last.cols}x${last.rows} now=${size.cols}x${size.rows} -> ${ok}`);
    return ok;
  }

  /**
   * 清理某 tab 的 pending 定时器
   */
  private clearPendingTimer(tabId: string): void {
    const t = this.pendingTimerByTab[tabId];
    if (typeof t === 'number') {
      try { clearTimeout(t); } catch {}
    }
    this.pendingTimerByTab[tabId] = undefined;
  }

  /**
   * 立即尝试下发尺寸（若可下发）。
   * 与 ConPTY 做最小握手：暂停数据 -> 前端 fit -> 发送 resize -> 下一帧恢复。
   */
  private flushResizeIfNeeded(tabId: string, force = false): void {
    const adapter = this.adapters[tabId];
    if (!adapter) return;
    const ptyId = this.getPtyId(tabId);
    if (!ptyId) return;

    // 1) 暂停数据，避免旧尺寸数据在重排期间灌入 UI
    try { this.hostPty.pause?.(ptyId); this.dlog(`pause pty=${ptyId} tab=${tabId}`); } catch {}

    // 2) 记录宿主与父容器尺寸，并在 0/隐藏 时直接恢复退出（避免 11x6 抖动）
    try {
      const host = this.hostElByTab[tabId];
      if (host) {
        const r = host.getBoundingClientRect();
        const pr = host.parentElement ? host.parentElement.getBoundingClientRect() : null;
        this.dlog(`hostRect tab=${tabId} host=${Math.round(r.width)}x${Math.round(r.height)} parent=${pr ? `${Math.round(pr.width)}x${Math.round(pr.height)}` : 'n/a'}`);
        const style = window.getComputedStyle(host);
        const hidden = style.display === 'none' || style.visibility === 'hidden';
        if (hidden || r.height <= 1 || r.width <= 1) {
          this.dlog(`flush.skip tab=${tabId} hidden=${hidden} rect=${Math.round(r.width)}x${Math.round(r.height)}`);
          try { this.hostPty.resume?.(ptyId); } catch {}
          return;
        }
      }
    } catch {}
    // 2b) 前端先精确 fit（内部可能 pin 整数行），拿到当前网格
    let measured: { cols: number; rows: number } | undefined;
    try {
      measured = adapter.resize();
    } catch {
      // 防御：度量异常时确保恢复数据流，避免 PTY 长时间处于暂停状态
      try { this.hostPty.resume?.(ptyId); } catch {}
      return;
    }
    this.dlog(`measure tab=${tabId} size=${measured?.cols || 0}x${measured?.rows || 0} force=${force}`);
    if (!measured || !measured.cols || !measured.rows) { try { this.hostPty.resume?.(ptyId); } catch {} return; }
    // 记录最新一次测量，供后续判重
    this.pendingSizeByTab[tabId] = measured;

    // 若处于不可下发阶段，则不调用 PTY，等待后续 flush 时机
    if (this.isHostInactive(tabId)) { this.dlog(`hostInactive tab=${tabId}`); try { this.hostPty.resume?.(ptyId); } catch {}; return; }

    if (!this.shouldSendResize(tabId, measured, force)) { this.dlog(`skipResize tab=${tabId}`); try { this.hostPty.resume?.(ptyId); } catch {}; return; }
    try {
      this.hostPty.resize(ptyId, measured.cols, measured.rows);
      this.dlog(`resize->pty tab=${tabId} ${measured.cols}x${measured.rows}`);
      this.lastSentSizeByTab[tabId] = measured;
    } catch {
      // 即便失败也尝试恢复
    } finally {
      // 4) 让布局/ConPTY 重绘落地后再恢复
      try {
        requestAnimationFrame(() => { try { this.hostPty.resume?.(ptyId); this.dlog(`resume pty=${ptyId}`); } catch {} });
      } catch { try { this.hostPty.resume?.(ptyId); this.dlog(`resume pty=${ptyId}`); } catch {} }

      // 5) 尾帧校验：下一帧再次测量，如行列仍有差异，再下发一次 resize，确保最终一致
      try {
        requestAnimationFrame(() => {
          try {
            const again = adapter.resize();
            this.dlog(`tail-measure tab=${tabId} size=${again?.cols || 0}x${again?.rows || 0}`);
            if (again && again.cols && again.rows && this.shouldSendResize(tabId, again, true)) {
              this.hostPty.resize(ptyId, again.cols, again.rows);
              this.dlog(`tail-resize->pty tab=${tabId} ${again.cols}x${again.rows}`);
              this.lastSentSizeByTab[tabId] = again;
            }
          } catch {}
        });
      } catch {}
    }
  }

  private blurTab(tabId: string, reason: string): void {
    const adapter = this.adapters[tabId];
    if (!adapter) return;
    if (typeof adapter.blur === "function") {
      try {
        adapter.blur();
        this.dlog(`tabBlur tab=${tabId} reason=${reason}`);
        const pid = this.getPtyId(tabId);
        if (pid) {
          try {
            this.hostPty.write(pid, "\u001b[O");
            this.dlog(`tabBlur.injectFocusLost tab=${tabId} pty=${pid}`);
          } catch (err) {
            this.dlog(`tabBlur.injectFocusLost.error tab=${tabId} pty=${pid} err=${(err as Error)?.message || err}`);
          }
        }
      } catch (err) {
        this.dlog(`tabBlur.error tab=${tabId} reason=${reason} err=${(err as Error)?.message || err}`);
      }
    } else {
      this.dlog(`tabBlur.skip tab=${tabId} reason=${reason}`);
    }
  }

  /**
   * 调度一次 resize 同步：
   * - immediate=true: 立刻尝试 flush。
   * - immediate=false: 150ms 防抖后 flush。
   * 始终会优先更新前端画布（adapter.resize）。
   */
  private scheduleResizeSync(tabId: string, immediate: boolean): void {
    const adapter = this.adapters[tabId];
    if (!adapter) return;
    // 先判断宿主是否可测量；若为 0 或隐藏，则跳过本轮（避免 11x6 抖动）
    try {
      const host = this.hostElByTab[tabId];
      if (host) {
        const rect = host.getBoundingClientRect();
        const style = window.getComputedStyle(host);
        const hidden = style.display === 'none' || style.visibility === 'hidden';
        if (hidden || rect.height <= 1 || rect.width <= 1) {
          this.dlog(`schedule.skip tab=${tabId} hidden=${hidden} rect=${Math.round(rect.width)}x${Math.round(rect.height)}`);
          return;
        }
      }
    } catch {}
    // 可测量时，更新画布并记录测量
    try {
      const s = adapter.resize();
      if (s && s.cols && s.rows) { this.pendingSizeByTab[tabId] = s; this.dlog(`schedule(${immediate ? 'immediate' : 'debounce'}) tab=${tabId} measure=${s.cols}x${s.rows}`); }
    } catch {}

    if (immediate) {
      this.clearPendingTimer(tabId);
      this.flushResizeIfNeeded(tabId, true);
      return;
    }

    this.clearPendingTimer(tabId);
    this.pendingTimerByTab[tabId] = window.setTimeout(() => {
      // 尾触发一次“精确同步”，避免最终只有 1 列/1 行差异时前后端网格不一致
      this.flushResizeIfNeeded(tabId, true);
    }, 150);
  }

  /**
   * 安装宿主元素相关事件：动画开始/结束、可见性变化、拖动结束等，用于暂停/恢复下发与即时 flush。
   */
  private installHostEventHandlers(tabId: string, hostEl: HTMLElement): () => void {
    const onUp = () => { try { this.scheduleResizeSync(tabId, true); } catch {} };
    const onVisibility = () => { if (!document.hidden) { try { this.scheduleResizeSync(tabId, true); } catch {} } };
    const onAnimStart = () => { this.isAnimatingByTab[tabId] = true; };
    const onAnimEnd = () => { this.isAnimatingByTab[tabId] = false; try { this.scheduleResizeSync(tabId, true); } catch {} };

    window.addEventListener('mouseup', onUp);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('touchend', onUp);
    document.addEventListener('visibilitychange', onVisibility);
    hostEl.addEventListener('transitionstart', onAnimStart);
    hostEl.addEventListener('transitionrun', onAnimStart);
    hostEl.addEventListener('transitionend', onAnimEnd);
    hostEl.addEventListener('animationstart', onAnimStart);
    hostEl.addEventListener('animationend', onAnimEnd);

    // 返回卸载函数
    return () => {
      try { window.removeEventListener('mouseup', onUp); } catch {}
      try { window.removeEventListener('pointerup', onUp); } catch {}
      try { window.removeEventListener('touchend', onUp); } catch {}
      try { document.removeEventListener('visibilitychange', onVisibility); } catch {}
      try { hostEl.removeEventListener('transitionstart', onAnimStart); } catch {}
      try { hostEl.removeEventListener('transitionrun', onAnimStart); } catch {}
      try { hostEl.removeEventListener('transitionend', onAnimEnd); } catch {}
      try { hostEl.removeEventListener('animationstart', onAnimStart); } catch {}
      try { hostEl.removeEventListener('animationend', onAnimEnd); } catch {}
    };
  }

  /**
   * 确保存在用于 tab 的持久化容器，并在容器上 mount xterm adapter
   * 返回该持久容器以便上层将其 append 到可见 host element
   */
  ensurePersistentContainer(tabId: string, options?: { skipAutoWireUp?: boolean }): HTMLDivElement {
    let container = this.containers[tabId];
    if (!container) {
      container = document.createElement('div');
      container.style.height = '100%';
      container.style.width = '100%';
      container.style.boxSizing = 'border-box';
      // 终端宿主不应产生滚动条，否则会干扰 xterm 内部滚动度量
      container.style.overflow = 'hidden';
      this.containers[tabId] = container;

      // create adapter and mount into persistent container
      let adapter = this.adapters[tabId];
      if (!adapter) {
        adapter = createTerminalAdapter({ appearance: this.appearance });
        this.adapters[tabId] = adapter;
      }
      try { adapter.setAppearance(this.appearance); } catch {}
      try { adapter.mount(container); } catch (err) { console.warn('adapter.mount failed', err); }

      // If PTY already exists for this tab, wire up bridges
      const pid = this.getPtyId(tabId);
      if (pid && !options?.skipAutoWireUp) this.wireUp(tabId, pid);
    }

    if (!this.windowResizeCleanupByTab[tabId]) {
      const onResize = () => {
        try { this.scheduleResizeSync(tabId, false); } catch {}
      };
      window.addEventListener('resize', onResize);
      this.windowResizeCleanupByTab[tabId] = () => {
        try { window.removeEventListener('resize', onResize); } catch {}
      };
    }

    const ensured = this.containers[tabId];
    return ensured!;
  }

  setAppearance(appearance: Partial<TerminalAppearance>): void {
    const next = normalizeTerminalAppearance(appearance, this.appearance);
    const fontChanged = next.fontFamily !== this.appearance.fontFamily;
    const themeChanged = next.theme !== this.appearance.theme;
    if (!fontChanged && !themeChanged) return;
    this.appearance = next;
    for (const [tabId, adapter] of Object.entries(this.adapters)) {
      if (!adapter) continue;
      try { adapter.setAppearance(next); } catch {}
      if (fontChanged) {
        try { this.scheduleResizeSync(tabId, true); } catch {}
      }
    }
  }

  /**
   * 将指定 tab 的 PTY 与 adapter 做双向绑定：主进程 onData -> adapter.write，adapter.onData -> 主进程 write
   */
  private wireUp(tabId: string, ptyId: string, options?: { skipInitialResize?: boolean }): void {
    this.dlog(`wireUp tab=${tabId} pty=${ptyId}`);
    const adapter = this.adapters[tabId];
    if (!adapter) return;
    try { this.unsubByTab[tabId]?.(); } catch {}
    try { this.inputUnsubByTab[tabId]?.(); } catch {}
    this.unsubByTab[tabId] = this.hostPty.onData(ptyId, (data) => adapter!.write(data));
    this.inputUnsubByTab[tabId] = adapter.onData((data) => this.hostPty.write(ptyId, data));
    // 首次绑定后立即同步一次（走统一的去重/阈值/防抖逻辑，立即 flush）
    if (!options?.skipInitialResize) {
      try { this.scheduleResizeSync(tabId, true); } catch {}
    }
  }

  /**
   * 发送一段文本到指定 tab 对应的终端：
   * - 优先走 xterm 的 paste 通道（若可用，可触发 bracketed paste，避免应用层对逐字输入做清洗）。
   * - Codex 在 Windows/PowerShell 下发送多行正文时，会强制改走显式 bracketed paste，避免退化为普通输入后被拆成多条消息。
   * - 若 adapter 不存在或 paste 不可用，则回退为直接写入 PTY。
   * - `sendText()` 仅负责“写入正文”，不会走 Gemini 外部编辑器提交链路；该链路只在 `sendTextAndEnter()` 中启用。
   */
  async sendText(tabId: string, text: string, options?: TerminalSendOptions): Promise<void> {
    const adapter = this.adapters[tabId];
    const ptyId = this.getPtyId(tabId);
    const traceId = this.shouldTraceSendDiagnostics(options?.providerId) ? this.nextSendTraceId(options?.providerId) : null;
    if (ptyId && isGeminiProvider(options?.providerId)) {
      const chunkPlan = this.createGeminiPasteChunkPlan(String(text ?? ""));
      if (chunkPlan.chunks.length > 1) {
        const streamWriter = this.createGeminiStreamedPasteWriter(ptyId, traceId);
        this.dispatchGeminiPasteChunks(chunkPlan.chunks, adapter, (chunk) => {
          streamWriter.sendChunk(chunk);
        }, traceId, () => {
          streamWriter.finish();
        });
        return;
      }
      this.dispatchGeminiPasteChunks(chunkPlan.chunks, adapter, (chunk) => {
        if (adapter && typeof (adapter as any).paste === 'function') {
          try {
            (adapter as any).paste(chunk);
            this.logSendDiagnostic(traceId, `trigger.mode=adapter.paste chars=${chunk.length}`);
            return;
          } catch {}
        }
        this.logSendDiagnostic(traceId, `trigger.mode=host.write chars=${chunk.length}`);
        writeBracketedPaste((data) => this.hostPty.write(ptyId, data), chunk);
      }, traceId);
      return;
    }
    if (ptyId && this.shouldForceCodexWindowsBracketedPaste(options?.providerId, options?.terminalMode, text)) {
      const normalizedText = String(text ?? "");
      this.logSendDiagnostic(traceId, `trigger.mode=host.bracketed chars=${normalizedText.length}`);
      this.hostPty.write(ptyId, buildBracketedPastePayload(normalizedText));
      return;
    }
    if (adapter && typeof (adapter as any).paste === 'function') {
      try { (adapter as any).paste(String(text ?? "")); return; } catch { /* 回退 */ }
    }
    if (ptyId) {
      try { this.hostPty.write(ptyId, String(text ?? "")); } catch {}
    }
  }

  /**
   * 发送文本，并在“粘贴完成”后可靠触发回车。
   *
   * 设计目标：
   * - 优先通过 `adapter.paste()` 走终端粘贴通道，避免 bracketed paste 模式下内嵌的 `CR` 被应用层吞掉。
   * - 仅在“文本已被目标 CLI 正常接收”的合适时机发送真正的 `'\r'`(Enter)，保证应用正确解析。
   * - 全链路容错：任何阶段异常都会降级为直接 `write(text)` 并最终补发 `'\r'`。
   * - Gemini：使用“xterm paste + 局部屏幕 ACK/超时兜底 + 延迟回车”策略，避开 40ms paste 防误触窗口。
   * - Codex / Claude + Windows/PowerShell：使用“等待 PTY 回显静默 + 再回车”策略；其中 Codex 的多行正文会改走显式 bracketed paste，避免 PowerShell/ConPTY 下被拆成多条消息。
   *
   * @param tabId 目标标签页标识，用于定位对应 PTY 与终端适配器
   * @param raw 待发送的原始文本；方法内部会规范化并去除尾随换行
   * @param options 可选发送上下文（providerId/terminalMode）
   */
  async sendTextAndEnter(tabId: string, raw: string, options?: TerminalSendOptions): Promise<void> {
    const ptyId = this.getPtyId(tabId);
    if (!ptyId) return;
    const adapter = this.adapters[tabId];
    const text = stripTrailingNewlines(String(raw ?? ""));
    const BRACKET_END = '\x1b[201~';
    const traceId = this.shouldTraceSendDiagnostics(options?.providerId) ? this.nextSendTraceId(options?.providerId) : null;
    const selectedStrategy = this.shouldUseGeminiWindowsEditorStrategy(options?.providerId, options?.terminalMode, options?.geminiWindowsEditorReady)
      ? "gemini-windows-editor"
      : this.shouldUseGeminiWslEditorStrategy(options?.providerId, options?.terminalMode, options?.geminiWslEditorReady, text)
      ? "gemini-wsl-editor"
      : isGeminiProvider(options?.providerId)
      ? "gemini-paste-quiet"
      : this.shouldUseClaudeWindowsSubmitStrategy(options?.providerId, options?.terminalMode, text)
        ? "claude-paste-quiet"
      : this.shouldUseCodexWindowsQuietSubmitStrategy(options?.providerId, options?.terminalMode, text)
        ? "codex-paste-quiet"
      : this.shouldUseCodexWindowsSubmitStrategy(options?.providerId, options?.terminalMode)
        ? "codex-fast-submit"
        : "default-outbound";

    this.logSendDiagnostic(
      traceId,
      `select tab=${tabId} pty=${ptyId} provider=${String(options?.providerId || "")} terminal=${String(options?.terminalMode || "")} chars=${text.length} strategy=${selectedStrategy}`
    );

    if (this.shouldUseGeminiWindowsEditorStrategy(options?.providerId, options?.terminalMode, options?.geminiWindowsEditorReady)) {
      if (this.sendGeminiWindowsTextAndEnter(tabId, ptyId, text, adapter, options, traceId))
        return;
    }
    if (this.shouldUseGeminiWslEditorStrategy(options?.providerId, options?.terminalMode, options?.geminiWslEditorReady, text)) {
      if (this.sendGeminiWslTextAndEnter(tabId, ptyId, text, adapter, options, traceId))
        return;
    }
    if (isGeminiProvider(options?.providerId)) {
      await this.sendGeminiTextAndEnter(ptyId, text, adapter, options, traceId);
      return;
    }
    if (this.shouldUseClaudeWindowsSubmitStrategy(options?.providerId, options?.terminalMode, text)) {
      this.sendClaudeWindowsTextAndEnter(ptyId, text, adapter, options!.terminalMode!, traceId);
      return;
    }
    if (this.shouldUseCodexWindowsQuietSubmitStrategy(options?.providerId, options?.terminalMode, text)) {
      this.sendCodexWindowsTextAndEnter(ptyId, text, adapter, options!.terminalMode!, traceId);
      return;
    }
    if (this.shouldUseCodexWindowsSubmitStrategy(options?.providerId, options?.terminalMode)) {
      this.sendCodexWindowsFastTextAndEnter(ptyId, text, adapter, options!.terminalMode!, traceId);
      return;
    }

    const sendEnter = () => {
      try {
        this.hostPty.write(ptyId, '\r');
      } catch {}
    };

    // 无 adapter 或不支持 paste：直接写入并回车
    if (!adapter || typeof (adapter as any).paste !== 'function') {
      try { this.hostPty.write(ptyId, text); } catch {}
      sendEnter();
      return;
    }

    // 默认路径：监听 xterm -> PTY 的 outbound 数据；检测到 paste 结束或短暂静默后补回车。
    let buffer = '';
    let idleTimer: number | undefined;
    let hardTimer: number | undefined;
    const clearTimers = () => {
      if (idleTimer) {
        try { window.clearTimeout(idleTimer); } catch {}
        idleTimer = undefined;
      }
      if (hardTimer) {
        try { window.clearTimeout(hardTimer); } catch {}
        hardTimer = undefined;
      }
    };
    const scheduleIdle = () => {
      if (idleTimer) {
        try { window.clearTimeout(idleTimer); } catch {}
      }
      idleTimer = window.setTimeout(() => {
        try { unsub?.(); } catch {}
        clearTimers();
        sendEnter();
      }, 24);
    };
    const onOutbound = (chunk: string) => {
      try {
        buffer = (buffer + chunk).slice(-32);
        if (buffer.includes(BRACKET_END)) {
          try { unsub?.(); } catch {}
          clearTimers();
          sendEnter();
          return;
        }
        scheduleIdle();
      } catch {}
    };
    const unsub = adapter.onData(onOutbound);

    try {
      (adapter as any).paste(text);
    } catch {
      try { unsub?.(); } catch {}
      clearTimers();
      try { this.hostPty.write(ptyId, text); } catch {}
      sendEnter();
      return;
    }

    hardTimer = window.setTimeout(() => {
      try { unsub?.(); } catch {}
      clearTimers();
      sendEnter();
    }, 800);
  }

  /**
   * 通知 manager：某个 tab 已经被分配了 PTY id（由上层 set state 后调用）。
   *
   * 关键修复：当渲染进程发生 reload/HMR 时，tab/adapter 会重新创建，但主进程 PTY 仍在运行。
   * 若不恢复输出尾部缓冲，用户会误以为“控制台/任务丢失”。因此：
   * - 仅在 `options.hydrateBacklog=true` 且宿主提供 `pty.backlog` 时，首次绑定该 ptyId 会先回放尾部缓存；
   * - 回放阶段尽量暂停数据流，避免“回放内容”与“实时输出”乱序。
   */
  setPty(tabId: string, ptyId: string, options?: { hydrateBacklog?: boolean }): void {
    this.dlog(`setPty tab=${tabId} pty=${ptyId}`);
    // ensure container & adapter exist, then wire
    this.ensurePersistentContainer(tabId, { skipAutoWireUp: true });

    // 默认不回放：新建会话时直接绑定，避免额外 IPC 与 pause/resume 影响首屏速度
    if (!options?.hydrateBacklog) {
      this.wireUp(tabId, ptyId);
      return;
    }

    // 同一 tab + 同一 ptyId：避免重复回放导致内容叠加
    if (this.backlogHydratedPtyByTab[tabId] === ptyId) {
      this.wireUp(tabId, ptyId);
      return;
    }

    const canBacklog = typeof this.hostPty.backlog === "function";
    // 无 backlog 能力：直接绑定
    if (!canBacklog) {
      this.wireUp(tabId, ptyId);
      return;
    }

    // 回放阶段：先尝试暂停数据流，避免乱序
    try { this.hostPty.pause?.(ptyId); } catch {}
    this.wireUp(tabId, ptyId, { skipInitialResize: true });

    // 异步回放尾部缓存；结束后恢复数据流并做一次精确 resize 同步
    (async () => {
      try {
        // 兜底超时：避免极端情况下 backlog IPC 卡死导致 PTY 长时间处于 pause 状态
        const res = await new Promise<{ ok: boolean; data?: string; error?: string }>((resolve) => {
          let done = false;
          const timer = window.setTimeout(() => {
            if (done) return;
            done = true;
            resolve({ ok: false, error: "timeout" });
          }, 1200);
          this.hostPty.backlog!(ptyId, { maxChars: 900_000 })
            .then((r) => {
              if (done) return;
              done = true;
              try { window.clearTimeout(timer); } catch {}
              resolve((r || { ok: false }) as any);
            })
            .catch((err) => {
              if (done) return;
              done = true;
              try { window.clearTimeout(timer); } catch {}
              resolve({ ok: false, error: String((err as any)?.message || err) });
            });
        });
        if (res && res.ok && typeof res.data === "string" && res.data.length > 0) {
          try { this.adapters[tabId]?.write(res.data); } catch {}
        }
        this.backlogHydratedPtyByTab[tabId] = ptyId;
      } catch {
        // ignore
      } finally {
        try { this.hostPty.resume?.(ptyId); } catch {}
        try { this.scheduleResizeSync(tabId, true); } catch {}
      }
    })();
  }

  /**
   * 通知 manager：某个 tab 已经被激活（变为可见）。
   * 最佳实践：在切换标签页时调用，以便在可见时立刻进行一次精确度量与同步。
   */
  onTabActivated(tabId: string): void {
    this.dlog(`tabActivated tab=${tabId}`);
    if (this.lastFocusedTabId && this.lastFocusedTabId !== tabId) {
      this.blurTab(this.lastFocusedTabId, "switch");
    }
    this.lastFocusedTabId = tabId;
    // 先确保所有 PTY 均处于 resume 状态：后台标签仍需接收 OSC 事件以触发完成通知
    try {
      for (const t of Object.keys(this.adapters)) {
        const pid = this.getPtyId(t);
        if (!pid) continue;
        try { this.hostPty.resume?.(pid); this.dlog(`resume pty=${pid} tab=${t}`); } catch {}
      }
    } catch {}
    // 精确度量并立即同步尺寸
    try { this.scheduleResizeSync(tabId, true); } catch {}
    // 切换后主动聚焦并强制刷新，消解输入法合成/宽字符残影
    try { this.adapters[tabId]?.focus?.(); } catch {}
    // 关键：恢复（或对齐修复）滚动位置，避免隐藏/显示后滚动条指示错误
    try { this.restoreScrollSnapshot(tabId, "activated"); } catch {}
    const pid = this.getPtyId(tabId);
    if (pid) {
      try {
        this.hostPty.write(pid, "\u001b[I");
        this.dlog(`tabActivate.injectFocusGain tab=${tabId} pty=${pid}`);
      } catch (err) {
        this.dlog(`tabActivate.injectFocusGain.error tab=${tabId} pty=${pid} err=${(err as Error)?.message || err}`);
      }
    }
  }

  onTabDeactivated(tabId: string | null | undefined): void {
    if (!tabId) return;
    this.dlog(`tabDeactivated tab=${tabId}`);
    if (this.lastFocusedTabId === tabId) {
      this.lastFocusedTabId = null;
    }
    // 切换/隐藏前先记录滚动快照，确保回到该 tab 时能恢复滚动条位置
    try { this.saveScrollSnapshot(tabId, "deactivated"); } catch {}
    this.blurTab(tabId, "deactivate");
  }

  /**
   * 将持久容器挂载到可见的 host element 中（通常在 tab 被激活时调用）
   */
  attachToHost(tabId: string, hostEl: HTMLElement): void {
    this.dlog(`attachToHost tab=${tabId}`);
    // 关键修复：重复挂载时需先清理旧的宿主事件，避免全局监听器累积导致内存泄漏。
    const existingCleanup = this.resizeUnsubByTab[tabId];
    if (typeof existingCleanup === 'function') {
      try { existingCleanup(); } catch {}
    }
    this.resizeUnsubByTab[tabId] = null;
    const prevObserver = this.hostResizeObserverByTab[tabId] || null;
    try { if (prevObserver) prevObserver.disconnect(); } catch {}
    this.hostResizeObserverByTab[tabId] = null;

    const persistent = this.ensurePersistentContainer(tabId);
    try {
      while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
      hostEl.appendChild(persistent);
    } catch (err) { console.warn('attachToHost failed', err); }
    // 记录 hostEl，安装事件以感知动画/可见性变化
    this.hostElByTab[tabId] = hostEl;
    const removeHostHandlers = this.installHostEventHandlers(tabId, hostEl);

    // 触发一次同步（立即 flush）
    const adapter = this.adapters[tabId];
    if (!adapter) return;
    try { this.scheduleResizeSync(tabId, true); } catch {}
    try { adapter.focus?.(); } catch {}

    // Install a ResizeObserver on the host element to reliably detect layout changes
    // (e.g. window restore/maximize or side panel toggles) and trigger terminal resize.
    try {
      // disconnect any existing observer first
      const oldObserver = this.hostResizeObserverByTab[tabId] ?? null;
      try {
        if (oldObserver && typeof (oldObserver as any).disconnect === 'function') {
          (oldObserver as any).disconnect();
        }
      } catch {}
      const ro = new ResizeObserver(() => {
        try {
          const host = this.hostElByTab[tabId];
          if (host) {
            const r = host.getBoundingClientRect();
            const pr = host.parentElement ? host.parentElement.getBoundingClientRect() : null;
            this.dlog(`ro.cb tab=${tabId} host=${Math.round(r.width)}x${Math.round(r.height)} parent=${pr ? `${Math.round(pr.width)}x${Math.round(pr.height)}` : 'n/a'}`);
          }
        } catch {}
        try {
          // defer to next frame to allow layout to settle
          requestAnimationFrame(() => {
            try { this.scheduleResizeSync(tabId, false); } catch {}
          });
        } catch {}
      });
      try { ro.observe(hostEl); this.dlog(`ro.observe host tab=${tabId}`); } catch {}
      // 关键：同时观察父容器（底部输入区高度变化时，父容器会收缩/扩展）
      try { if (hostEl.parentElement) { ro.observe(hostEl.parentElement); this.dlog(`ro.observe parent tab=${tabId}`); } } catch {}
      this.hostResizeObserverByTab[tabId] = ro;
      this.resizeUnsubByTab[tabId] = () => {
        try { ro.disconnect(); } catch {}
        try { removeHostHandlers(); } catch {}
        this.hostResizeObserverByTab[tabId] = null;
      };
    } catch (err) {
      // If ResizeObserver is not available or errors, fall back to window resize (already registered)
    }
  }

  /**
   * 销毁某个 tab 的持久化资源；如果 alsoClosePty 为 true，则同时请求关闭关联的 PTY
   */
  disposeTab(tabId: string, alsoClosePty = true): void {
    if (this.lastFocusedTabId === tabId) {
      this.lastFocusedTabId = null;
    }
    try { this.blurTab(tabId, "dispose"); } catch {}
    try { this.resizeUnsubByTab[tabId]?.(); } catch {}
    delete this.resizeUnsubByTab[tabId];
    try { this.windowResizeCleanupByTab[tabId]?.(); } catch {}
    delete this.windowResizeCleanupByTab[tabId];
    // 清理定时器与状态
    try { this.clearPendingTimer(tabId); } catch {}
    delete this.pendingSizeByTab[tabId];
    delete this.lastSentSizeByTab[tabId];
    delete this.isAnimatingByTab[tabId];
    delete this.hostElByTab[tabId];
    try { this.unsubByTab[tabId]?.(); } catch {}
    delete this.unsubByTab[tabId];
    try { this.inputUnsubByTab[tabId]?.(); } catch {}
    delete this.inputUnsubByTab[tabId];

    const adapter = this.adapters[tabId];
    try { adapter?.dispose(); } catch {}
    delete this.adapters[tabId];

    const container = this.containers[tabId];
    try { if (container && container.parentNode) container.parentNode.removeChild(container); } catch {}
    delete this.containers[tabId];
    delete this.scrollSnapshotByTab[tabId];
    delete this.backlogHydratedPtyByTab[tabId];

    if (alsoClosePty) {
      const pid = this.getPtyId(tabId);
      if (pid) {
        try { this.hostPty.close(pid); } catch {}
      }
    }
  }

  scrollToTop(tabId: string): void {
    const adapter = this.adapters[tabId];
    if (adapter) {
      try { adapter.scrollToTop(); } catch {}
    }
  }

  scrollToBottom(tabId: string): void {
    const adapter = this.adapters[tabId];
    if (adapter) {
      try { adapter.scrollToBottom(); } catch {}
    }
  }

  /**
   * 清理所有 tab 的资源
   */
  disposeAll(alsoClosePty = true): void {
    for (const tabId of Object.keys({ ...this.adapters })) {
      try { this.disposeTab(tabId, alsoClosePty); } catch {}
    }
  }
}
