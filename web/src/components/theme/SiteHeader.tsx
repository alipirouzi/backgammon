"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import "./theme.css";
import { ThemeSwitch } from "./ThemeSwitch";

/**
 * Page chrome for every route except the landing, which carries its own
 * masthead and board chooser inside `<main id="board-mount">`.
 */
export function SiteHeader() {
  const pathname = usePathname();
  if (pathname === "/") {
    return null;
  }
  return (
    <header className="site-header">
      <Link href="/" className="site-header__brand">
        backgammon<span className="site-header__tld">.automated.ink</span>
      </Link>
      <nav className="site-header__nav" aria-label="Site">
        <Link href="/play/new" className="site-header__link" aria-current={pathname === "/play/new" ? "page" : undefined}>
          New game
        </Link>
      </nav>
      <ThemeSwitch className="site-header__theme" />
    </header>
  );
}
