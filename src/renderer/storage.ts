/**
 * The renderer's own remembered choices in `localStorage`: every `studio.*` key, named once, and
 * reads and writes that never throw. Storage can be unavailable (a locked profile, a full disk,
 * a test without a window); a choice that cannot be remembered simply is not, and a value that
 * cannot be read is the default. The log and the stores hold state; these are preferences.
 */

/** Keys with one value each. */
export const STORAGE_KEYS = {
  sidebarOpen: "studio.sidebarOpen",
  chatWidth: "studio.chatWidth",
  previewView: "studio.previewView",
  activeThread: "studio.activeThread",
  lastGameThread: "studio.lastGameThread",
  reviewProject: "studio.reviewProject",
  effort: "studio.effort",
  lastModel: "studio.model.last",
  studioChatModel: "studio.studioChat.model",
  composerLoop: "studio.composer.loop",
  /** Which subscription models the picker lists, as set in Settings (`state/model-picker.ts` owns the format). */
  pickerModels: "studio.models.picker",
  autopilotHours: "studio.autopilotHours",
  autopilotReview: "studio.autopilotReview",
  terminalHeight: "studio.terminalHeight",
  /** The Live game's sound switch (`panels/stage/game-sound.ts` owns the values). */
  gameSound: "studio.gameSound",
  appearance: "studio.appearance.v1",
  /** Home's background picture and effect (`home-backdrop/settings.ts` owns the format). */
  homeBackdrop: "studio.homeBackdrop.v1",
  /** Live backgrounds a model made for home (`home-backdrop/made-shaders.ts` owns the format). */
  homeBackdropShaders: "studio.homeBackdropShaders.v1",
  /** Set ("1") once home's Background panel has been opened: its button stops glinting. */
  homeBackdropFound: "studio.homeBackdropFound",
  /** The notifications feed (`notifications.ts` owns the format). */
  notifications: "studio.notifications",
  /** Set once the first-launch welcome is finished or skipped on this profile. */
  welcomed: "studio.welcomed",
  /** The Genex promo after the welcome: queued, then settled (`genex-promo.ts` owns the values). */
  genexPromo: "studio.genexPromo",
  /** The developer colour tweaker: open ("1") or not. */
  colorTweakerOpen: "studio.dev.colorTweaker.open",
  /** The developer colour tweaker's drafts and place (`appearance/tweaker/tweaker-memory.ts` owns the format). */
  colorTweaker: "studio.dev.colorTweaker",
} as const;

/** Keys kept per thread, engine, model, game or run. */
export const storageKeyFor = {
  /** A game chat's own model pick. */
  threadModel: (threadId: string): string => `studio.model.${threadId}`,
  /** The roles panel's picks, per engine (`stored-roles.ts` owns the format). */
  roles: (engineId: string): string => `studio.roles.${engineId}`,
  /** Effort per model; Studio's assistant keeps its own apart from game chats. */
  effort: (studio: boolean, modelKey: string | null): string =>
    `${studio ? "studio.studioChat" : "studio"}.effort.${modelKey}`,
  /** Model preferences (context size, …) per model, split the same way. */
  preferences: (studio: boolean, modelKey: string | null): string =>
    `${studio ? "studio.studioChat" : "studio"}.preferences.${modelKey}`,
  /** A game chat's own Loop, as JSON (`loop-setting.ts` owns the format). */
  threadLoop: (threadId: string): string => `studio.loop.${threadId}`,
  /** A game chat's own effort; the per-model effort only seeds fresh chats. */
  threadEffort: (threadId: string): string => `studio.threadEffort.${threadId}`,
} as const;

/** The IndexedDB database of cover sphere stills (`ui/cover-stills.ts` owns the format). */
export const COVER_STILLS_DB = "studio.coverStills";

/** The IndexedDB database of pictures added for home's background (`home-backdrop/images.ts`). */
export const HOME_BACKDROP_IMAGES_DB = "studio.homeBackdropImages";

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The window's storage, or null where there is none or touching it throws. */
export function browserStorage(): KeyValueStorage | null {
  try {
    return (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function readText(key: string, storage: KeyValueStorage | null = browserStorage()): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** False when the value could not be kept. */
export function writeText(key: string, value: string, storage: KeyValueStorage | null = browserStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: string, storage: KeyValueStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* nothing to forget */
  }
}

/**
 * The same storage as an object for code that takes one (the model and role pickers), with every
 * call made safe: nothing it does can throw.
 */
export function safeStorage(storage: KeyValueStorage | null = browserStorage()): KeyValueStorage {
  return {
    getItem: (key) => readText(key, storage),
    setItem: (key, value) => void writeText(key, value, storage),
    removeItem: (key) => removeKey(key, storage),
  };
}

/** A JSON value, or `fallback` when the key is missing or does not parse. */
export function readJson<T>(key: string, fallback: T, storage: KeyValueStorage | null = browserStorage()): T {
  const raw = readText(key, storage);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown, storage: KeyValueStorage | null = browserStorage()): boolean {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return false;
  }
  return writeText(key, text, storage);
}

/** A number kept as text, when it is finite and inside [min, max]; otherwise null. */
export function readNumber(
  key: string,
  min: number,
  max: number,
  storage: KeyValueStorage | null = browserStorage(),
): number | null {
  const raw = readText(key, storage);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  const inRange = Number.isFinite(value) && value >= min && value <= max;
  return inRange ? value : null;
}
