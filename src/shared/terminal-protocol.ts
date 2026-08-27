export const TERMINAL_PROTOCOL_VERSION = 2;

export type TerminalTransportMode = "raw" | "projection";
export type TerminalTransportPreference = "auto" | TerminalTransportMode;

export type TerminalColor = "default" | number | `#${string}`;

export type TerminalRunStyle = {
  fg: TerminalColor;
  bg: TerminalColor;
  flags: Array<"bold" | "dim" | "italic" | "underline" | "blink" | "inverse" | "invisible" | "strikethrough" | "overline">;
};

export type TerminalStyledRun = {
  text: string;
  style: TerminalRunStyle;
};

export type TerminalScreenRow = {
  /** Row number relative to the subscribed projection viewport. */
  row: number;
  clearToEnd: true;
  isWrapped?: boolean;
  runs: TerminalStyledRun[];
};

export type TerminalInputModes = {
  applicationCursorKeys: boolean;
  applicationKeypad: boolean;
  bracketedPaste: boolean;
  mouseTracking: "none" | "x10" | "vt200" | "drag" | "any";
  sendFocus: boolean;
};

export type TerminalScreenCursor = {
  /** Row number relative to the subscribed projection viewport. */
  row: number;
  col: number;
  visible: boolean;
};

export type TerminalScreenScroll = {
  top: number;
  bottom: number;
  /** Positive values move existing content upward. */
  lines: number;
};

export type TerminalScreenFrame = {
  type: "terminal.screen";
  tabId: string;
  generation: string;
  streamId: string;
  sequence: number;
  revision: number;
  full: boolean;
  cols: number;
  totalRows: number;
  viewportTop: number;
  viewportRows: number;
  alternateScreen: boolean;
  sizeEpoch: number;
  inputModes: TerminalInputModes;
  cursor: TerminalScreenCursor;
  rows: TerminalScreenRow[];
  scroll?: TerminalScreenScroll;
  /** Raw PTY cursor aligned with this parsed screen (one-shot bootstrap only). */
  rawNextOffset?: number;
  oneShot?: boolean;
};
