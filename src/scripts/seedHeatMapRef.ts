import { getPrismaClient } from "../prisma";
import { HEAT_MAP_REF_SEED_ROWS } from "../services/HeatMapRefSeedData";
import { upsertHeatMapRefSeedRows } from "../services/HeatMapRefService";

/** Purpose: run idempotent upserts for the tracked-clan compo HeatMapRef bootstrap rows. */
async function main(): Promise<void> {
  const count = await upsertHeatMapRefSeedRows(HEAT_MAP_REF_SEED_ROWS);
  console.log(`Seeded ${count} HeatMapRef row(s).`);
}

void main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to seed HeatMapRef rows: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrismaClient().$disconnect();
  });
