export interface ProgressOverlayApprovalAction {
  hostId: string;
  sid: string;
  reqId: string;
  reply: "once" | "reject";
  deepLink: string;
}

export type ProsperoProgressOverlayModuleEvents = {
  onApprovalAction: (event: ProgressOverlayApprovalAction) => void;
};
