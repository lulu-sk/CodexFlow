import i18next from "@/i18n/setup";
import { interpolateI18nText } from "@/lib/translate";

type GitI18nValues = Record<string, unknown>;
export type GitTextResolver = (key: string, fallback: string, values?: GitI18nValues) => string;
type GitTextTranslate = (key: string, options: Record<string, unknown>) => unknown;

/**
 * 统一处理 Git 文案的命名空间、默认值与占位符兜底插值，避免不同组件重复实现同一套翻译逻辑。
 */
export function resolveGitTextWith(
  translate: GitTextTranslate,
  key: string,
  fallback: string,
  values?: GitI18nValues,
): string {
  if (!key) return fallback;
  return interpolateI18nText(String(translate(key, {
    ns: "git",
    defaultValue: fallback,
    ...(values || {}),
  })), values);
}

/**
 * 统一解析 Git 界面文案；i18n 未初始化时回退到传入的默认文本，避免测试环境误报。
 */
export function resolveGitText(key: string, fallback: string, values?: GitI18nValues): string {
  if (!key) return fallback;
  if (!i18next.isInitialized) return interpolateI18nText(fallback, values);
  return resolveGitTextWith(i18next.t.bind(i18next), key, fallback, values);
}

/**
 * 统一解析 Git 更新方式标签，避免 Merge / Rebase / Reset / Fetch 在不同界面出现术语分叉。
 */
export function resolveGitUpdateMethodLabel(method?: string, resolveText?: GitTextResolver): string | undefined {
  const resolveLabel = resolveText || resolveGitText;
  switch (String(method || "").trim()) {
    case "merge":
      return resolveLabel("dialogs.updateOptions.methods.merge.title", "合并");
    case "rebase":
      return resolveLabel("dialogs.updateOptions.methods.rebase.title", "变基");
    case "reset":
      return resolveLabel("dialogs.updateOptions.methods.reset.title", "Reset");
    case "fetch":
      return resolveLabel("updateSession.methods.fetch", "Fetch");
    default:
      return undefined;
  }
}
