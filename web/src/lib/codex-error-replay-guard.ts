import type { CodexCliErrorClassification } from "./codex-cli-error-classifier";

export const CODEX_ERROR_REPLAY_HISTORY_LIMIT = 32;

type CodexErrorReplayCandidate = Pick<CodexCliErrorClassification, "kind" | "matchedText">;

type CodexErrorResizeReplayCheck = {
  resizeReplayActive: boolean;
  handledErrorKeys: readonly string[] | undefined;
  classification: CodexErrorReplayCandidate;
};

/**
 * 生成跨重绘稳定的错误特征，忽略错误阶段和重连次数。
 */
export function buildCodexErrorReplayKey(classification: CodexErrorReplayCandidate): string {
  const kind = String(classification?.kind || "").trim().toLowerCase();
  const matchedText = String(classification?.matchedText || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return `${kind}:${matchedText}`;
}

/**
 * 记录已经处理过的错误特征，并通过固定上限避免历史无限增长。
 */
export function rememberCodexErrorReplayKey(
  handledErrorKeys: readonly string[] | undefined,
  classification: CodexErrorReplayCandidate,
  limit = CODEX_ERROR_REPLAY_HISTORY_LIMIT,
): string[] {
  const key = buildCodexErrorReplayKey(classification);
  const boundedLimit = Math.max(1, Math.floor(Number(limit) || CODEX_ERROR_REPLAY_HISTORY_LIMIT));
  const nextKeys = (handledErrorKeys || []).filter((item) => item && item !== key);
  nextKeys.push(key);
  return nextKeys.slice(-boundedLimit);
}

/**
 * 判断当前错误是否只是终端缩放时回放的已处理历史错误。
 */
export function shouldSuppressCodexErrorResizeReplay({
  resizeReplayActive,
  handledErrorKeys,
  classification,
}: CodexErrorResizeReplayCheck): boolean {
  if (!resizeReplayActive || !handledErrorKeys?.length) return false;
  return handledErrorKeys.includes(buildCodexErrorReplayKey(classification));
}
