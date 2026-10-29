import { FwaLayoutType } from "@prisma/client";

/** Purpose: provide the stable public title convention for canonical FWA layout posts. */
export function formatFwaLayoutTitle(type: FwaLayoutType, townhall: number): string {
  return type === "RISINGDAWN"
    ? `TH${townhall} - R`
    : `TH${townhall} - ${type}`;
}
