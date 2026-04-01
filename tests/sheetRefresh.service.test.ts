import { afterEach, describe, expect, it } from "vitest";
import {
  SheetRefreshFlowError,
  mapSheetRefreshFlowErrorToMessage,
  triggerSharedSheetRefresh,
} from "../src/services/SheetRefreshService";

const originalPollingMode = process.env.POLLING_MODE;

describe("SheetRefreshService mirror-mode guard", () => {
  afterEach(() => {
    process.env.POLLING_MODE = originalPollingMode;
  });

  it("blocks shared sheet refresh calls while polling mode is mirror", async () => {
    process.env.POLLING_MODE = "mirror";
    await expect(
      triggerSharedSheetRefresh({
        guildId: "guild-1",
        mode: "actual",
      }),
    ).rejects.toMatchObject({
      name: "SheetRefreshFlowError",
      code: "MIRROR_MODE_DISABLED",
    } satisfies Partial<SheetRefreshFlowError>);
  });

  it("maps mirror-mode guard error to a clear user-facing message", () => {
    const err = new SheetRefreshFlowError(
      "MIRROR_MODE_DISABLED",
      "sheet refresh disabled in mirror mode",
    );
    expect(mapSheetRefreshFlowErrorToMessage(err)).toContain(
      "disabled while POLLING_MODE=mirror",
    );
  });
});

