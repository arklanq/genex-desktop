/**
 * Taking one of the Play viewer's views out of the studio window (`viewer-view.ts`). Its page closes
 * first, whatever state the window is in: Electron marks a closing window destroyed before `closed`,
 * and a page left open keeps the game's sound, timers and microphone going. Electron-free: the window
 * and the view come in by the little of them this needs.
 */

/** A view's page, as closing it needs. */
export interface ClosablePage {
  isDestroyed(): boolean;
  close(): void;
}

/** The window a view leaves, as taking it out needs. */
export interface ViewWindow<V> {
  isDestroyed(): boolean;
  contentView: { removeChildView(view: V): void };
  webContents: { focus(): void };
}

/** A view with a page, as taking it out needs. */
export interface PagedView {
  webContents: ClosablePage;
}

/** Close a view's page unless it is gone already. */
export function closePage(page: ClosablePage | null | undefined): void {
  if (page && !page.isDestroyed()) page.close();
}

/**
 * Take a game's view out of `win`: its page closes, then, while the window lives, the view leaves it
 * and the keyboard comes back to the app's own page (the game, or the bar before the game was up,
 * took it).
 */
export function dropGameView<V extends PagedView>(win: ViewWindow<V>, view: V | null): void {
  closePage(view?.webContents);
  if (win.isDestroyed()) return;
  if (view) win.contentView.removeChildView(view);
  win.webContents.focus();
}
