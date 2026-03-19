import "dotenv/config";
import { FwaFeedOpsService } from "../services/fwa-feeds/FwaFeedOpsService";

type Command =
  | "status"
  | "run"
  | "run-global"
  | "watch-status"
  | "run-job";

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  if (!value) return null;
  return value.slice(prefix.length).trim() || null;
}

/** Purpose: print one JSON payload and terminate with explicit success code. */
function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** Purpose: run manual fwa feed sync operations for local/dev/staging validation workflows. */
async function main(): Promise<void> {
  const command = (process.argv[2] ?? "status").trim() as Command;
  const ops = new FwaFeedOpsService();

  if (command === "status") {
    const tag = readArg("tag");
    const output = await ops.status(tag ?? undefined);
    printJson(output);
    return;
  }

  if (command === "run") {
    const feed = readArg("feed");
    const tag = readArg("tag");
    if (!feed || !tag) {
      throw new Error("Usage: fwaFeedSync run --feed=clan-members|clan-wars --tag=#CLANTAG");
    }
    if (feed !== "clan-members" && feed !== "clan-wars") {
      throw new Error("feed must be clan-members or clan-wars");
    }
    const output = await ops.runTracked(feed, tag);
    printJson(output);
    return;
  }

  if (command === "run-global") {
    const feed = readArg("feed");
    if (!feed) throw new Error("Usage: fwaFeedSync run-global --feed=clans|war-members|clan-wars");
    if (feed !== "clans" && feed !== "war-members" && feed !== "clan-wars") {
      throw new Error("feed must be clans, war-members, or clan-wars");
    }
    const output = await ops.runGlobal(feed);
    printJson(output);
    return;
  }

  if (command === "watch-status") {
    const tag = readArg("tag");
    const output = await ops.watchStatus(tag ?? undefined);
    printJson(output);
    return;
  }

  if (command === "run-job") {
    const job = readArg("job");
    if (!job) {
      throw new Error(
        "Usage: fwaFeedSync run-job --job=clans|clan-members|war-members|tracked-clan-wars-watch|global-clan-wars",
      );
    }
    if (
      job !== "clans" &&
      job !== "clan-members" &&
      job !== "war-members" &&
      job !== "tracked-clan-wars-watch" &&
      job !== "global-clan-wars"
    ) {
      throw new Error("Invalid job name.");
    }
    await ops.runSchedulerJob(job);
    printJson({ ok: true, job });
    return;
  }

  throw new Error(
    "Usage: fwaFeedSync <status|run|run-global|watch-status|run-job> [--feed=...] [--tag=...] [--job=...]",
  );
}

main().catch((error) => {
  const message = String((error as { message?: string })?.message ?? error);
  process.stderr.write(`[fwa-feed-sync] ${message}\n`);
  process.exitCode = 1;
});
