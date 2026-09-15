import type { Category } from "@/engine/types";

import { GRADE_LABEL, formatLoss } from "./format";

export interface GradeBadgeProps {
  category: Category;
  /** Equity lost against the best play; shown after the label unless the play was best. */
  errorSize?: number;
}

/**
 * The grade of a played move — best / fine / error / blunder — as a pill in
 * the grade's semantic colour (`--grade-*` theme tokens in styles/themes.css). Purely
 * presentational: announcements go through the drawer's live region.
 */
export function GradeBadge({ category, errorSize }: GradeBadgeProps) {
  const showLoss = errorSize !== undefined && category !== "best";
  return (
    <span className="grade" data-grade={category}>
      <span className="grade__label">{GRADE_LABEL[category]}</span>
      {showLoss ? <span className="grade__loss">{`-${formatLoss(errorSize)}`}</span> : null}
    </span>
  );
}
