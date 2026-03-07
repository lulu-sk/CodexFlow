import { useEffect, useMemo, useRef, useState } from "react";
import type { ThemeMode } from "@/lib/theme";
import {
  buildMacOSSystemThemeByTone,
  getCachedMacOSTheme,
  resolveMacOSSystemThemeByTone,
  setCachedMacOSTheme,
  type TerminalThemeDefinition,
} from "@/lib/terminal-appearance";

type UseMacOSSystemTerminalThemeOptions = {
  enabled: boolean;
  tone: ThemeMode;
  persistActiveTheme?: boolean;
};

type UseMacOSSystemTerminalThemeResult = {
  theme: TerminalThemeDefinition | null;
  loading: boolean;
  error: string | null;
};

type HostMacOSSystemTheme = {
  id: "macos-system";
  tone: ThemeMode;
  palette: TerminalThemeDefinition["palette"];
  font?: TerminalThemeDefinition["font"];
};

function normalizeCachedMacOSSystemTheme(theme?: TerminalThemeDefinition | null): TerminalThemeDefinition | null {
  if (!theme || theme.id !== "macos-system") return null;
  return theme;
}

function normalizeHostMacOSSystemTheme(theme: HostMacOSSystemTheme): TerminalThemeDefinition {
  return {
    id: "macos-system",
    tone: theme.tone,
    palette: theme.palette,
    font: theme.font,
  };
}

export function useMacOSSystemTerminalTheme(
  options: UseMacOSSystemTerminalThemeOptions
): UseMacOSSystemTerminalThemeResult {
  const { enabled, tone, persistActiveTheme = true } = options;
  const initialCachedTheme = useMemo(() => normalizeCachedMacOSSystemTheme(getCachedMacOSTheme()), []);
  const themesByToneRef = useRef(buildMacOSSystemThemeByTone(initialCachedTheme));
  const [theme, setTheme] = useState<TerminalThemeDefinition | null>(initialCachedTheme);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const currentTone = tone;
    const nextTone = currentTone === "dark" ? "light" : "dark";
    const cachedTheme = resolveMacOSSystemThemeByTone(themesByToneRef.current, currentTone);
    setTheme(cachedTheme);
    setLoading(true);
    setError(null);

    const loadMacTheme = async (targetTone: ThemeMode, apply: boolean) => {
      try {
        const result = await window.host.utils.getMacTerminalTheme({ tone: targetTone });
        if (cancelled) return;
        if (result?.ok && result.theme) {
          const nextTheme = normalizeHostMacOSSystemTheme(result.theme as HostMacOSSystemTheme);
          themesByToneRef.current[nextTheme.tone] = nextTheme;
          if (apply) {
            if (persistActiveTheme) {
              setCachedMacOSTheme(nextTheme);
            }
            setTheme(nextTheme);
            setLoading(false);
            setError(null);
          }
          return;
        }
        if (apply) {
          if (persistActiveTheme && !cachedTheme) {
            setCachedMacOSTheme(null);
          }
          setTheme(cachedTheme);
          setLoading(false);
          setError(result?.error || "unavailable");
        }
      } catch (e) {
        if (cancelled) return;
        if (apply) {
          if (persistActiveTheme && !cachedTheme) {
            setCachedMacOSTheme(null);
          }
          setTheme(cachedTheme);
          setLoading(false);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };

    void loadMacTheme(currentTone, true);
    void loadMacTheme(nextTone, false);

    return () => {
      cancelled = true;
    };
  }, [enabled, persistActiveTheme, tone]);

  return { theme, loading, error };
}
