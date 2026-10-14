// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { TerminalProgramStatus } from "./terminal-program-status";

const IDLE_CONFIRM_MS = 2500;
const COMPOSER_PATTERN = /^\s*[❯>]\s?.*$/u;
const FOOTER_PATTERN = /\? for shortcuts|shift\s*\+\s*tab to cycle|bypass permissions on|accept edits on|plan mode on|esc to interrupt/iu;

export type ClaudeTurnProbe = {
  idleScreen?: string;
  idleSince?: number;
};

/** 以官方主任务状态确认本轮结束；等待输入、停止及旧轮状态都不是成功完成。 */
export function inspectClaudeProgramStatus(
  status: TerminalProgramStatus,
  startedAt: number,
  blocked: boolean,
  now = Date.now(),
): { working: boolean; completed: boolean } {
  return {
    working: !blocked && status.state === "working",
    completed: !blocked && status.state === "done" && status.receivedAt >= startedAt
      && now - status.receivedAt >= IDLE_CONFIRM_MS,
  };
}

/** 只识别当前输入框和页脚，避免历史回复中的运行字样影响状态。 */
export function readClaudeTurnPhase(screenText: string): "working" | "idle" | "unknown" {
  const lines = screenText.split(/\r?\n/);
  let composerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (COMPOSER_PATTERN.test(lines[index])) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex < 0) return "unknown";
  const footer = lines.slice(composerIndex + 1).filter((line) => line.trim());
  // 对话框、缺失页脚或只读历史画面都不能证明完成。
  if (footer.length > 6 || !footer.some((line) => FOOTER_PATTERN.test(line))
    || /esc to cancel|enter to (?:select|confirm)/iu.test(footer.join("\n"))) return "unknown";
  if (/esc to interrupt/iu.test(footer.join("\n"))) return "working";
  const beforeComposer = lines.slice(Math.max(0, composerIndex - 8), composerIndex).join("\n");
  if (/^\s*[✢✳✶✻✽*·]\s+[^\n]*(?:…|\.\.\.)\s*\(/mu.test(beforeComposer)) return "working";
  return "idle";
}

/** Stop 只提供候选；终端明确空闲且持续稳定后，才允许结束计时及发送通知。 */
export function inspectClaudeTurnState(
  probe: ClaudeTurnProbe,
  screenText: string,
  hasCompletionCandidate: boolean,
  blocked: boolean,
  now = Date.now(),
): { probe: ClaudeTurnProbe; working: boolean; completed: boolean } {
  const phase = blocked ? "unknown" : readClaudeTurnPhase(screenText);
  if (phase !== "idle" || !hasCompletionCandidate)
    return { probe: {}, working: phase === "working", completed: false };
  const idleScreen = screenText.trim();
  const idleSince = probe.idleScreen === idleScreen ? probe.idleSince ?? now : now;
  return {
    probe: { idleScreen, idleSince },
    working: false,
    completed: now - idleSince >= IDLE_CONFIRM_MS,
  };
}
