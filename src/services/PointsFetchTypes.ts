export type PointsApiFetchReason =
  | "post_war_reconciliation"
  | "post_war_check"
  | "potential_admin_adjustment"
  | "pre_fwa_validation"
  | "manual_refresh"
  | "sync_data_reconcile"
  | "mail_preview"
  | "mail_refresh"
  | "match_render"
  | "points_command"
  | "war_event_projection";

export type PointsLifecycleState = {
  confirmedByClanMail: boolean;
  needsValidation: boolean;
  lastSuccessfulPointsApiFetchAt: Date | null;
  lastKnownSyncNumber: number | null;
  lastKnownPoints?: number | null;
  warId?: string | null;
  opponentTag?: string | null;
  warStartTime?: Date | null;
};
