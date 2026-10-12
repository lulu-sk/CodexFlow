// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TerminalMode } from "./shell";

/**
 * 终端输入发送工具：
 * - 负责构造 Bracketed Paste 序列（ESC[200~ ... ESC[201~）
 * - 负责 Provider 归一化与 Gemini/Antigravity/Grok 的“粘贴后延迟回车”策略
 *
 * 说明
 * - Gemini CLI 将 `\r` 识别为 `return`（默认提交），将 `\n` 识别为 `enter`（默认不绑定）。
 * - 多行文本若直接写入 PTY（包含 `\n`）可能导致换行被忽略；显式 bracketed paste 可让应用将换行视为正文插入。
 * - Gemini CLI 对“非可信终端”的 paste 有 40ms 防误触提交保护，因此需要在粘贴结束后延迟发送 `\r`。
 * - Windows Codex 使用控制台按键记录，正文换行还需转换为 Alt+Enter，不能只依赖粘贴边界。
 */

/** 粘贴目标环境；省略时保持原始正文，不附加特定 CLI 的按键编码。 */
type TerminalPasteOptions = {
  providerId?: string | null;
  terminalMode?: TerminalMode | null;
};

/**
 * Bracketed Paste 起止标记。
 */
export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

/** 原生粘贴失败后必须保留草稿，禁止回退到可能卡住或误提交的逐键发送。 */
export class TerminalPasteError extends Error {
  /** 标识可直接反馈给输入框的发送失败。 */
  constructor(message: string) {
    super(message);
    this.name = "TerminalPasteError";
  }
}

/**
 * Gemini：粘贴结束后延迟发送 Enter（需大于 40ms 的防误触窗口）。
 */
export const GEMINI_PASTE_ENTER_DELAY_MS = 70;

/**
 * 将 providerId 规范化为小写字符串，便于一致判断。
 * @param providerId 原始 providerId（可能为空/大小写混用）
 * @returns 规范化后的 providerId（小写、去空格）
 */
export function normalizeProviderId(providerId?: string | null): string {
  return String(providerId || "").trim().toLowerCase();
}

/**
 * 判断当前 provider 是否为 Gemini。
 * @param providerId providerId
 * @returns 是否 Gemini
 */
export function isGeminiProvider(providerId?: string | null): boolean {
  return normalizeProviderId(providerId) === "gemini";
}

/**
 * 判断当前 provider 是否为 Grok Build。
 * @param providerId providerId
 * @returns 是否 Grok Build
 */
export function isGrokProvider(providerId?: string | null): boolean {
  return normalizeProviderId(providerId) === "grok";
}

/**
 * 判断当前 provider 是否复用 Gemini 类 CLI 输入策略。
 * @param providerId providerId
 * @returns 是否需要 Gemini 类粘贴保护
 */
export function isGeminiLikeProvider(providerId?: string | null): boolean {
  const normalized = normalizeProviderId(providerId);
  return normalized === "gemini" || normalized === "antigravity" || normalized === "grok";
}

/**
 * 判断当前 provider 是否为 Codex。
 * @param providerId providerId
 * @returns 是否 Codex
 */
export function isCodexProvider(providerId?: string | null): boolean {
  return normalizeProviderId(providerId) === "codex";
}

/**
 * 判断当前 provider 是否为 Claude。
 * @param providerId providerId
 * @returns 是否 Claude
 */
export function isClaudeProvider(providerId?: string | null): boolean {
  return normalizeProviderId(providerId) === "claude";
}

/**
 * 去除末尾连续的 CR/LF，避免“文本末尾自带换行”导致双回车或时序误判。
 * @param text 原始文本
 * @returns 去除末尾换行后的文本
 */
export function stripTrailingNewlines(text: string): string {
  return String(text ?? "").replace(/[\r\n]+$/g, "");
}

/**
 * 判断是否需要兼容 Codex 的 Windows 控制台输入记录。
 */
function isCodexWindowsPaste(options?: TerminalPasteOptions): boolean {
  return isCodexProvider(options?.providerId) && !!options?.terminalMode && options.terminalMode !== "wsl";
}

/**
 * 构造 bracketed paste 序列：ESC[200~ + 正文 + ESC[201~。
 * Codex 的 Windows 输入后端读取按键记录，不能依赖粘贴边界保护正文中的换行：
 * LF 会丢失，普通 CR 可能提前提交；使用 ConPTY 能识别的 Alt+Enter 插入正文换行。
 * 只转换传输数据，保留原始文本供屏幕确认、长度计算和草稿使用。
 * @param text 要粘贴的文本
 * @param options 目标 CLI 与终端环境
 * @returns 可直接写入 PTY 的 bracketed paste 序列
 */
export function buildBracketedPastePayload(text: string, options?: TerminalPasteOptions): string {
  const raw = String(text ?? "");
  const payload = isCodexWindowsPaste(options) ? raw.replace(/\r\n|[\r\n]/g, "\x1b\r") : raw;
  return `${BRACKETED_PASTE_START}${payload}${BRACKETED_PASTE_END}`;
}

/**
 * 计算“粘贴结束 → 自动回车”的延迟（ms）。
 * @param providerId providerId
 * @returns 延迟毫秒数（非 Gemini 类 Provider 返回 0）
 */
export function getPasteEnterDelayMs(providerId?: string | null): number {
  return isGeminiLikeProvider(providerId) ? GEMINI_PASTE_ENTER_DELAY_MS : 0;
}

/**
 * 计算“粘贴正文后，允许自动提交前”的最短等待时间（ms）。
 *
 * 中文说明：
 * - 这个时间不代表“最终提交延迟”，而是“哪怕终端已经出现回显，也至少要再等这么久”；
 * - 目的是避免超长文本在 PowerShell / ConPTY / 非可信终端链路中，出现“paste 已显示，但 CLI 尚未真正进入可提交状态”的抢跑问题；
 * - 目前仅对 Gemini 类 Provider，以及 Windows/PowerShell 下的 Codex / Claude 启用更保守的动态等待。
 *
 * @param args.providerId providerId
 * @param args.terminalMode 当前终端类型
 * @param args.textLength 本次发送文本长度
 * @returns 最短等待时间（毫秒）
 */
export function getPasteSubmitMinWaitMs(args: {
  providerId?: string | null;
  terminalMode?: TerminalMode | null;
  textLength?: number;
}): number {
  const providerId = normalizeProviderId(args.providerId);
  const length = Math.max(0, Math.floor(Number(args.textLength) || 0));
  const chunks = Math.max(1, Math.ceil(length / 2048));

  if (providerId === "gemini" || providerId === "antigravity" || providerId === "grok")
    return Math.min(2400, 140 + chunks * 110);

  if (providerId === "claude" && args.terminalMode && args.terminalMode !== "wsl")
    return Math.min(2600, 160 + chunks * 120);

  if (providerId === "codex" && args.terminalMode && args.terminalMode !== "wsl")
    return Math.min(2200, 120 + chunks * 100);

  return 0;
}

/**
 * 向 PTY 写入 bracketed paste 序列（用于确保多行换行作为正文插入）。
 * @param write 具体写入函数（例如 data => hostPty.write(ptyId, data)）
 * @param text 要发送的文本
 * @param options 目标 CLI 与终端环境
 */
export function writeBracketedPaste(write: (data: string) => void, text: string, options?: TerminalPasteOptions): void {
  try {
    write(buildBracketedPastePayload(text, options));
  } catch {}
}

/**
 * 向 PTY 写入 bracketed paste 序列，并在延迟后发送 Enter（`\r`）。
 * @param write 具体写入函数（例如 data => hostPty.write(ptyId, data)）
 * @param raw 原始文本（会自动去除末尾换行）
 * @param options 目标环境及提交按键；Codex Windows 的兜底发送需等待粘贴保护窗口结束
 */
export function writeBracketedPasteAndEnter(
  write: (data: string) => void,
  raw: string,
  options?: TerminalPasteOptions & { enter?: string }
): void {
  const text = stripTrailingNewlines(String(raw ?? ""));
  const enter = typeof options?.enter === "string" ? options!.enter : "\r";
  const delayMs = isCodexWindowsPaste(options)
    ? getPasteSubmitMinWaitMs({ ...options, textLength: text.length })
    : getPasteEnterDelayMs(options?.providerId);

  try {
    write(buildBracketedPastePayload(text, options));
  } catch {}

  const sendEnter = () => {
    try { write(enter); } catch {}
  };

  if (delayMs > 0) {
    try { setTimeout(sendEnter, delayMs); } catch { sendEnter(); }
  } else {
    sendEnter();
  }
}

