// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { createTerminalAdapter, type TerminalAdapterAPI } from '@/adapters/TerminalAdapter';
import {
  normalizeTerminalAppearance,
  type TerminalAppearance,
} from '@/lib/terminal-appearance';

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
  private adapters: Record<string, TerminalAdapterAPI | null> = {};
  private containers: Record<string, HTMLDivElement | null> = {};
  private unsubByTab: Record<string, (() => void) | null> = {};
  private inputUnsubByTab: Record<string, (() => void) | null> = {};
  private resizeUnsubByTab: Record<string, (() => void) | null> = {};
  private hostResizeObserverByTab: Record<string, ResizeObserver | null> = {};
  private lastSentSizeByTab: Record<string, { cols: number; rows: number } | undefined> = {};
  private pendingTimerByTab: Record<string, number | undefined> = {};
  private pendingSizeByTab: Record<string, { cols: number; rows: number } | undefined> = {};
  private isAnimatingByTab: Record<string, boolean> = {};
  private hostElByTab: Record<string, HTMLElement | null> = {};
  private getPtyId: (tabId: string) => string | undefined;
  private hostPty: HostPtyAPI;
  private appearance: TerminalAppearance = normalizeTerminalAppearance();
  private lastFocusedTabId: string | null = null;

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
    const measured = adapter.resize();
    this.dlog(`measure tab=${tabId} size=${measured?.cols || 0}x${measured?.rows || 0} force=${force}`);
    if (!measured || !measured.cols || !measured.rows) return;
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
  ensurePersistentContainer(tabId: string): HTMLDivElement {
    let container = this.containers[tabId];
    if (container) return container;
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
    if (pid) this.wireUp(tabId, pid);

    // 注册 window resize 监听，使用防抖调度
    const onResize = () => {
      try { this.scheduleResizeSync(tabId, false); } catch {}
    };
    window.addEventListener('resize', onResize);
    this.resizeUnsubByTab[tabId] = () => window.removeEventListener('resize', onResize);
    return container;
  }

  setAppearance(appearance: Partial<TerminalAppearance>): void {
    const next = normalizeTerminalAppearance(appearance);
    if (next.fontFamily === this.appearance.fontFamily) return;
    this.appearance = next;
    for (const [tabId, adapter] of Object.entries(this.adapters)) {
      if (!adapter) continue;
      try { adapter.setAppearance(next); } catch {}
      try { this.scheduleResizeSync(tabId, true); } catch {}
    }
  }

  /**
   * 将指定 tab 的 PTY 与 adapter 做双向绑定：主进程 onData -> adapter.write，adapter.onData -> 主进程 write
   */
  private wireUp(tabId: string, ptyId: string): void {
    this.dlog(`wireUp tab=${tabId} pty=${ptyId}`);
    const adapter = this.adapters[tabId];
    if (!adapter) return;
    try { this.unsubByTab[tabId]?.(); } catch {}
    try { this.inputUnsubByTab[tabId]?.(); } catch {}
    this.unsubByTab[tabId] = this.hostPty.onData(ptyId, (data) => adapter!.write(data));
    this.inputUnsubByTab[tabId] = adapter.onData((data) => this.hostPty.write(ptyId, data));
    // 首次绑定后立即同步一次（走统一的去重/阈值/防抖逻辑，立即 flush）
    try { this.scheduleResizeSync(tabId, true); } catch {}
  }

  /**
   * 发送一段文本到指定 tab 对应的终端：
   * - 优先走 xterm 的 paste 通道（若可用，可触发 bracketed paste，避免应用层对逐字输入做清洗）。
   * - 若 adapter 不存在或 paste 不可用，则回退为直接写入 PTY。
   */
  sendText(tabId: string, text: string): void {
    const adapter = this.adapters[tabId];
    const ptyId = this.getPtyId(tabId);
    if (adapter && typeof (adapter as any).paste === 'function') {
      try { (adapter as any).paste(String(text ?? '')); return; } catch { /* 回退 */ }
    }
    if (ptyId) {
      try { this.hostPty.write(ptyId, String(text ?? '')); } catch {}
    }
  }

    /**
     * 发送文本,并在“粘贴完成”后**可靠**触发回车(Enter)。
     *
     * 设计目标
     * - 优先通过 `adapter.paste()` 走终端粘贴通道,避免 bracketed paste 模式下内嵌的 `CR` 被应用层吞掉。
     * - 仅在**粘贴确已结束**时发送真正的 `'\r'`(Enter),保证应用正确解析。
     * - 全链路容错：任何阶段异常都会降级为直接 `write(text)` 并最终补发 `'\r'`。
     *
     * 行为说明
     * 1) 无 PTY：直接返回(避免空引用/无效写入)。
     * 2) 无 adapter 或不支持 `paste`：直接 `write(text)`,随后发送 `'\r'`。
     * 3) 支持 `paste`：
     *    - 订阅 `adapter.onData`,观察 xterm → PTY 的出站数据：
     *      · 若检测到 bracketed paste 结束标记 **ESC[201~** → 立即取消订阅并发送 `'\r'`；
     *      · 否则在**短暂静默**(默认 24ms,约 1 帧多一点)后视为非 bracketed paste 环境 → 发送 `'\r'`。
     *    - 并行设置**硬超时**(800ms)：极端环境中若未命中上述两种路径,也会最终触发 `'\r'`。
     *    - 触发 `adapter.paste(text)`；如粘贴报错则回退为 `write(text)`。
     *
     * 输入整形
     * - 将入参 `raw` 转为字符串,并**去除末尾的 `\r`/`\n`**,避免末尾换行导致的“双回车”或时序误判。
     *
     * 资源与容错
     * - 订阅与两个定时器(静默计时与硬超时)均在触发 `'\r'` 前**清理**,避免重复触发与内存泄漏。
     * - 所有 I/O、定时器与取消订阅均包裹 `try/catch`,不向调用方抛出异常。
     *
     * 常量与回车策略
     * - `BRACKET_START = ESC[200~`、`BRACKET_END = ESC[201~`(仅将 201~ 作为结束判据；200~ 供上下文理解)。
     * - 回车通过 `this.hostPty.write(ptyId, '\r')` **单独发送**,确保被应用识别为真实 Enter。
     *
     * 参数
     * @param tabId  目标标签页标识,用于定位对应的 PTY 与适配器。
     * @param raw    待发送的原始文本；方法内部会规范化并去除尾随换行。
     *
     * 返回
     * - `void`(副作用：向对应 PTY 写入文本并在合适时机发送 `'\r'`)。
     *
     * 调优建议
     * - 若后端/网络较抖,可适当上调静默窗口(24ms)或硬超时(800ms),以平衡“及时性”与“稳妥性”。
     */
    sendTextAndEnter(tabId: string, raw: string): void {
        const ptyId = this.getPtyId(tabId);
        if (!ptyId) return;
        const adapter = this.adapters[tabId];
        const text = String(raw ?? '').replace(/[\r\n]+$/g, '');
        const BRACKET_START = '\x1b[200~';
        const BRACKET_END = '\x1b[201~';
        const sendEnter = () => {
            try {
                this.hostPty.write(ptyId, '\r');
            } catch {
            }
        };

// 无 adapter 或不支持 paste：直接写入并回车
        if (!adapter || typeof (adapter as any).paste !== 'function') {
            try {
                this.hostPty.write(ptyId, text);
            } catch {
            }
            sendEnter();
            return;
        }

// 监听 xterm -> PTY 的 outbound 数据。当检测到 201~(粘贴结束)
// 或者输出静默一小段时间(无 bracketed paste 的环境)后,再发回车。
        let buffer = '';
        let idleTimer: number | undefined;
        let hardTimer: number | undefined;
        const clearTimers = () => {
            if (idleTimer) {
                try {
                    window.clearTimeout(idleTimer);
                } catch {
                }
                idleTimer = undefined;
            }
            if (hardTimer) {
                try {
                    window.clearTimeout(hardTimer);
                } catch {
                }
                hardTimer = undefined;
            }
        };
        const scheduleIdle = () => {
            if (idleTimer) {
                try {
                    window.clearTimeout(idleTimer);
                } catch {
                }
            }
            idleTimer = window.setTimeout(() => {
                try {
                    unsub?.();
                } catch {
                }
                clearTimers();
                sendEnter();
            }, 24); // 粘贴输出静默 1 帧多一点
        };
        const onOutbound = (chunk: string) => {
            try {
                buffer = (buffer + chunk).slice(-32);
                if (buffer.includes(BRACKET_END)) {
                    try {
                        unsub?.();
                    } catch {
                    }
                    clearTimers();
                    sendEnter();
                    return;
                }
                scheduleIdle();
            } catch {
            }
        };
        const unsub = adapter.onData(onOutbound);

// 触发粘贴(若开启了 bracketed paste,xterm 会输出 200~ + 数据 + 201~)
        try {
            (adapter as any).paste(text);
        } catch {
            try {
                this.hostPty.write(ptyId, text);
            } catch {
            }
        }

// 兜底超时：极端环境最多等 800ms
        hardTimer = window.setTimeout(() => {
            try {
                unsub?.();
            } catch {
            }
            clearTimers();
            sendEnter();
        }, 800);
    }

  /**
   * 通知 manager：某个 tab 已经被分配了 PTY id（由上层 set state 后调用）
   */
  setPty(tabId: string, ptyId: string): void {
    this.dlog(`setPty tab=${tabId} pty=${ptyId}`);
    // ensure container & adapter exist, then wire
    this.ensurePersistentContainer(tabId);
    this.wireUp(tabId, ptyId);
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
    this.blurTab(tabId, "deactivate");
  }

  /**
   * 将持久容器挂载到可见的 host element 中（通常在 tab 被激活时调用）
   */
  attachToHost(tabId: string, hostEl: HTMLElement): void {
    this.dlog(`attachToHost tab=${tabId}`);
    const persistent = this.ensurePersistentContainer(tabId);
    try {
      while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
      hostEl.appendChild(persistent);
    } catch (err) { console.warn('attachToHost failed', err); }
    // 记录 hostEl，安装事件以感知动画/可见性变化
    this.hostElByTab[tabId] = hostEl;
    const prevUnsub = this.resizeUnsubByTab[tabId];
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
      try { this.hostResizeObserverByTab[tabId]?.disconnect(); } catch {}
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
        if (typeof prevUnsub === 'function') try { prevUnsub(); } catch {}
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

    if (alsoClosePty) {
      const pid = this.getPtyId(tabId);
      if (pid) {
        try { this.hostPty.close(pid); } catch {}
      }
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
