export const TERMINAL_PROTOCOL_VERSION = 2;

/**
 * How many rows of the PTY a projection shows: the bottom this many.
 *
 * Thirty rather than twenty because the extra rows are close to free. A
 * delta carries only the rows that changed, and the ten rows added at the
 * top are the ones that change least; measured through the real diff and
 * seal, the everyday shapes -- a spinner, a TUI redrawing its footer, a log
 * at a dozen lines a second -- grew by 1-2%. Only a full frame grows with
 * the height (+24%), and those are reconnects and resizes.
 *
 * Clamped on the server to the PTY's own height and to 60.
 */
export const PROJECTION_VIEWPORT_ROWS = 30;

export type TerminalTransportMode = "raw" | "projection";

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
