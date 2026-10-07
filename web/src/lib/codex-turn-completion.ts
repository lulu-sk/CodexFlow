import { isCodexFinalHistoryLine, stripAnsiForCodexErrorScan } from "./codex-cli-error-classifier";
import { hasCodexCurrentTurnBoundary, isCodexTextAfterCurrentTurnBoundary } from "./codex-error-replay-guard";
import { isCodexHistoryBrowsingScreen } from "./codex-tui-screen";

const COMPOSER_PATTERN = /^\s*›\s+Ask Codex to do\b.*$/gmu;
const DURATION_PATTERN = "(?:<1s|(?:\\d+h\\s+)?(?:\\d+m\\s+)?\\d+s)";
const LEGACY_COMPLETION_PATTERN = new RegExp(`^\\s*─+\\s*Worked for ${DURATION_PATTERN}\\s*─+\\s*$`, "u");
const CURRENT_COMPLETION_PATTERN = new RegExp(`^\\s*Worked for ${DURATION_PATTERN}(?:\\s*[•·]\\s*.+)?\\s*$`, "u");
const ACTIVE_STATUS_PATTERN = /Working\s*\(|Reconnecting\.\.\.|esc to interrupt|Pursuing goal|Goal (?:active|unmet|abandoned|budget reached|hit budget)/iu;
const LIVE_STATUS_LINE_PATTERN = /^\s*(?:[•●]\s+[^()\n]+\([^\n]*\besc to interrupt\b[^\n]*\)|(?:[•●]\s*)?Reconnecting\.\.\.\s*\d+\/\d+\b.*|Pursuing goal\b.*)$/iu;

export type CodexTurnCompletionProbe = {
  baseline: string;
  candidate?: string;
  candidateSince?: number;
  boundaryPrompt?: string;
  activityObserved?: boolean;
};

/** 只读取输入框附近的活动栏，避免把历史正文中的 Working 当成本轮运行证据。 */
function hasLiveTurnActivity(screenText: string): boolean {
  const text = stripAnsiForCodexErrorScan(screenText);
  const composer = Array.from(text.matchAll(COMPOSER_PATTERN)).at(-1);
  return !!composer && text.slice(0, composer.index).split("\n").slice(-6)
    .some((line) => LIVE_STATUS_LINE_PATTERN.test(line));
}

/** 读取新旧 TUI 的完成区段；可输入框本身不能证明任务结束。 */
function readCompletionSection(screenText: string): { text: string; marker: string } | null {
  if (isCodexHistoryBrowsingScreen(screenText)) return null;
  const text = stripAnsiForCodexErrorScan(screenText);
  const composer = Array.from(text.matchAll(COMPOSER_PATTERN)).at(-1);
  if (!composer) return null;
  const beforeComposer = text.slice(0, composer.index);
  const lines = beforeComposer.split("\n");
  let markerIndex = -1;
  let legacy = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (LEGACY_COMPLETION_PATTERN.test(lines[index]) || CURRENT_COMPLETION_PATTERN.test(lines[index])) {
      markerIndex = index;
      legacy = LEGACY_COMPLETION_PATTERN.test(lines[index]);
    }
  }
  if (markerIndex < 0) return null;
  const followingLines = lines.slice(markerIndex + 1).filter((line) => line.trim());
  // 新版分隔行位于最终回复之后，旧版位于回复之前，按实际画面结构区分。
  if (!legacy && followingLines.some((line) => !/^\s*\d+ background terminals? running · \/ps to view · \/stop to close\s*$/u.test(line)))
    return null;
  const section = lines.slice(markerIndex).join("\n").trim();
  if (ACTIVE_STATUS_PATTERN.test(text.slice(beforeComposer.lastIndexOf(lines[markerIndex])))) return null;
  if (followingLines.some((line) => /^\s*›\s/u.test(line) || isCodexFinalHistoryLine(line))) return null;
  return { text: section, marker: lines[markerIndex].trim() };
}

/** 保存发送前的完成画面，防止旧回复或恢复历史结束新轮次。 */
export function createCodexTurnCompletionProbe(screenText: string): CodexTurnCompletionProbe {
  return { baseline: readCompletionSection(screenText)?.text || "" };
}

/** 保留本轮输入已出现的证据，长任务滚出读取范围后仍可确认归属。 */
export function observeCodexTurnCompletionBoundary(
  probe: CodexTurnCompletionProbe,
  outputText: string,
  currentPrompt: string,
  blocked: boolean,
): CodexTurnCompletionProbe {
  if (currentPrompt && probe.boundaryPrompt === currentPrompt) return probe;
  if (blocked || isCodexHistoryBrowsingScreen(outputText)
    || !hasCodexCurrentTurnBoundary(outputText, currentPrompt)) return probe;
  return { ...probe, boundaryPrompt: currentPrompt };
}

/** 根据本轮输入或实际活动确认完成区段归属，连续两次稳定可见后结束。 */
export function inspectCodexTurnCompletion(
  probe: CodexTurnCompletionProbe,
  screenText: string,
  currentPrompt: string,
  blocked: boolean,
  now = Date.now(),
): { probe: CodexTurnCompletionProbe; completed: boolean } {
  probe = observeCodexTurnCompletionBoundary(probe, screenText, currentPrompt, blocked);
  if (!blocked && !isCodexHistoryBrowsingScreen(screenText) && hasLiveTurnActivity(screenText))
    probe = { ...probe, activityObserved: true };
  const section = blocked ? null : readCompletionSection(screenText);
  const hasBoundary = hasCodexCurrentTurnBoundary(screenText, currentPrompt);
  const belongsToTurn = section && (hasBoundary
    ? isCodexTextAfterCurrentTurnBoundary(screenText, section.marker, currentPrompt)
    : probe.activityObserved || (currentPrompt && probe.boundaryPrompt === currentPrompt));
  if (!section || (section.text === probe.baseline && !probe.activityObserved) || !belongsToTurn)
    return {
      probe: { baseline: probe.baseline, boundaryPrompt: probe.boundaryPrompt, activityObserved: probe.activityObserved },
      completed: false,
    };
  return {
    probe: {
      ...probe,
      candidate: section.text,
      candidateSince: probe.candidate === section.text ? probe.candidateSince : now,
    },
    completed: probe.candidate === section.text && now - (probe.candidateSince ?? now) >= 1000,
  };
}
