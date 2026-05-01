import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import {
  markPlayerLinkVerified,
  normalizeDiscordUserId,
  normalizePlayerTag,
  type PlayerLinkVerificationOutcome,
} from "./PlayerLinkService";

export type PlayerLinkVerificationResult = {
  outcome: PlayerLinkVerificationOutcome;
  playerTag: string;
  discordUserId: string | null;
  verificationFailureReason?: string | null;
};

export class PlayerLinkVerificationService {
  /** Purpose: initialize service dependencies. */
  constructor(private readonly cocService = new CoCService()) {}

  /** Purpose: verify an owned player link via token. */
  async verifyPlayerToken(input: {
    playerTag: string;
    discordUserId: string;
    token: string;
  }): Promise<PlayerLinkVerificationResult> {
    try {
      const normalizedTag = normalizePlayerTag(input.playerTag);
      if (!normalizedTag) {
        return { outcome: "invalid_tag", playerTag: "", discordUserId: null };
      }

      const normalizedUserId = normalizeDiscordUserId(input.discordUserId);
      if (!normalizedUserId) {
        return { outcome: "invalid_user", playerTag: normalizedTag, discordUserId: null };
      }

      const existing = await prisma.playerLink.findUnique({
        where: { playerTag: normalizedTag },
        select: { discordUserId: true },
      });
      if (!existing?.discordUserId) {
        return { outcome: "not_found", playerTag: normalizedTag, discordUserId: null };
      }
      if (existing.discordUserId !== normalizedUserId) {
        return {
          outcome: "not_owner",
          playerTag: normalizedTag,
          discordUserId: normalizedUserId,
        };
      }

      const verification = await this.cocService.verifyPlayerToken(
        normalizedTag,
        input.token,
      );
      if (!verification) {
        const verificationFailureReason = "player API token did not validate.";
        await prisma.playerLink.updateMany({
          where: { playerTag: normalizedTag },
          data: { verificationFailureReason },
        });
        return {
          outcome: "invalid_token",
          playerTag: normalizedTag,
          discordUserId: normalizedUserId,
          verificationFailureReason,
        };
      }
      const returnedTag = normalizePlayerTag(String(verification?.tag ?? ""));
      if (returnedTag && returnedTag !== normalizedTag) {
        const verificationFailureReason =
          "token verification returned a different player tag.";
        await prisma.playerLink.updateMany({
          where: { playerTag: normalizedTag },
          data: { verificationFailureReason },
        });
        return {
          outcome: "invalid_token",
          playerTag: normalizedTag,
          discordUserId: normalizedUserId,
          verificationFailureReason,
        };
      }

      const updated = await markPlayerLinkVerified({
        playerTag: normalizedTag,
        verifiedByDiscordUserId: normalizedUserId,
        verificationMethod: "PLAYER_API_TOKEN",
      });
      if (!updated) {
        return { outcome: "not_found", playerTag: normalizedTag, discordUserId: null };
      }

      return {
        outcome: "verified",
        playerTag: normalizedTag,
        discordUserId: normalizedUserId,
      };
    } catch {
      const normalizedTag = normalizePlayerTag(input.playerTag);
      const normalizedUserId = normalizeDiscordUserId(input.discordUserId);
      if (normalizedTag) {
        const verificationFailureReason = "player verification service unavailable.";
        await prisma.playerLink.updateMany({
          where: { playerTag: normalizedTag },
          data: { verificationFailureReason },
        });
        return {
          outcome: "service_error",
          playerTag: normalizedTag,
          discordUserId: normalizedUserId,
          verificationFailureReason,
        };
      }
      return { outcome: "service_error", playerTag: "", discordUserId: null };
    }
  }
}
