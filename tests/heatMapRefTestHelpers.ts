import type { HeatMapRef } from "@prisma/client";
import { buildLegacyHeatMapRefBucketTargets } from "../src/helper/heatMapRefResolver";

type HeatMapRefMock = {
  heatMapRef: {
    findMany: {
      mock: {
        results: Array<{ type: string; value: unknown }>;
      };
    };
  };
  heatMapRefBucketTarget: {
    findMany: {
      mockImplementation: (implementation: () => Promise<unknown[]>) => unknown;
    };
  };
};

/** Keep composition test doubles explicit about the normalized child projection. */
export function installLegacyHeatMapRefBucketTargetMock(prismaMock: HeatMapRefMock): void {
  prismaMock.heatMapRefBucketTarget.findMany.mockImplementation(async () => {
    const lastParentRead = prismaMock.heatMapRef.findMany.mock.results.at(-1);
    const heatMapRefs =
      lastParentRead?.type === "return"
        ? ((await lastParentRead.value) as HeatMapRef[])
        : [];
    return buildLegacyHeatMapRefBucketTargets(heatMapRefs);
  });
}
