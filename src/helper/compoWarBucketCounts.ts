import type { FwaTrackedClanWarRosterMemberCurrent } from "@prisma/client";
import {
  type CompoWarDisplayBucket,
  type CompoWarWeightBucket,
  collapseCompoWarWeightBucketForDisplay,
  getCompoWarWeightBucket,
} from "./compoWarWeightBuckets";

export type CompoWarBucketCounts = Record<CompoWarWeightBucket, number>;
export type CompoWarDisplayBucketCounts = Record<CompoWarDisplayBucket, number>;

export const EMPTY_COMPO_WAR_BUCKET_COUNTS: CompoWarBucketCounts = {
  TH18: 0,
  TH17: 0,
  TH16: 0,
  TH15: 0,
  TH14: 0,
  TH13: 0,
  TH12: 0,
  TH11: 0,
  TH10: 0,
  TH9: 0,
  TH8_OR_LOWER: 0,
};

export const EMPTY_COMPO_WAR_DISPLAY_BUCKET_COUNTS: CompoWarDisplayBucketCounts = {
  TH18: 0,
  TH17: 0,
  TH16: 0,
  TH15: 0,
  TH14: 0,
  "<=TH13": 0,
};

/** Purpose: count granular WAR compo buckets from persisted effective member weights. */
export function buildCompoWarBucketCounts(
  members: readonly Pick<FwaTrackedClanWarRosterMemberCurrent, "effectiveWeight">[],
): CompoWarBucketCounts | null {
  const counts: CompoWarBucketCounts = { ...EMPTY_COMPO_WAR_BUCKET_COUNTS };
  for (const member of members) {
    const bucket = getCompoWarWeightBucket(member.effectiveWeight);
    if (!bucket) return null;
    counts[bucket] += 1;
  }
  return counts;
}

/** Purpose: collapse granular WAR compo buckets into the stable external display bucket set. */
export function collapseCompoWarBucketCountsForDisplay(
  counts: CompoWarBucketCounts,
): CompoWarDisplayBucketCounts {
  const collapsed: CompoWarDisplayBucketCounts = {
    ...EMPTY_COMPO_WAR_DISPLAY_BUCKET_COUNTS,
  };
  for (const [bucket, count] of Object.entries(counts) as Array<
    [CompoWarWeightBucket, number]
  >) {
    collapsed[collapseCompoWarWeightBucketForDisplay(bucket)] += count;
  }
  return collapsed;
}
