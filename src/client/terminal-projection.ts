import type {
  TerminalColor,
  TerminalInputModes,
  TerminalRunStyle,
  TerminalScreenCursor,
  TerminalScreenFrame,
  TerminalScreenRow,
} from "../shared/terminal-protocol.js";

export type ProjectionScreenState = {
  streamId: string;
  generation: string;
  sequence: number;
  revision: number;
  sizeEpoch: number;
  cols: number;
  totalRows: number;
  viewportTop: number;
  viewportRows: number;
  alternateScreen: boolean;
  inputModes: TerminalInputModes;
  cursor: TerminalScreenCursor;
  rows: TerminalScreenRow[];
};

export type ProjectionFrameResult = {
  state: ProjectionScreenState | null;
  applied: boolean;
  needsSnapshot: boolean;
};

/** Applies only self-contained, range-checked structured screen data. */
export function applyProjectionFrame(current: ProjectionScreenState | null, frame: TerminalScreenFrame): ProjectionFrameResult {
  if (!validFrameShape(frame)) return { state: current, applied: false, needsSnapshot: true };
  const streamChanged = !current || current.streamId !== frame.streamId || current.generation !== frame.generation;
  const structureChanged = current && (
    current.sizeEpoch !== frame.sizeEpoch
    || current.cols !== frame.cols
    || current.viewportTop !== frame.viewportTop
    || current.viewportRows !== frame.viewportRows
    || current.totalRows !== frame.totalRows
  );
  if ((streamChanged || structureChanged) && !frame.full) return { state: current, applied: false, needsSnapshot: true };
  if (current && !streamChanged) {
    if (frame.sequence <= current.sequence) return { state: current, applied: false, needsSnapshot: false };
    if (!frame.full && frame.sequence !== current.sequence + 1) return { state: current, applied: false, needsSnapshot: true };
  }

  let rows = frame.full
    ? Array.from({ length: frame.viewportRows }, (_, row) => blankRow(row))
    : (current?.rows.map(cloneRow) ?? Array.from({ length: frame.viewportRows }, (_, row) => blankRow(row)));
  if (frame.scroll && !frame.full) {
    const { top, bottom, lines } = frame.scroll;
    if (!validScroll(top, bottom, lines, frame.viewportRows)) return { state: current, applied: false, needsSnapshot: true };
    rows = applyScroll(rows, top, bottom, lines);
  }
  for (const row of frame.rows) {
    if (!validRow(row, frame.viewportRows)) return { state: current, applied: false, needsSnapshot: true };
    rows[row.row] = sanitizeRow(row);
  }

  return {
    applied: true,
    needsSnapshot: false,
    state: {
      streamId: frame.streamId,
      generation: frame.generation,
      sequence: frame.sequence,
      revision: frame.revision,
      sizeEpoch: frame.sizeEpoch,
      cols: frame.cols,
      totalRows: frame.totalRows,
      viewportTop: frame.viewportTop,
      viewportRows: frame.viewportRows,
      alternateScreen: frame.alternateScreen,
      inputModes: { ...frame.inputModes },
      cursor: { ...frame.cursor },
      rows,
    },
  };
}

/**
 * Converts an already validated structured screen to controlled ANSI for the
 * local xterm renderer. Remote escape sequences are never forwarded here.
 */
export function projectionScreenToAnsi(state: ProjectionScreenState): string {
  let output = "\x1b[?25l\x1b[0m";
  for (let row = 0; row < state.viewportRows; row += 1) {
    output += `\x1b[${row + 1};1H\x1b[2K`;
    for (const run of state.rows[row]?.runs ?? []) {
      output += styleToSgr(run.style) + sanitizeCellText(run.text);
    }
  }
  output += "\x1b[0m" + inputModesToAnsi(state.inputModes);
  if (state.cursor.visible) {
    output += `\x1b[${clamp(state.cursor.row, 0, state.viewportRows - 1) + 1};${clamp(state.cursor.col, 0, state.cols - 1) + 1}H\x1b[?25h`;
  } else {
    output += "\x1b[?25l";
  }
  return output;
}

export function inputModesToAnsi(modes: TerminalInputModes): string {
  let output = "";
  output += modes.applicationCursorKeys ? "\x1b[?1h" : "\x1b[?1l";
  output += modes.applicationKeypad ? "\x1b[?66h" : "\x1b[?66l";
  output += modes.bracketedPaste ? "\x1b[?2004h" : "\x1b[?2004l";
  output += "\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l";
  if (modes.mouseTracking === "x10") output += "\x1b[?9h";
  else if (modes.mouseTracking === "vt200") output += "\x1b[?1000h";
  else if (modes.mouseTracking === "drag") output += "\x1b[?1002h";
  else if (modes.mouseTracking === "any") output += "\x1b[?1003h";
  output += modes.mouseTracking === "none" ? "\x1b[?1006l" : "\x1b[?1006h";
  output += modes.sendFocus ? "\x1b[?1004h" : "\x1b[?1004l";
  return output;
}

function styleToSgr(style: TerminalRunStyle): string {
  const codes: number[] = [0];
  for (const flag of style.flags) {
    const code = ({
      bold: 1,
      dim: 2,
      italic: 3,
      underline: 4,
      blink: 5,
      inverse: 7,
      invisible: 8,
      strikethrough: 9,
      overline: 53,
    } as const)[flag];
    if (code) codes.push(code);
  }
  codes.push(...colorCodes(style.fg, false), ...colorCodes(style.bg, true));
  return `\x1b[${codes.join(";")}m`;
}

function colorCodes(color: TerminalColor, background: boolean): number[] {
  if (color === "default") return [background ? 49 : 39];
  if (typeof color === "number") {
    const index = clamp(Math.trunc(color), 0, 255);
    if (index < 8) return [(background ? 40 : 30) + index];
    if (index < 16) return [(background ? 100 : 90) + index - 8];
    return [background ? 48 : 38, 5, index];
  }
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return [background ? 49 : 39];
  const value = Number.parseInt(match[1], 16);
  return [background ? 48 : 38, 2, (value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function validFrameShape(frame: TerminalScreenFrame): boolean {
  return frame?.type === "terminal.screen"
    && typeof frame.streamId === "string" && frame.streamId.length > 0
    && typeof frame.generation === "string" && frame.generation.length > 0
    && Number.isSafeInteger(frame.sequence) && frame.sequence > 0
    && Number.isSafeInteger(frame.revision) && frame.revision >= 0
    && Number.isInteger(frame.sizeEpoch) && frame.sizeEpoch >= 0
    && Number.isInteger(frame.cols) && frame.cols >= 20 && frame.cols <= 500
    && Number.isInteger(frame.totalRows) && frame.totalRows >= 5 && frame.totalRows <= 200
    && Number.isInteger(frame.viewportRows) && frame.viewportRows >= 5 && frame.viewportRows <= 60
    && Number.isInteger(frame.viewportTop) && frame.viewportTop >= 0
    && frame.viewportTop + frame.viewportRows <= frame.totalRows
    && Array.isArray(frame.rows)
    && validCursor(frame.cursor, frame.viewportRows, frame.cols)
    && validModes(frame.inputModes);
}

function validModes(modes: TerminalInputModes): boolean {
  return Boolean(modes)
    && typeof modes.applicationCursorKeys === "boolean"
    && typeof modes.applicationKeypad === "boolean"
    && typeof modes.bracketedPaste === "boolean"
    && ["none", "x10", "vt200", "drag", "any"].includes(modes.mouseTracking)
    && typeof modes.sendFocus === "boolean";
}

function validCursor(cursor: TerminalScreenCursor, rows: number, cols: number): boolean {
  return Boolean(cursor)
    && Number.isInteger(cursor.row) && cursor.row >= 0 && cursor.row < rows
    && Number.isInteger(cursor.col) && cursor.col >= 0 && cursor.col < cols
    && typeof cursor.visible === "boolean";
}

function validRow(row: TerminalScreenRow, viewportRows: number): boolean {
  return Number.isInteger(row?.row) && row.row >= 0 && row.row < viewportRows
    && row.clearToEnd === true
    && Array.isArray(row.runs)
    && row.runs.length <= 1_000
    && row.runs.every((run) => typeof run.text === "string" && run.text.length <= 20_000 && validStyle(run.style));
}

function validStyle(style: TerminalRunStyle): boolean {
  return Boolean(style) && validColor(style.fg) && validColor(style.bg) && Array.isArray(style.flags)
    && style.flags.every((flag) => ["bold", "dim", "italic", "underline", "blink", "inverse", "invisible", "strikethrough", "overline"].includes(flag));
}

function validColor(color: TerminalColor): boolean {
  return color === "default"
    || (typeof color === "number" && Number.isInteger(color) && color >= 0 && color <= 255)
    || (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color));
}

function validScroll(top: number, bottom: number, lines: number, rows: number): boolean {
  return Number.isInteger(top) && Number.isInteger(bottom) && Number.isInteger(lines)
    && top >= 0 && top < bottom && bottom < rows && lines !== 0 && Math.abs(lines) <= bottom - top + 1;
}

function applyScroll(rows: TerminalScreenRow[], top: number, bottom: number, lines: number): TerminalScreenRow[] {
  const next = rows.map(cloneRow);
  if (lines > 0) {
    for (let row = top; row <= bottom - lines; row += 1) next[row] = { ...cloneRow(rows[row + lines]), row };
    for (let row = Math.max(top, bottom - lines + 1); row <= bottom; row += 1) next[row] = blankRow(row);
  } else {
    const amount = Math.abs(lines);
    for (let row = bottom; row >= top + amount; row -= 1) next[row] = { ...cloneRow(rows[row - amount]), row };
    for (let row = top; row < Math.min(bottom + 1, top + amount); row += 1) next[row] = blankRow(row);
  }
  return next;
}

function sanitizeRow(row: TerminalScreenRow): TerminalScreenRow {
  return {
    row: row.row,
    clearToEnd: true,
    ...(row.isWrapped ? { isWrapped: true } : {}),
    runs: row.runs.map((run) => ({
      text: sanitizeCellText(run.text),
      style: { fg: run.style.fg, bg: run.style.bg, flags: [...run.style.flags] },
    })),
  };
}

function sanitizeCellText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "\uFFFD");
}

function cloneRow(row: TerminalScreenRow): TerminalScreenRow {
  return { ...row, runs: row.runs.map((run) => ({ text: run.text, style: { ...run.style, flags: [...run.style.flags] } })) };
}

function blankRow(row: number): TerminalScreenRow { return { row, clearToEnd: true, runs: [] }; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
