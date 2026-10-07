import { stripAnsiForCodexErrorScan } from "./codex-cli-error-classifier";

const COMPOSER_LINE_PATTERN = /^[^\S\n]*›[^\S\n]+[^\n]*$/gmu;
const FOLLOW_CONTROL_PATTERN = /^(?:New(?: activity)? · )?↓(?: (?:Back to bottom|Bottom)(?: · esc)?)?$/u;
const HISTORY_FOOTER_PATTERN = /(?:^|\s)(?:enter\/)?esc latest\s*$/u;
const SELECTION_FOOTER_PATTERN = /(?:^|\s)enter copy & follow · esc clear\s*$/u;
const SEARCH_QUERY_PATTERN = /^Find:/u;

/** 检查输入框附近的新版历史导航提示，避免把正在浏览的旧画面当作本轮结果。 */
export function isCodexHistoryBrowsingScreen(screenText: string): boolean {
  const text = stripAnsiForCodexErrorScan(screenText);
  const composer = Array.from(text.matchAll(COMPOSER_LINE_PATTERN)).at(-1);
  if (!composer) return false;
  const beforeComposer = text.slice(0, composer.index).split("\n").slice(-4);
  const afterComposer = text.slice(composer.index! + composer[0].length).split("\n");
  return beforeComposer.some((line) => FOLLOW_CONTROL_PATTERN.test(line.trim()))
    || afterComposer.some((line) => HISTORY_FOOTER_PATTERN.test(line.trim())
      || SELECTION_FOOTER_PATTERN.test(line.trim()) || SEARCH_QUERY_PATTERN.test(line.trim()));
}

/** 结合实际缓冲区、鼠标模式和输入框识别新版自管历史界面，避开旧版和全屏弹窗。 */
export function isCodexOwnedTranscriptScreen(
  bufferType: string,
  mouseTrackingMode: string,
  screenText: string,
  cursorLineText = "",
): boolean {
  return bufferType === "alternate" && mouseTrackingMode !== "none"
    && (/^[^\S\n]*›[^\S\n]+Ask Codex to do\b/mu.test(stripAnsiForCodexErrorScan(screenText))
      || /^[^\S\n]*›[^\S\n]+\S/u.test(cursorLineText));
}
