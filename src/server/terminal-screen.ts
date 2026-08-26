import { createRequire } from "node:module";
import type { IBufferCell, Terminal as XtermTerminal } from "@xterm/headless";
import type {
  TerminalColor,
  TerminalInputModes,
  TerminalRunStyle,
  TerminalScreenCursor,
  TerminalScreenRow,
  TerminalStyledRun,
} from "../shared/terminal-protocol.js";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as { Terminal: typeof XtermTerminal };

export type TerminalScreenSnapshotRow = TerminalScreenRow & { hash: string };

export type TerminalScreenSnapshot = {
  generation: string;
  revision: number;
  sizeEpoch: number;
  cols: number;
  totalRows: number;
  viewportTop: number;
  viewportRows: number;
  alternateScreen: boolean;
  inputModes: TerminalInputModes;
  cursor: TerminalScreenCursor;
  rows: TerminalScreenSnapshotRow[];
};

export type TerminalScreenTheme = "light" | "dark";

export type TerminalScreenModelOptions = {
  generation: string;
  cols: number;
  rows: number;
  theme?: TerminalScreenTheme;
  onResponse?: (data: string) => void;
};

/**
 * A server-owned VT screen model. All parser writes, resizes and snapshots are
 * ordered through one promise tail, so a projection can never observe a
 * half-parsed escape sequence or a grid from two different sizes.
 */
export class TerminalScreenModel {
  readonly generation: string;
  private readonly terminal: XtermTerminal;
  private readonly onResponse?: (data: string) => void;
  private tail: Promise<void> = Promise.resolve();
  private revisionValue = 0;
  private sizeEpochValue = 0;
  private responderEnabled = true;
  private cursorVisible = true;
  private theme: TerminalScreenTheme;
  private disposed = false;

  constructor(options: TerminalScreenModelOptions) {
    this.generation = options.generation;
    this.theme = options.theme ?? "light";
    this.onResponse = options.onResponse;
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 0,
      allowProposedApi: true,
      convertEol: false,
      logLevel: "off",
    });

    // xterm emits DA/DSR and similar protocol replies through onData/onBinary.
    // Only the current responder lease may forward them to the PTY.
    this.terminal.onData((data) => this.respond(data));
    this.terminal.onBinary((data) => this.respond(Buffer.from(data, "binary").toString("binary")));

    // Cursor visibility is not exposed by IModes, so observe DECSET/DECRST 25
    // and return false to let xterm's built-in handler process it as well.
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (flatParams(params).includes(25)) this.cursorVisible = true;
      return false;
    });
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (flatParams(params).includes(25)) this.cursorVisible = false;
      return false;
    });

    // Native agent TUIs query browser colors. Headless has no renderer/theme
    // query implementation, so answer the small set the existing browser
    // terminal used to own. Returning true prevents a second handler reply.
    this.terminal.parser.registerOscHandler(10, (data) => {
      if (data.trim() === "?") this.respond(`\x1b]10;${themeColors(this.theme).foreground}\x1b\\`);
      return true;
    });
    this.terminal.parser.registerOscHandler(11, (data) => {
      if (data.trim() === "?") this.respond(`\x1b]11;${themeColors(this.theme).background}\x1b\\`);
      return true;
    });
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
      if (!flatParams(params).includes(996)) return false;
      this.respond(this.theme === "light" ? "\x1b[?997;2n" : "\x1b[?997;1n");
      return true;
    });

    // Projection deliberately has no clipboard/title/link side effects. The
    // screen cells remain available, but these OSC commands are consumed here.
    this.terminal.parser.registerOscHandler(52, () => true);
    this.terminal.parser.registerOscHandler(8, () => true);
  }

  get revision(): number { return this.revisionValue; }
  get sizeEpoch(): number { return this.sizeEpochValue; }

  setResponderEnabled(enabled: boolean): void { this.responderEnabled = enabled; }
  setTheme(theme: TerminalScreenTheme): void { this.theme = theme; }

  write(data: string): Promise<void> {
    return this.enqueue(() => new Promise<void>((resolve) => {
      this.terminal.write(data, () => {
        this.revisionValue += 1;
        resolve();
      });
    }));
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.enqueue(() => {
      if (this.terminal.cols === cols && this.terminal.rows === rows) return;
      this.terminal.resize(cols, rows);
      this.sizeEpochValue += 1;
      this.revisionValue += 1;
    });
  }

  async snapshot(requestedRows = 20): Promise<TerminalScreenSnapshot> {
    await this.tail;
    if (this.disposed) throw new Error("TERMINAL_SCREEN_DISPOSED");
    const buffer = this.terminal.buffer.active;
    const viewportRows = clampInteger(requestedRows, 5, Math.min(60, this.terminal.rows));
    const viewportTop = Math.max(0, this.terminal.rows - viewportRows);
    const rows: TerminalScreenSnapshotRow[] = [];
    for (let row = 0; row < viewportRows; row += 1) {
      const physicalRow = viewportTop + row;
      const line = buffer.getLine(buffer.baseY + physicalRow);
      rows.push(extractRow(line, row, this.terminal.cols));
    }
    const cursorRow = buffer.cursorY - viewportTop;
    return {
      generation: this.generation,
      revision: this.revisionValue,
      sizeEpoch: this.sizeEpochValue,
      cols: this.terminal.cols,
      totalRows: this.terminal.rows,
      viewportTop,
      viewportRows,
      alternateScreen: buffer.type === "alternate",
      inputModes: readInputModes(this.terminal),
      cursor: {
        row: Math.max(0, Math.min(viewportRows - 1, cursorRow)),
        col: Math.max(0, Math.min(this.terminal.cols - 1, buffer.cursorX)),
        visible: this.cursorVisible && cursorRow >= 0 && cursorRow < viewportRows,
      },
      rows,
    };
  }

  async barrier(): Promise<{ generation: string; revision: number; sizeEpoch: number }> {
    await this.tail;
    return { generation: this.generation, revision: this.revisionValue, sizeEpoch: this.sizeEpochValue };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.tail.finally(() => this.terminal.dispose());
  }

  private respond(data: string): void {
    if (this.responderEnabled && !this.disposed) this.onResponse?.(data);
  }

  private enqueue(task: () => void | Promise<void>): Promise<void> {
    const queued = this.tail.then(async () => {
      if (this.disposed) return;
      await task();
    });
    // Keep the tail usable after a parser failure while still returning the
    // original rejection to its caller for diagnostics/fallback.
    this.tail = queued.catch(() => undefined);
    return queued;
  }
}

function readInputModes(terminal: XtermTerminal): TerminalInputModes {
  const modes = terminal.modes;
  return {
    applicationCursorKeys: modes.applicationCursorKeysMode,
    applicationKeypad: modes.applicationKeypadMode,
    bracketedPaste: modes.bracketedPasteMode,
    mouseTracking: modes.mouseTrackingMode,
    sendFocus: modes.sendFocusMode,
  };
}

function extractRow(line: ReturnType<XtermTerminal["buffer"]["active"]["getLine"]>, row: number, cols: number): TerminalScreenSnapshotRow {
  const cells: Array<{ text: string; style: TerminalRunStyle; meaningful: boolean }> = [];
  let reusable: IBufferCell | undefined;
  for (let col = 0; col < cols; col += 1) {
    const cell = line?.getCell(col, reusable);
    if (!cell) break;
    reusable = cell;
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars();
    const style = cellStyle(cell);
    cells.push({
      text: chars || " ",
      style,
      // Styled spaces (notably reverse-video status bars) are visible and may
      // not be trimmed. Default empty cells can be represented by clearToEnd.
      meaningful: chars.length > 0 || !cell.isAttributeDefault(),
    });
  }
  let length = cells.length;
  while (length > 0 && !cells[length - 1].meaningful) length -= 1;
  const runs: TerminalStyledRun[] = [];
  let lastStyleKey = "";
  for (const cell of cells.slice(0, length)) {
    const styleKey = JSON.stringify(cell.style);
    const previous = runs[runs.length - 1];
    if (previous && styleKey === lastStyleKey) previous.text += cell.text;
    else {
      runs.push({ text: cell.text, style: cell.style });
      lastStyleKey = styleKey;
    }
  }
  const isWrapped = Boolean(line?.isWrapped);
  const hash = JSON.stringify([isWrapped, runs]);
  return { row, clearToEnd: true, isWrapped, runs, hash };
}

function cellStyle(cell: IBufferCell): TerminalRunStyle {
  const flags: TerminalRunStyle["flags"] = [];
  if (cell.isBold()) flags.push("bold");
  if (cell.isDim()) flags.push("dim");
  if (cell.isItalic()) flags.push("italic");
  if (cell.isUnderline()) flags.push("underline");
  if (cell.isBlink()) flags.push("blink");
  if (cell.isInverse()) flags.push("inverse");
  if (cell.isInvisible()) flags.push("invisible");
  if (cell.isStrikethrough()) flags.push("strikethrough");
  if (cell.isOverline()) flags.push("overline");
  return { fg: readColor(cell, "fg"), bg: readColor(cell, "bg"), flags };
}

function readColor(cell: IBufferCell, side: "fg" | "bg"): TerminalColor {
  const isDefault = side === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return "default";
  const isPalette = side === "fg" ? cell.isFgPalette() : cell.isBgPalette();
  const value = side === "fg" ? cell.getFgColor() : cell.getBgColor();
  if (isPalette) return value;
  return `#${value.toString(16).padStart(6, "0")}`;
}

function flatParams(params: (number | number[])[]): number[] {
  return params.flatMap((value) => Array.isArray(value) ? value : [value]);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return Math.min(Math.max(20, min), max);
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function themeColors(theme: TerminalScreenTheme): { foreground: string; background: string } {
  return theme === "light"
    ? { foreground: "rgb:1d1d/2727/3838", background: "rgb:f8f8/fafa/fcfc" }
    : { foreground: "rgb:e5e5/eded/f8f8", background: "rgb:0f0f/1717/2222" };
}

