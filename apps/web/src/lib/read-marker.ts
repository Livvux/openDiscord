// Read markers only follow what was on screen. Geometry is passed in as plain boxes so it stays testable.

export interface Box {
  top: number;
  bottom: number;
}

export interface Row extends Box {
  id: string;
}

/** A row counts as seen once any part of it is inside the viewport; an empty (hidden) viewport sees nothing. */
export function intersects(view: Box, row: Box): boolean {
  return view.bottom > view.top && row.bottom > view.top && row.top < view.bottom;
}

/** The later of two message ids (UUIDv7 ids sort by time); null means none. */
export function laterId(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

/** The newest message whose row intersects the viewport, or null when none does. */
export function newestVisibleId(view: Box, rows: Iterable<Row>): string | null {
  let newest: string | null = null;
  for (const row of rows) if (intersects(view, row)) newest = laterId(newest, row.id);
  return newest;
}

/** The first message from someone else after `readUpTo`: where "jump to new messages" goes. */
export function firstUnseen(messages: readonly { id: string; authorId: string }[], userId: string, readUpTo: string | null): string | null {
  return messages.find((m) => m.authorId !== userId && (readUpTo === null || m.id > readUpTo))?.id ?? null;
}
