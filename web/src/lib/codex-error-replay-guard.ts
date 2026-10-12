import {
  classifyCodexCliErrorText,
  detectCodexCliRuntimeStatusText,
  isCodexFinalHistoryLine,
  joinCodexFinalHistoryContinuationLines,
  stripAnsiForCodexErrorScan,
  type CodexCliErrorClassification,
  type CodexCliErrorPhase,
  type CodexCliRuntimePhase,
} from "./codex-cli-error-classifier";
import { isCodexHistoryBrowsingScreen } from "./codex-tui-screen";

export const CODEX_ERROR_REPLAY_HISTORY_LIMIT = 32;
export const CODEX_PTY_SYNCHRONIZED_FRAME_MAX_LENGTH = 2 * 1024 * 1024;

const SYNCHRONIZED_UPDATE_BEGIN = "\u001b[?2026h";
const SYNCHRONIZED_UPDATE_END = "\u001b[?2026l";
const CLEAR_SCROLLBACK_PATTERN = /(?:\u001b\[|\u009b)3J/;
const CLEAR_SCROLLBACK_CSI = "\u001b[3J";
const CLEAR_SCROLLBACK_C1 = "\u009b3J";
const CODEX_COMPOSER_PROMPT_PATTERN = /(?:^|\n)[^\S\n]*›[^\S\n]+Ask Codex to do\b/giu;
const CODEX_BACKGROUND_TERMINALS_FOOTER_PATTERN = /^[^\S\n]*[1-9]\d* background terminals? running · \/ps to view · \/stop to close[^\S\n]*$/u;

type CodexErrorReplayCandidate = Pick<CodexCliErrorClassification, "kind" | "matchedText" | "replayFingerprint">;

export type CodexErrorReplayDecision = "allow" | "suppress" | "await-idle" | "update-reconnect";

export type CodexErrorReplayRecord = {
  key: string;
  turn: number;
  phases?: CodexCliErrorPhase[];
};

export type CodexPtyOutputFrameState = {
  synchronized: boolean;
  bufferedText: string;
  historyReplay: boolean;
};

export type CodexPtyOutputFrame = {
  text: string;
  synchronized: boolean;
  historyReplay: boolean;
};

type CodexErrorReplayCheck = {
  historyReplay: boolean;
  synchronized?: boolean;
  resizeReplayActive: boolean;
  handledErrors: readonly CodexErrorReplayRecord[] | undefined;
  classification: CodexErrorReplayCandidate & Partial<Pick<CodexCliErrorClassification, "phase" | "explicitFinal">>;
  currentTurn: number;
  currentPrompt: string;
  outputText: string;
  currentRuntimePhase?: CodexCliRuntimePhase;
  idleScreenConfirmed?: boolean;
};

type CodexTextMatchRange = {
  index: number;
  end: number;
};

/**
 * 生成跨重绘稳定的错误特征，忽略错误阶段和重连次数。
 */
export function buildCodexErrorReplayKey(classification: CodexErrorReplayCandidate): string {
  const kind = String(classification?.kind || "").trim().toLowerCase();
  const matchedText = String(classification?.replayFingerprint || classification?.matchedText || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return `${kind}:${matchedText}`;
}

/**
 * 创建空的 Codex PTY 同步帧解析状态。
 */
export function createCodexPtyOutputFrameState(): CodexPtyOutputFrameState {
  return {
    synchronized: false,
    bufferedText: "",
    historyReplay: false,
  };
}

/**
 * 在已看到当前轮次输入后结束非同步历史回放标记，避免把后续真实输出长期当作旧画面。
 */
export function completeCodexPtyHistoryReplay(
  state: CodexPtyOutputFrameState | undefined,
): CodexPtyOutputFrameState {
  if (!state || state.synchronized || !state.historyReplay) return state || createCodexPtyOutputFrameState();
  return {
    ...state,
    historyReplay: false,
  };
}

/**
 * 判断输出是否包含 Codex 重建终端历史前发送的清空滚动区命令。
 */
function containsCodexHistoryReplayReset(text: string): boolean {
  return CLEAR_SCROLLBACK_PATTERN.test(String(text || ""));
}

/**
 * 返回文本末尾与任一控制序列开头重合的最长长度，避免 PTY 分块拆断控制序列。
 */
function findControlSequencePrefixSuffixLength(text: string, sequences: readonly string[]): number {
  const source = String(text || "");
  let longest = 0;
  for (const sequence of sequences) {
    const maxLength = Math.min(source.length, sequence.length - 1);
    for (let length = maxLength; length > longest; length -= 1) {
      if (source.endsWith(sequence.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

/**
 * 将 PTY 数据流按同步更新边界聚合成完整帧，并标记真正执行过历史重建的帧。
 */
export function consumeCodexPtyOutputChunk(
  previousState: CodexPtyOutputFrameState | undefined,
  chunk: string,
  maxBufferedLength = CODEX_PTY_SYNCHRONIZED_FRAME_MAX_LENGTH,
): { state: CodexPtyOutputFrameState; frames: CodexPtyOutputFrame[] } {
  const boundedMaxLength = Math.max(
    SYNCHRONIZED_UPDATE_BEGIN.length + SYNCHRONIZED_UPDATE_END.length,
    Math.floor(Number(maxBufferedLength) || CODEX_PTY_SYNCHRONIZED_FRAME_MAX_LENGTH),
  );
  const frames: CodexPtyOutputFrame[] = [];
  let state: CodexPtyOutputFrameState = previousState
    ? { ...previousState }
    : createCodexPtyOutputFrameState();
  let remaining = state.synchronized
    ? String(chunk || "")
    : `${state.bufferedText || ""}${String(chunk || "")}`;
  if (!state.synchronized) state.bufferedText = "";

  while (remaining) {
    if (state.synchronized) {
      const combined = `${state.bufferedText}${remaining}`;
      const endIndex = combined.indexOf(SYNCHRONIZED_UPDATE_END);
      state.historyReplay = state.historyReplay || containsCodexHistoryReplayReset(combined);
      if (endIndex < 0) {
        if (combined.length >= boundedMaxLength) {
          const frameText = combined.slice(0, boundedMaxLength);
          frames.push({
            text: frameText,
            synchronized: true,
            historyReplay: state.historyReplay || containsCodexHistoryReplayReset(frameText),
          });
          remaining = combined.slice(boundedMaxLength);
          state = createCodexPtyOutputFrameState();
          continue;
        }
        state.bufferedText = combined.slice(-boundedMaxLength);
        remaining = "";
        break;
      }

      const endExclusive = endIndex + SYNCHRONIZED_UPDATE_END.length;
      const frameText = combined.slice(0, endExclusive);
      frames.push({
        text: frameText,
        synchronized: true,
        historyReplay: state.historyReplay || containsCodexHistoryReplayReset(frameText),
      });
      remaining = combined.slice(endExclusive);
      state = createCodexPtyOutputFrameState();
      continue;
    }

    const beginIndex = remaining.indexOf(SYNCHRONIZED_UPDATE_BEGIN);
    if (beginIndex < 0) {
      const suffixLength = findControlSequencePrefixSuffixLength(remaining, [
        SYNCHRONIZED_UPDATE_BEGIN,
        CLEAR_SCROLLBACK_CSI,
        CLEAR_SCROLLBACK_C1,
      ]);
      const plainText = suffixLength > 0 ? remaining.slice(0, -suffixLength) : remaining;
      if (plainText) {
        state.historyReplay = state.historyReplay || containsCodexHistoryReplayReset(plainText);
        frames.push({
          text: plainText,
          synchronized: false,
          historyReplay: state.historyReplay,
        });
      }
      state.bufferedText = suffixLength > 0 ? remaining.slice(-suffixLength) : "";
      remaining = "";
      break;
    }

    const plainText = remaining.slice(0, beginIndex);
    if (plainText) {
      state.historyReplay = state.historyReplay || containsCodexHistoryReplayReset(plainText);
      frames.push({
        text: plainText,
        synchronized: false,
        historyReplay: state.historyReplay,
      });
    }
    state = {
      synchronized: true,
      bufferedText: SYNCHRONIZED_UPDATE_BEGIN,
      historyReplay: state.historyReplay,
    };
    remaining = remaining.slice(beginIndex + SYNCHRONIZED_UPDATE_BEGIN.length);
  }

  return { state, frames };
}

/**
 * 记录已经处理过的错误及其发送轮次，并通过固定上限避免历史无限增长。
 */
export function rememberCodexErrorReplay(
  handledErrors: readonly CodexErrorReplayRecord[] | undefined,
  classification: CodexErrorReplayCandidate & Partial<Pick<CodexCliErrorClassification, "phase">>,
  turn: number,
  limit = CODEX_ERROR_REPLAY_HISTORY_LIMIT,
): CodexErrorReplayRecord[] {
  const key = buildCodexErrorReplayKey(classification);
  const normalizedTurn = Math.max(0, Math.floor(Number(turn) || 0));
  const boundedLimit = Math.max(1, Math.floor(Number(limit) || CODEX_ERROR_REPLAY_HISTORY_LIMIT));
  const existing = (handledErrors || []).find((item) => item?.key === key);
  const existingTurn = Math.max(0, Math.floor(Number(existing?.turn) || 0));
  // 延迟到达的旧轮次输出不能覆盖已经确认过的新轮次记录。
  if (existing && existingTurn > normalizedTurn)
    return (handledErrors || []).filter((item) => item?.key).slice(-boundedLimit);

  // 阶段只能在同一轮次内累计；跨轮次保留会把新一轮的最终失败误认为已经处理。
  const phases = new Set<CodexCliErrorPhase>(
    existing && existingTurn === normalizedTurn ? existing.phases || [] : [],
  );
  if (classification.phase) phases.add(classification.phase);
  const nextErrors = (handledErrors || []).filter((item) => item?.key && item.key !== key);
  const nextRecord: CodexErrorReplayRecord = {
    key,
    turn: normalizedTurn,
  };
  if (phases.size > 0) nextRecord.phases = Array.from(phases);
  nextErrors.push(nextRecord);
  return nextErrors.slice(-boundedLimit);
}

/**
 * 合并空白并折叠单字符大小写，同时保留每个字符在原文中的范围。
 */
function normalizeFlexibleLiteral(text: string): { text: string; starts: number[]; ends: number[] } {
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of text.matchAll(/\s+|[^\s]/gu)) {
    const value = match[0];
    const lower = value.toLowerCase();
    const upper = value.toUpperCase();
    // 保留 Unicode 单字符大小写语义；展开为多个字符的大小写不能混同为字面量匹配。
    const folded = /^\s/u.test(value) ? " "
      : value === "ı" || lower.length !== value.length ? value
        : upper.length === value.length ? upper.toLowerCase() : lower;
    characters.push(folded);
    for (let index = 0; index < folded.length; index += 1) {
      starts.push(match.index!);
      ends.push(match.index! + value.length);
    }
  }
  return { text: characters.join(""), starts, ends };
}

/**
 * 迭代查找允许空白差异的字面量，避免长输入在 Electron 中编译正则时栈溢出。
 */
function findLastFlexibleLiteralMatch(
  text: string,
  literal: string,
  accept?: (range: CodexTextMatchRange) => boolean,
): CodexTextMatchRange | null {
  const trimmedLiteral = String(literal || "").trim();
  if (!text || !trimmedLiteral) return null;
  const source = normalizeFlexibleLiteral(text);
  const target = normalizeFlexibleLiteral(trimmedLiteral).text;
  let lastMatch: CodexTextMatchRange | null = null;
  let fromIndex = 0;
  while (fromIndex <= source.text.length - target.length) {
    const index = source.text.indexOf(target, fromIndex);
    if (index < 0) break;
    const endIndex = index + target.length - 1;
    // 输入截断可能留下半个代理对；它不能匹配终端中完整的 Unicode 字符。
    if (source.starts[index] === source.starts[index - 1] || source.ends[endIndex] === source.ends[endIndex + 1]) {
      fromIndex = index + 1;
      continue;
    }
    const range = { index: source.starts[index], end: source.ends[endIndex] };
    if (!accept || accept(range)) lastMatch = range;
    fromIndex = index + target.length;
  }
  return lastMatch;
}

/**
 * 返回表达式在文本中的最后一次匹配范围。
 */
function findLastPatternMatch(text: string, pattern: RegExp): CodexTextMatchRange | null {
  pattern.lastIndex = 0;
  let lastMatch: CodexTextMatchRange | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    lastMatch = {
      index: match.index,
      end: match.index + match[0].length,
    };
    if (match[0] === "") pattern.lastIndex += 1;
  }
  return lastMatch;
}

/**
 * 判断终端画面是否展示 Codex 可输入框；输入框是画面结构，不能代表会话已结束或空闲。
 */
export function hasCodexComposerPrompt(input: string): boolean {
  const text = stripAnsiForCodexErrorScan(input);
  if (!text) return false;
  return findLastPatternMatch(
    text,
    new RegExp(CODEX_COMPOSER_PROMPT_PATTERN.source, CODEX_COMPOSER_PROMPT_PATTERN.flags),
  ) !== null;
}

/**
 * 判断指定运行状态是否确实出现在目标错误之后。
 */
export function isCodexRuntimeStatusAfterError(
  outputText: string,
  runtimePhase: CodexCliRuntimePhase | undefined,
  errorText: string,
): boolean {
  if (runtimePhase !== "working" && runtimePhase !== "reconnecting") return false;
  const text = stripAnsiForCodexErrorScan(outputText);
  const errorMatch = findLastFlexibleLiteralMatch(text, errorText);
  return !!errorMatch && detectCodexCliRuntimeStatusText(text.slice(errorMatch.end))?.phase === runtimePhase;
}

/**
 * 返回当前发送文本在 Codex 用户历史行中的最后一次位置。
 */
function findLastUserPromptIndex(text: string, currentPrompt: string): number {
  return findLastFlexibleLiteralMatch(text, currentPrompt, ({ index }) => {
    const lineStart = Math.max(0, text.lastIndexOf("\n", Math.max(0, index - 1)) + 1);
    const prefix = text.slice(lineStart, index);
    const precedingText = text.slice(Math.max(0, lineStart - 32), index);
    return /^\s*›\s*$/u.test(prefix) || /(?:^|\n)\s*›\s*\n\s*$/u.test(precedingText);
  })?.index ?? -1;
}

/**
 * 判断文本中的最后一处目标是否位于当前发送文本的用户历史之后。
 */
export function isCodexTextAfterCurrentTurnBoundary(
  outputText: string,
  targetText: string,
  currentPrompt: string,
): boolean {
  const text = stripAnsiForCodexErrorScan(outputText);
  if (!text) return false;
  const promptIndex = findLastUserPromptIndex(text, currentPrompt);
  const targetIndex = findLastFlexibleLiteralMatch(text, targetText)?.index ?? -1;
  return promptIndex >= 0 && targetIndex > promptIndex;
}

/**
 * 判断当前输出是否已经可见本轮用户输入，用于结束没有同步结束标记的历史回放状态。
 */
export function hasCodexCurrentTurnBoundary(outputText: string, currentPrompt: string): boolean {
  return findLastUserPromptIndex(stripAnsiForCodexErrorScan(outputText), currentPrompt) >= 0;
}

/**
 * 仅在运行状态可证明属于本轮时才允许它恢复失败计时，历史回放绝不能撤销已确认失败。
 */
export function shouldTrustCodexRuntimeStatusForCurrentTurn({
  historyReplay,
  synchronized = false,
  resizeReplayActive,
  currentPrompt,
  outputText,
  statusText,
}: {
  historyReplay: boolean;
  synchronized?: boolean;
  resizeReplayActive: boolean;
  currentPrompt: string;
  outputText: string;
  statusText: string;
}): boolean {
  if (historyReplay) return false;
  if (!synchronized && !resizeReplayActive) return true;
  return isCodexTextAfterCurrentTurnBoundary(outputText, statusText, currentPrompt);
}

/**
 * 判断当前结果应放行、压制、等待稳定屏幕，还是只更新重连进度。
 */
export function resolveCodexErrorReplayDecision({
  historyReplay,
  synchronized = false,
  resizeReplayActive,
  handledErrors,
  classification,
  currentTurn,
  currentPrompt,
  outputText,
  currentRuntimePhase,
  idleScreenConfirmed = false,
}: CodexErrorReplayCheck): CodexErrorReplayDecision {
  const replayCandidate = historyReplay || synchronized || resizeReplayActive;
  const activeRuntimeAfterError = isCodexRuntimeStatusAfterError(
    outputText,
    currentRuntimePhase,
    classification.matchedText,
  );
  // 最终错误之后仍有 Working/Reconnecting，说明当前画面尚未停在这个错误上。
  if (classification.phase === "final" && activeRuntimeAfterError)
    return "suppress";
  const normalizedTurn = Math.max(0, Math.floor(Number(currentTurn) || 0));
  const errorAfterCurrentTurnBoundary = isCodexTextAfterCurrentTurnBoundary(
    outputText,
    classification.matchedText,
    currentPrompt,
  );
  const hasCurrentTurnBoundary = hasCodexCurrentTurnBoundary(outputText, currentPrompt);
  // 当前输入是可靠的轮次边界；它之前的任何错误都属于历史内容，不依赖错误类别或文本指纹。
  if (hasCurrentTurnBoundary && !errorAfterCurrentTurnBoundary) return "suppress";
  const key = buildCodexErrorReplayKey(classification);
  const handled = handledErrors?.find((item) => item?.key === key);
  const phaseAlreadyHandled = !!handled && (
    !classification.phase
    || !handled.phases?.length
    || handled.phases.includes(classification.phase)
  );
  const handledFinalError = !!handled?.phases?.includes("final") && classification.phase === "reconnecting";
  if (handled && handled.turn > normalizedTurn) return "suppress";
  if (
    handled && handled.turn === normalizedTurn && phaseAlreadyHandled && !handledFinalError
    && classification.phase === "reconnecting"
    && !historyReplay && !resizeReplayActive && (!synchronized || errorAfterCurrentTurnBoundary)
  ) return "update-reconnect";
  if (handled && handled.turn === normalizedTurn && (phaseAlreadyHandled || handledFinalError))
    return "suppress";

  // 局部重画可能只含错误正文；无论标记是否随帧到达，最终失败都必须由稳定屏幕确认。
  if (classification.phase === "final") {
    if ((historyReplay || resizeReplayActive) && !errorAfterCurrentTurnBoundary)
      return "await-idle";
    if (idleScreenConfirmed) return "allow";
    return "await-idle";
  }

  if (!handled) return "allow";
  if (!replayCandidate) return "allow";
  // 明确的历史重建中，当前输入之前的同类错误无论旧轮次处于何种阶段都只是旧画面。
  if (historyReplay && !errorAfterCurrentTurnBoundary) return "suppress";
  if (!phaseAlreadyHandled) return "allow";
  return errorAfterCurrentTurnBoundary ? "allow" : "suppress";
}

/**
 * 判断当前结果是否只是已处理错误的历史重放；保留布尔接口供旧调用方使用。
 */
export function shouldSuppressCodexErrorReplay(check: CodexErrorReplayCheck): boolean {
  return resolveCodexErrorReplayDecision(check) !== "allow";
}

/**
 * 从 xterm 当前稳定可输入画面中解析最后一个终态错误块，仅允许它与输入框之间出现已知后台终端栏。
 */
export function classifyCodexFinalErrorOnIdleScreen(
  screenText: string,
  currentPrompt = "",
): CodexCliErrorClassification | null {
  if (isCodexHistoryBrowsingScreen(screenText)) return null;
  const text = joinCodexFinalHistoryContinuationLines(stripAnsiForCodexErrorScan(screenText));
  const visibleClassification = classifyCodexCliErrorText(text);
  if (
    !visibleClassification
    || visibleClassification.phase !== "final"
    || !visibleClassification.explicitFinal
  ) return null;

  const errorMatch = findLastFlexibleLiteralMatch(text, visibleClassification.matchedText);
  const composerMatch = findLastPatternMatch(
    text,
    new RegExp(CODEX_COMPOSER_PROMPT_PATTERN.source, CODEX_COMPOSER_PROMPT_PATTERN.flags),
  );
  if (!errorMatch || !composerMatch || errorMatch.end > composerMatch.index) return null;
  if (
    isCodexRuntimeStatusAfterError(text, "working", visibleClassification.matchedText)
    || isCodexRuntimeStatusAfterError(text, "reconnecting", visibleClassification.matchedText)
  ) return null;

  const errorLineStart = Math.max(0, text.lastIndexOf("\n", Math.max(0, errorMatch.index - 1)) + 1);
  const errorLineEnd = text.indexOf("\n", errorMatch.end);
  if (errorLineEnd < 0 || errorLineEnd > composerMatch.index) return null;
  if (!isCodexFinalHistoryLine(text.slice(errorLineStart, errorLineEnd))) return null;

  const promptIndex = findLastUserPromptIndex(text, currentPrompt);
  if (promptIndex >= 0 && errorMatch.index < promptIndex) return null;

  // 后台进程可以在当前轮失败后继续存在；严格匹配其独立状态栏，不能放过助手回复或普通警告。
  const interveningLines = text.slice(errorLineEnd + 1, composerMatch.index)
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (interveningLines.length > 1) return null;
  if (interveningLines.length === 1 && !CODEX_BACKGROUND_TERMINALS_FOOTER_PATTERN.test(interveningLines[0])) return null;
  return visibleClassification;
}

/**
 * 判断目标错误类别是否仍是 xterm 当前可输入框之前的最后一个有效事件。
 */
export function isCodexFinalErrorVisibleOnIdleScreen(
  screenText: string,
  classification: CodexErrorReplayCandidate,
  currentPrompt = "",
): boolean {
  return classifyCodexFinalErrorOnIdleScreen(screenText, currentPrompt)?.kind === classification.kind;
}

/**
 * 保留旧版 API，供升级过程中仍有外部测试或旧调用方使用。
 */
export function rememberCodexErrorReplayKey(
  handledErrorKeys: readonly string[] | undefined,
  classification: CodexErrorReplayCandidate,
  limit = CODEX_ERROR_REPLAY_HISTORY_LIMIT,
): string[] {
  const key = buildCodexErrorReplayKey(classification);
  const boundedLimit = Math.max(1, Math.floor(Number(limit) || CODEX_ERROR_REPLAY_HISTORY_LIMIT));
  return [...(handledErrorKeys || []).filter((item) => item && item !== key), key].slice(-boundedLimit);
}

/**
 * 保留旧版缩放去重 API；新版调用方应使用带轮次的 shouldSuppressCodexErrorReplay。
 */
export function shouldSuppressCodexErrorResizeReplay({
  resizeReplayActive,
  handledErrorKeys,
  classification,
}: {
  resizeReplayActive: boolean;
  handledErrorKeys: readonly string[] | undefined;
  classification: CodexErrorReplayCandidate;
}): boolean {
  if (!resizeReplayActive || !handledErrorKeys?.length) return false;
  return handledErrorKeys.includes(buildCodexErrorReplayKey(classification));
}
