import { EXTERNAL_URL_REGEX, normalizeExternalUrl } from "../../shared/external-url";

export interface TerminalBufferCellLike {
  getWidth(): number;
  getChars(): string;
  extended?: { urlId?: number };
}

export interface TerminalBufferLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number, cell?: TerminalBufferCellLike): TerminalBufferCellLike | undefined;
}

export interface TerminalBufferLike {
  readonly viewportY: number;
  readonly length: number;
  getLine(y: number): TerminalBufferLineLike | undefined;
}

export interface TerminalMouseTargetLike {
  readonly cols: number;
  readonly rows: number;
  readonly element?: HTMLElement | undefined;
  readonly modes: { readonly mouseTrackingMode: string };
  readonly buffer: { readonly active: TerminalBufferLike };
  focus?(): void;
  readonly _core?: {
    readonly screenElement?: HTMLElement;
    readonly _mouseService?: {
      getCoords?(
        event: { clientX: number; clientY: number },
        element: HTMLElement | undefined,
        colCount: number,
        rowCount: number,
        isSelection?: boolean,
      ): [number, number] | undefined;
    };
    readonly _oscLinkService?: {
      getLinkData?(linkId: number): { uri: string } | undefined;
    };
    readonly _linkifier?: {
      readonly _currentLink?: {
        readonly link?: { readonly text?: string };
      };
    };
  };
}

export function terminalEventTargetsLink(event: MouseEvent): boolean {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  return path.some((item) => {
    const classList = (item as { classList?: { contains?: (value: string) => boolean } } | null)?.classList;
    return typeof classList?.contains === "function" && classList.contains("xterm-cursor-pointer");
  });
}

export function isTerminalLinkOpenModifier(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "altKey">,
  isMac: boolean,
): boolean {
  if (event.button !== 0 || event.altKey) return false;
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Route a primary click through xterm's supported force-selection modifier.
 * Only the DOM event is adapted: the PTY's mouse modes and wheel reporting stay
 * intact. xterm then owns double/triple click, autoscroll, selection and copy.
 */
export function preferLocalTerminalSelection(event: MouseEvent, isMac: boolean, local: boolean, mouseMode: string): void {
  if (!local || mouseMode === "none" || event.button !== 0 || event.ctrlKey || event.metaKey || terminalEventTargetsLink(event)) return;
  Object.defineProperty(event, isMac ? "altKey" : "shiftKey", { configurable: true, value: true });
}

export function resolveTerminalCellCoords(
  terminal: TerminalMouseTargetLike,
  event: Pick<MouseEvent, "clientX" | "clientY">,
): { col: number; bufferRow: number } | undefined {
  if (terminal.cols <= 0 || terminal.rows <= 0) return undefined;
  const screenElement = terminal._core?.screenElement ?? terminal.element;
  const coords = terminal._core?._mouseService?.getCoords?.(
    event,
    screenElement,
    terminal.cols,
    terminal.rows,
  );
  if (coords && coords[0] >= 1 && coords[1] >= 1) {
    return {
      col: Math.min(Math.max(coords[0] - 1, 0), terminal.cols - 1),
      bufferRow: terminal.buffer.active.viewportY + Math.min(Math.max(coords[1] - 1, 0), terminal.rows - 1),
    };
  }
  const rect = screenElement?.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;
  const relX = event.clientX - rect.left;
  const relY = event.clientY - rect.top;
  if (relX < 0 || relY < 0 || relX >= rect.width || relY >= rect.height) return undefined;
  const col = Math.min(Math.max(Math.floor((relX / rect.width) * terminal.cols), 0), terminal.cols - 1);
  const viewportRow = Math.min(Math.max(Math.floor((relY / rect.height) * terminal.rows), 0), terminal.rows - 1);
  return {
    col,
    bufferRow: terminal.buffer.active.viewportY + viewportRow,
  };
}

const MAX_WRAPPED_LINK_LINES = 16;

export function findTerminalBufferUrlAtPosition(
  buffer: TerminalBufferLike,
  cols: number,
  col: number,
  bufferRow: number,
  resolveOscLink?: (urlId: number) => string | undefined,
): string | undefined {
  if (cols <= 0 || col < 0 || col >= cols || bufferRow < 0 || bufferRow >= buffer.length) return undefined;
  const targetLine = buffer.getLine(bufferRow);
  if (!targetLine) return undefined;

  if (resolveOscLink) {
    const clickedCell = targetLine.getCell(col);
    const urlId = clickedCell?.extended?.urlId;
    if (urlId) {
      const normalizedOsc = normalizeExternalUrl(resolveOscLink(urlId));
      if (normalizedOsc) return normalizedOsc;
    }
  }

  let startRow = bufferRow;
  while (startRow > 0 && bufferRow - startRow < MAX_WRAPPED_LINK_LINES && buffer.getLine(startRow)?.isWrapped) {
    startRow -= 1;
  }
  let endRow = bufferRow;
  while (endRow + 1 < buffer.length && endRow - bufferRow < MAX_WRAPPED_LINK_LINES && buffer.getLine(endRow + 1)?.isWrapped) {
    endRow += 1;
  }

  let combinedText = "";
  let targetOffsetStart = -1;
  let targetOffsetEnd = -1;

  for (let row = startRow; row <= endRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) break;
    const maxCols = Math.min(cols, line.length);
    let prevStart = combinedText.length;
    let prevEnd = combinedText.length;
    for (let x = 0; x < maxCols; x += 1) {
      const cell = line.getCell(x);
      const width = cell ? cell.getWidth() : 1;
      let cellStart = prevStart;
      let cellEnd = prevEnd;
      if (width !== 0) {
        const chars = cell?.getChars() || " ";
        cellStart = combinedText.length;
        combinedText += chars;
        cellEnd = combinedText.length;
        prevStart = cellStart;
        prevEnd = cellEnd;
      }
      if (row === bufferRow && x === col) {
        targetOffsetStart = cellStart;
        targetOffsetEnd = cellEnd;
      }
    }
  }

  if (targetOffsetStart < 0 || targetOffsetEnd <= targetOffsetStart) return undefined;

  const matcher = new RegExp(EXTERNAL_URL_REGEX.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(combinedText)) !== null) {
    const rawCandidate = match[0];
    const matchStart = match.index;
    const matchEnd = matchStart + rawCandidate.length;
    if (targetOffsetStart < matchEnd && targetOffsetEnd > matchStart) {
      const normalized = normalizeExternalUrl(rawCandidate);
      if (normalized) return normalized;
    }
  }

  return undefined;
}

export function findTerminalLinkAtMouseEvent(
  terminal: TerminalMouseTargetLike,
  event: MouseEvent,
): { url: string; col: number; bufferRow: number } | undefined {
  const coords = resolveTerminalCellCoords(terminal, event);
  if (coords) {
    const url = findTerminalBufferUrlAtPosition(
      terminal.buffer.active,
      terminal.cols,
      coords.col,
      coords.bufferRow,
      urlId => terminal._core?._oscLinkService?.getLinkData?.(urlId)?.uri,
    );
    if (url) return { url, ...coords };
  }
  if (terminalEventTargetsLink(event)) {
    const hovered = normalizeExternalUrl(terminal._core?._linkifier?._currentLink?.link?.text);
    if (hovered) {
      return {
        url: hovered,
        col: coords?.col ?? -1,
        bufferRow: coords?.bufferRow ?? -1,
      };
    }
  }
  return undefined;
}

export function bindTerminalMouseAndLinks(
  mouseHost: HTMLElement,
  terminal: TerminalMouseTargetLike,
  options: {
    isMac: boolean;
    isLocalSelection: () => boolean;
    onOpenUrl: (event: MouseEvent, url: string) => boolean;
  },
): () => void {
  let pendingLinkClick: { url: string; col: number; bufferRow: number } | undefined;

  const clearPending = (): void => {
    pendingLinkClick = undefined;
  };

  const onMouseDown = (event: MouseEvent): void => {
    pendingLinkClick = undefined;
    if (
      terminal.modes.mouseTrackingMode !== "none" &&
      isTerminalLinkOpenModifier(event, options.isMac)
    ) {
      const hit = findTerminalLinkAtMouseEvent(terminal, event);
      if (hit) {
        pendingLinkClick = hit;
        event.preventDefault();
        event.stopPropagation();
        terminal.focus?.();
        return;
      }
    }
    preferLocalTerminalSelection(
      event,
      options.isMac,
      options.isLocalSelection(),
      terminal.modes.mouseTrackingMode,
    );
  };

  const onMouseUp = (event: MouseEvent): void => {
    if (!pendingLinkClick || event.button !== 0) return;
    const pending = pendingLinkClick;
    pendingLinkClick = undefined;
    event.preventDefault();
    event.stopPropagation();
    if (!isTerminalLinkOpenModifier(event, options.isMac)) return;

    const hitOnRelease = findTerminalLinkAtMouseEvent(terminal, event);
    if (hitOnRelease) {
      options.onOpenUrl(event, hitOnRelease.url);
      return;
    }

    const releaseCoords = resolveTerminalCellCoords(terminal, event);
    if (
      releaseCoords &&
      releaseCoords.bufferRow === pending.bufferRow &&
      Math.abs(releaseCoords.col - pending.col) <= 1
    ) {
      options.onOpenUrl(event, pending.url);
    }
  };

  const onWindowMouseUp = (event: MouseEvent): void => {
    if (!pendingLinkClick || event.button !== 0) return;
    if (event.target && typeof mouseHost.contains === "function" && mouseHost.contains(event.target as Node)) {
      return;
    }
    pendingLinkClick = undefined;
  };

  mouseHost.addEventListener("mousedown", onMouseDown, true);
  mouseHost.addEventListener("mouseup", onMouseUp, true);
  if (typeof window !== "undefined") {
    window.addEventListener("mouseup", onWindowMouseUp, true);
    window.addEventListener("blur", clearPending);
  }

  return () => {
    pendingLinkClick = undefined;
    mouseHost.removeEventListener("mousedown", onMouseDown, true);
    mouseHost.removeEventListener("mouseup", onMouseUp, true);
    if (typeof window !== "undefined") {
      window.removeEventListener("mouseup", onWindowMouseUp, true);
      window.removeEventListener("blur", clearPending);
    }
  };
}
