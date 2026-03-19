import { getPrismaClient } from "../prisma";
import { FWA_LAYOUT_SEED_ROWS } from "../services/FwaLayoutSeedData";
import { upsertFwaLayoutSeedRows } from "../services/FwaLayoutService";

/** Purpose: run idempotent upserts for the canonical FWA layout seed rows. */
async function main(): Promise<void> {
  const count = await upsertFwaLayoutSeedRows(FWA_LAYOUT_SEED_ROWS);
  console.log(`Seeded ${count} FWA layout row(s).`);
}

void main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to seed FWA layouts: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrismaClient().$disconnect();
  });
