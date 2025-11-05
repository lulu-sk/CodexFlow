// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useEffect, useMemo, useState } from "react";

export type ThemeSetting = "light" | "dark" | "system";
export type ThemeMode = "light" | "dark";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

const ensureDocument = () => (typeof document !== "undefined" ? document : null);

const applyThemeMode = (mode: ThemeMode, setting: ThemeSetting) => {
  const doc = ensureDocument();
  if (!doc) return;
  const root = doc.documentElement;
  const body = doc.body;
  root.classList.toggle("dark", mode === "dark");
  if (body) body.classList.toggle("dark", mode === "dark");
  root.dataset.theme = mode;
  root.dataset.themeSetting = setting;
  try {
    root.style.colorScheme = mode;
  } catch {}
};

export const resolveSystemTheme = (): ThemeMode => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  try {
    return window.matchMedia(DARK_MEDIA_QUERY).matches ? "dark" : "light";
  } catch {
    return "light";
  }
};

export const resolveEffectiveTheme = (setting: ThemeSetting): ThemeMode => {
  if (setting === "light" || setting === "dark") {
    return setting;
  }
  return resolveSystemTheme();
};

export const subscribeSystemTheme = (handler: (mode: ThemeMode) => void): (() => void) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(DARK_MEDIA_QUERY);
  const listener = (event: MediaQueryListEvent) => {
    handler(event.matches ? "dark" : "light");
  };
  try {
    mql.addEventListener("change", listener);
    return () => {
      try { mql.removeEventListener("change", listener); } catch {}
    };
  } catch {
    const legacyListener = (event: MediaQueryListEvent) => listener(event);
    // 兼容旧版 Electron / Chromium
    (mql as any).addListener(legacyListener);
    return () => {
      try {
        // 兼容旧版 Electron / Chromium
        (mql as any).removeListener(legacyListener);
      } catch {}
    };
  }
};

export function useThemeController(setting: ThemeSetting): ThemeMode {
  const initial = useMemo<ThemeMode>(() => resolveEffectiveTheme(setting), [setting]);
  const [mode, setMode] = useState<ThemeMode>(() => {
    applyThemeMode(initial, setting);
    return initial;
  });

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    const apply = (nextMode: ThemeMode) => {
      setMode(nextMode);
      applyThemeMode(nextMode, setting);
    };

    if (setting === "system") {
      const current = resolveSystemTheme();
      apply(current);
      unsubscribe = subscribeSystemTheme(apply);
    } else {
      apply(setting);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [setting]);

  return mode;
}

export function applyTheme(setting: ThemeSetting) {
  const mode = resolveEffectiveTheme(setting);
  applyThemeMode(mode, setting);
}


