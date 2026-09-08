"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ThemeId } from "../board/types";
import {
  DEFAULT_THEME,
  THEME_ATTRIBUTE,
  applyTheme,
  browserStorage,
  readDocumentTheme,
  readStoredTheme,
} from "./theme-store";

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [THEME_ATTRIBUTE] });
  window.addEventListener("storage", onChange);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", onChange);
  };
}

function getSnapshot(): ThemeId {
  return readDocumentTheme(document.documentElement);
}

function getServerSnapshot(): ThemeId {
  return DEFAULT_THEME;
}

/**
 * The active board theme, read from `data-theme` on <html> so it stays in
 * step with any other switch on the page (or the layout's inline script), and
 * a setter that applies + persists it under 'bg.theme'.
 */
export function useLandingTheme(): [ThemeId, (theme: ThemeId) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    // Stop-gap until the layout restores the theme before first paint: if the
    // document carries no theme yet but the visitor chose one earlier, restore it.
    const root = document.documentElement;
    if (root.getAttribute(THEME_ATTRIBUTE) !== null) return;
    const stored = readStoredTheme(browserStorage());
    if (stored) root.setAttribute(THEME_ATTRIBUTE, stored);
  }, []);

  const setTheme = useCallback((next: ThemeId) => {
    applyTheme(next, { root: document.documentElement, storage: browserStorage() });
  }, []);

  return [theme, setTheme];
}
