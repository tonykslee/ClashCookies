-- Additive P2 reference structure. HeatMapRef remains the legacy owner and
-- its rows/columns/provenance are intentionally unchanged.
CREATE TYPE "HeatMapRefBucketTargetStatus" AS ENUM ('SUPPORTED', 'MISSING');

CREATE TABLE "HeatMapRefBucketTarget" (
    "weightMinInclusive" INTEGER NOT NULL,
    "weightMaxInclusive" INTEGER NOT NULL,
    "bucketId" TEXT NOT NULL,
    "targetCount" INTEGER,
    "status" "HeatMapRefBucketTargetStatus" NOT NULL,

    CONSTRAINT "HeatMapRefBucketTarget_pkey" PRIMARY KEY ("weightMinInclusive", "weightMaxInclusive", "bucketId"),
    CONSTRAINT "HeatMapRefBucketTarget_count_shape_check" CHECK (
      ("status" = 'SUPPORTED' AND "targetCount" IS NOT NULL AND "targetCount" >= 0)
      OR ("status" = 'MISSING' AND "targetCount" IS NULL)
    ),
    CONSTRAINT "HeatMapRefBucketTarget_bucket_id_check" CHECK (length(btrim("bucketId")) > 0)
);

CREATE INDEX "HeatMapRefBucketTarget_bucketId_idx" ON "HeatMapRefBucketTarget"("bucketId");

ALTER TABLE "HeatMapRefBucketTarget"
ADD CONSTRAINT "HeatMapRefBucketTarget_parent_fkey"
FOREIGN KEY ("weightMinInclusive", "weightMaxInclusive")
REFERENCES "HeatMapRef"("weightMinInclusive", "weightMaxInclusive")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Deterministic legacy backfill. It copies exact parent values, including
-- zeroes, without changing parent rows, provenance, or low-TH semantics.
INSERT INTO "HeatMapRefBucketTarget" (
  "weightMinInclusive", "weightMaxInclusive", "bucketId", "targetCount", "status"
)
SELECT "weightMinInclusive", "weightMaxInclusive", bucket."bucketId", bucket."targetCount", 'SUPPORTED'::"HeatMapRefBucketTargetStatus"
FROM "HeatMapRef" AS ref
CROSS JOIN LATERAL (
  VALUES
    ('TH18', ref."th18Count"),
    ('TH17', ref."th17Count"),
    ('TH16', ref."th16Count"),
    ('TH15', ref."th15Count"),
    ('TH14', ref."th14Count"),
    ('TH13', ref."th13Count"),
    ('TH12', ref."th12Count"),
    ('TH11', ref."th11Count"),
    ('TH10_OR_LOWER', ref."th10OrLowerCount")
) AS bucket("bucketId", "targetCount")
ORDER BY ref."weightMinInclusive", ref."weightMaxInclusive", bucket."bucketId";
