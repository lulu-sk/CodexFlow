// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 终端输入发送工具：
 * - 负责构造 Bracketed Paste 序列（ESC[200~ ... ESC[201~）
 * - 负责 Provider 归一化与 Gemini 的“粘贴后延迟回车”策略
 *
 * 说明
 * - Gemini CLI 将 `\r` 识别为 `return`（默认提交），将 `\n` 识别为 `enter`（默认不绑定）。
 * - 多行文本若直接写入 PTY（包含 `\n`）可能导致换行被忽略；显式 bracketed paste 可让应用将换行视为正文插入。
 * - Gemini CLI 对“非可信终端”的 paste 有 40ms 防误触提交保护，因此需要在粘贴结束后延迟发送 `\r`。
 */

/**
 * Bracketed Paste 起止标记。
 */
export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

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
 * 去除末尾连续的 CR/LF，避免“文本末尾自带换行”导致双回车或时序误判。
 * @param text 原始文本
 * @returns 去除末尾换行后的文本
 */
export function stripTrailingNewlines(text: string): string {
  return String(text ?? "").replace(/[\r\n]+$/g, "");
}

/**
 * 构造 bracketed paste 序列：ESC[200~ + text + ESC[201~。
 * @param text 要粘贴的文本
 * @returns 可直接写入 PTY 的 bracketed paste 序列
 */
export function buildBracketedPastePayload(text: string): string {
  return `${BRACKETED_PASTE_START}${String(text ?? "")}${BRACKETED_PASTE_END}`;
}

/**
 * 计算“粘贴结束 → 自动回车”的延迟（ms）。
 * @param providerId providerId
 * @returns 延迟毫秒数（非 Gemini 返回 0）
 */
export function getPasteEnterDelayMs(providerId?: string | null): number {
  return isGeminiProvider(providerId) ? GEMINI_PASTE_ENTER_DELAY_MS : 0;
}

/**
 * 向 PTY 写入 bracketed paste 序列（用于确保多行换行作为正文插入）。
 * @param write 具体写入函数（例如 data => hostPty.write(ptyId, data)）
 * @param text 要发送的文本
 */
export function writeBracketedPaste(write: (data: string) => void, text: string): void {
  try {
    write(buildBracketedPastePayload(text));
  } catch {}
}

/**
 * 向 PTY 写入 bracketed paste 序列，并在延迟后发送 Enter（`\r`）。
 * @param write 具体写入函数（例如 data => hostPty.write(ptyId, data)）
 * @param raw 原始文本（会自动去除末尾换行）
 * @param options 可选参数（providerId 用于决定延迟；enter 可自定义）
 */
export function writeBracketedPasteAndEnter(
  write: (data: string) => void,
  raw: string,
  options?: { providerId?: string | null; enter?: string }
): void {
  const text = stripTrailingNewlines(String(raw ?? ""));
  const enter = typeof options?.enter === "string" ? options!.enter : "\r";
  const delayMs = getPasteEnterDelayMs(options?.providerId);

  try {
    write(buildBracketedPastePayload(text));
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

