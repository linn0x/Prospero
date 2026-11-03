import type { NativeSyntheticEvent, ViewProps } from "react-native";

export interface ProsperoGhosttyAvailability {
  available: boolean;
  reason?: string | null;
  version?: string | null;
}

export interface ProsperoGhosttyEvent {
  cols?: number;
  rows?: number;
  data?: string;
  text?: string;
  size?: number;
  fps?: number;
  kb?: number;
  renderer?: string;
  reason?: string | null;
  version?: string | null;
  available?: boolean;
}

export interface ProsperoGhosttyViewProps extends ViewProps {
  active?: boolean;
  fontSize: number;
  inputEnabled?: boolean;
  onReady?: (event: NativeSyntheticEvent<ProsperoGhosttyEvent>) => void;
  onUnavailable?: (event: NativeSyntheticEvent<ProsperoGhosttyEvent>) => void;
  onResize?: (event: NativeSyntheticEvent<ProsperoGhosttyEvent>) => void;
  onInput?: (event: NativeSyntheticEvent<ProsperoGhosttyEvent>) => void;
  onClipboardCopy?: (event: NativeSyntheticEvent<ProsperoGhosttyEvent>) => void;
  onClipboardPaste?: (event: NativeSyntheticEvent<ProsperoGhosttyEvent>) => void;
  onFontSize?: (event: NativeSyntheticEvent<ProsperoGhosttyEvent>) => void;
  onPerf?: (event: NativeSyntheticEvent<ProsperoGhosttyEvent>) => void;
}
