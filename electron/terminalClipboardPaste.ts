// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { randomUUID } from "node:crypto";
import type { Clipboard } from "electron";

type ClipboardPort = Pick<Clipboard, "availableFormats" | "readText" | "readHTML" | "readRTF" | "readImage" | "readBookmark" | "write" | "writeText">;
type ClipboardSnapshot = Parameters<Clipboard["write"]>[0];
type PasteResult = { ok: boolean; token?: string; error?: string };
const RESTORABLE_FORMATS = new Set(["text/plain", "text/html", "text/rtf", "image/png", "image/bmp", "image/jpeg", "text/x-moz-url"]);
const PASTE_LEASE_TIMEOUT_MS = 10_000;

/** 为终端原生粘贴临时借用剪贴板，并保护原内容和期间发生的用户复制。 */
export class TerminalClipboardPasteManager {
  private lease: { id: string; token: string; text: string; snapshot: ClipboardSnapshot; timer: ReturnType<typeof setTimeout> } | null = null;

  /** 注入剪贴板接口，使租借和恢复逻辑可独立验证。 */
  constructor(private readonly clipboard: ClipboardPort) {}

  /** 保存可恢复的原内容；并发粘贴或不支持的格式保持原剪贴板不动。 */
  begin(id: string, text: string): PasteResult {
    if (this.lease)
      return { ok: false, error: "clipboard-busy" };
    if (!id || !text || text.length > 4_000_000)
      return { ok: false, error: "invalid-paste" };
    try {
      if (this.clipboard.availableFormats().some((format) => !RESTORABLE_FORMATS.has(format)))
        return { ok: false, error: "clipboard-format-unavailable" };
      const snapshot: ClipboardSnapshot = {
        text: this.clipboard.readText(),
        html: this.clipboard.readHTML(),
        rtf: this.clipboard.readRTF(),
        image: this.clipboard.readImage(),
        bookmark: this.clipboard.readBookmark().title,
      };
      const token = randomUUID();
      const timer = setTimeout(() => this.finish(id, token), PASTE_LEASE_TIMEOUT_MS);
      timer.unref?.();
      this.lease = { id, token, text, snapshot, timer };
      this.clipboard.writeText(text);
      return { ok: true, token };
    } catch (error) {
      this.dispose();
      return { ok: false, error: String(error) };
    }
  }

  /** 只释放对应终端的租借；用户已复制新内容时保留新内容，并报告粘贴未能确认。 */
  finish(id: string, token: string): PasteResult {
    const lease = this.lease;
    if (!lease || lease.id !== id || lease.token !== token)
      return { ok: false, error: "paste-expired" };
    this.lease = null;
    clearTimeout(lease.timer);
    try {
      if (this.clipboard.readText() !== lease.text)
        return { ok: false, error: "clipboard-changed" };
      this.clipboard.write(lease.snapshot);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  /** 退出应用或准备失败时立即恢复仍由本次粘贴持有的剪贴板。 */
  dispose(): void {
    if (this.lease)
      this.finish(this.lease.id, this.lease.token);
  }
}
