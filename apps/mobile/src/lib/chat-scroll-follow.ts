/** Reverse only the display projection; folding, replies and retries keep chronological data. */
export function newestChatItemsFirst<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}

/** Inverted FlatList renders the newest edge at offset zero, independent of older row heights. */
export function isAtLatestChatOffset(offsetY: number): boolean {
  return offsetY <= 60;
}

/** Follow is user intent; intermediate programmatic scroll positions are not that intent. */
export class ChatScrollFollow {
  private follow = true;
  private userGesture = false;
  private dragging = false;
  private momentum = false;

  get following(): boolean { return this.follow; }

  beginDrag(): void {
    this.userGesture = true;
    this.dragging = true;
    this.momentum = false;
    this.follow = false;
  }

  endDrag(atBottom: boolean, velocityY = 0): void {
    if (!this.userGesture) return;
    this.dragging = false;
    this.momentum = Math.abs(velocityY) > 0;
    this.follow = atBottom && !this.momentum;
  }

  beginMomentum(): void {
    if (!this.userGesture) return;
    this.momentum = true;
    this.follow = false;
  }

  endMomentum(atBottom: boolean): void {
    if (!this.userGesture) return;
    this.userGesture = false;
    this.dragging = false;
    this.momentum = false;
    this.follow = atBottom;
  }

  scrolled(atBottom: boolean): void {
    if (this.userGesture && (this.dragging || this.momentum) && !atBottom) this.follow = false;
  }

  /** Called before both the explicit jump and layout-driven corrections. */
  followLatest(): void {
    this.follow = true;
    this.userGesture = false;
    this.dragging = false;
    this.momentum = false;
  }
}
