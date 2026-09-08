"use client";

import { useCallback, useSyncExternalStore } from "react";

import { THEME_IDS, type ThemeId } from "@/components/board/types";
import {
  DEFAULT_THEME,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  applyTheme,
  browserStorage,
  readDocumentTheme,
} from "@/components/landing/theme-store";

/**
 * Inline bootstrap for the root layout: restores the stored theme onto
 * `<html data-theme>` before first paint. Accepts the raw id or a JSON string
 * (both shapes have been written under 'bg.theme'); heritage needs no
 * attribute; anything unknown is ignored. Wrapped in try/catch because
 * storage access can throw.
 */
export const THEME_BOOTSTRAP_SCRIPT = [
  "(function(){try{",
  `var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});`,
  'if(t&&t.charAt(0)==="\\"")t=JSON.parse(t);',
  `if(${JSON.stringify(THEME_IDS)}.indexOf(t)>=0)document.documentElement.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},t);`,
  "}catch(e){}})();",
].join("");

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [THEME_ATTRIBUTE] });
  window.addEventListener("storage", onChange);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", onChange);
  };
}

const getSnapshot = (): ThemeId => readDocumentTheme(document.documentElement);
const getServerSnapshot = (): ThemeId => DEFAULT_THEME;

/**
 * The active board theme and a setter. The single source of truth is
 * `data-theme` on `<html>` (set before paint by `THEME_BOOTSTRAP_SCRIPT`),
 * so every switch on the page — header, landing chooser, new-game form —
 * agrees; the setter also persists under 'bg.theme'.
 */
export function useTheme(): [ThemeId, (theme: ThemeId) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setTheme = useCallback((next: ThemeId) => {
    applyTheme(next, { root: document.documentElement, storage: browserStorage() });
  }, []);
  return [theme, setTheme];
}
