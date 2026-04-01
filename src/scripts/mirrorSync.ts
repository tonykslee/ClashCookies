import "dotenv/config";
import { MirrorSyncService } from "../services/MirrorSyncService";

/** Purpose: execute one guarded mirror-sync cycle manually for staging on-demand refreshes. */
async function main(): Promise<void> {
  const service = new MirrorSyncService();
  const result = await service.syncNow("manual");
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        trigger: result.trigger,
        sourceDatabase: result.sourceDatabase,
        targetDatabase: result.targetDatabase,
        durationMs: result.durationMs,
        tableSummaries: result.tableSummaries,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  const message = String((error as { message?: string })?.message ?? error);
  process.stderr.write(`[mirror-sync] ${message}\n`);
  process.exitCode = 1;
});

