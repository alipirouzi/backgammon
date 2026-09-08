import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/theme/SiteHeader";
import { THEME_BOOTSTRAP_SCRIPT } from "@/components/theme/useTheme";

export const metadata: Metadata = {
  title: "Backgammon",
  description: "An ancient game, a modern take.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The inline script sets data-theme on <html> before first paint from the
    // stored choice; the server cannot know it, hence suppressHydrationWarning.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
