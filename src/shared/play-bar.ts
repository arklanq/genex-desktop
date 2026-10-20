/**
 * Play's bar layer: the transparent page main lays over a game in the viewer (`renderer/play-bar.html`).
 * Its preload (`preload/play-bar.ts`) gives it only these calls of the studio's bridge, and it tells
 * main what holds the bar up.
 */
import type { StudioApi } from "./studio-api.ts";

/** The studio calls the bar's layer may make: the viewer's news, its controls, its game's comments and purchase sheet. */
export const PLAY_BAR_CALLS = [
  "onEvent",
  "playControl",
  "playClose",
  "playBar",
  "playComments",
  "playComment",
  "playUncomment",
  "playPurchase",
] as const satisfies readonly (keyof StudioApi)[];

/** The bridge the bar's layer gets. */
export type PlayBarApi = Pick<StudioApi, (typeof PLAY_BAR_CALLS)[number]>;

/**
 * What the bar's layer tells main about itself: the pointer or the keyboard is on it, or Comments is
 * open; `ready` once its page has mounted, so main draws the bar again for a page that loaded late.
 */
export interface PlayBarHold {
  held: boolean;
  comments: boolean;
  ready?: boolean;
}
