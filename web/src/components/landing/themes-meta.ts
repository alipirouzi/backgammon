import type { ThemeId } from "../board/types";

export interface ThemeMeta {
  id: ThemeId;
  /** Display name from the design spec (§5.1). */
  name: string;
  tagline: string;
}

/** The three boards, in the order they are offered. */
export const THEMES: readonly ThemeMeta[] = [
  {
    id: "heritage",
    name: "Tournament Heritage",
    tagline: "Walnut and green felt, oxblood and sand points, ivory and ebony checkers.",
  },
  {
    id: "broadcast",
    name: "Broadcast Modern",
    tagline: "Charcoal and slate, flat checkers, one yellow accent.",
  },
  {
    id: "editorial",
    name: "Editorial Light",
    tagline: "Linen, sage and terracotta, matte checkers.",
  },
];
