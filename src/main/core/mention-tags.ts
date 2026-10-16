/**
 * A message's @ tags, made real before the agent reads it: a game on this Mac becomes a read-only
 * folder the chat may read, a genex.games game or tool is copied beside the game to read, and an
 * asset's module is added to the game's `src/assets/`.
 *
 * The renderer sends identities only (a library name, a slug); every decision is made here again,
 * against the library and genex.games, because a picker's list can be minutes old.
 *
 * Nothing here refuses a message. A tag that can't be attached is named to the agent with the
 * reason, shown in the chat, and the message still goes.
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  MentionKind,
  MentionMiss,
  type MentionOutcome,
  MentionOrigin,
  type MentionRef,
  MentionResult,
  PROMPT_MENTION_MAX,
} from "../../shared/prompt-mention.ts";
import { isPlaySlug } from "../../shared/play.ts";
import { atomicWriteText } from "../../substrate/fsx.ts";
import { toPosixRelative } from "../../substrate/paths.ts";
import { mentionContext, mentionLine } from "./mention-prompts.ts";

/** One asset module's largest size; genex.games' asset checks hold a module to the same. */
export const ASSET_MODULE_MAX_BYTES = 256 * 1024;
/** Where read-only copies live in a game: ignored by git, builds, checkpoints and Publish. */
export const REFS_DIR = ".studio/refs";
/** Where an asset's module goes in a web game. */
const ASSETS_DIR = "src/assets";
/** The line the asset library's own Copy code button puts on a module. */
const ASSET_HEADER = "// From the Genex asset library - free MIT Three.js assets: https://genex.games/assets\n\n";
/** A module's file name as the library writes them. */
const MODULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.(ts|js|mjs)$/;

/** A genex.games project's page facts, as Remix reads them. */
export interface MentionWorld {
  title: string;
  remixable: boolean;
  cloneUrl: string | null;
  authorId: string | null;
}

/** What resolving tags needs from outside: genex.games, the account and git. */
export interface MentionSources {
  world(slug: string): Promise<MentionWorld>;
  /** The signed-in person's genex.games id, or null. */
  me(): Promise<string | null>;
  /** Copy a genex.games source into `dest`, code only. */
  clone(url: string, dest: string): Promise<void>;
  /** An asset's manifest, as genex.games answers it. */
  assetManifest(slug: string): Promise<unknown>;
}

/** The game the message is for, and the library around it. */
export interface MentionTarget {
  gameDir: string;
  /** Other engines' games take no three.js asset modules. */
  webGame: boolean;
  /** A library game's folder by its name, or null when there is none (or it is this game). */
  libraryDir(name: string): Promise<string | null>;
}

/** What the tags gave: folders the chat may read, the lines for the agent, and each outcome. */
export interface ResolvedMentions {
  readRoots: string[];
  context: string;
  outcomes: MentionOutcome[];
}

/** Resolve a message's tags, one at a time, at most {@link PROMPT_MENTION_MAX}. */
export async function resolveMentions(
  refs: readonly MentionRef[],
  target: MentionTarget,
  sources: MentionSources,
): Promise<ResolvedMentions> {
  const readRoots: string[] = [];
  const lines: string[] = [];
  const outcomes: MentionOutcome[] = [];
  for (const ref of dedupe(refs)) {
    const resolved = await resolveOne(ref, target, sources).catch(
      (): Resolved => ({ outcome: miss(ref, MentionMiss.NotDownloaded) }),
    );
    if (resolved.folder) readRoots.push(resolved.folder);
    lines.push(mentionLine(resolved.outcome, resolved));
    outcomes.push(resolved.outcome);
  }
  return { readRoots, context: mentionContext(lines), outcomes };
}

/** One tag's outcome, with the folder it opens or the usage it brings. */
interface Resolved {
  outcome: MentionOutcome;
  folder?: string;
  usage?: string;
}

function dedupe(refs: readonly MentionRef[]): MentionRef[] {
  const byHandle = new Map(refs.map((ref) => [ref.handle, ref]));
  return [...byHandle.values()].slice(0, PROMPT_MENTION_MAX);
}

/** A tag's outcome before its result: the tag as the person picked it. */
export function tagOf(ref: MentionRef): Omit<MentionOutcome, "result"> {
  return {
    handle: ref.handle,
    title: ref.title,
    kind: ref.kind,
    origin: ref.origin,
    ...(ref.game ? { game: ref.game } : {}),
    ...(ref.slug ? { slug: ref.slug } : {}),
    ...(ref.plugin ? { plugin: ref.plugin } : {}),
    ...(ref.coverUrl ? { coverUrl: ref.coverUrl } : {}),
  };
}

function miss(ref: MentionRef, why: MentionMiss): MentionOutcome {
  return { ...tagOf(ref), result: MentionResult.Unavailable, miss: why };
}

async function resolveOne(ref: MentionRef, target: MentionTarget, sources: MentionSources): Promise<Resolved> {
  // A plugin is on already: the tag only names it to the agent.
  if (ref.kind === MentionKind.Plugin) return { outcome: { ...tagOf(ref), result: MentionResult.Read } };
  if (ref.origin === MentionOrigin.Local) return localGame(ref, target);
  if (!isPlaySlug(ref.slug)) return { outcome: miss(ref, MentionMiss.Gone) };
  if (ref.kind === MentionKind.Asset) return asset(ref, ref.slug, target, sources);
  return reference(ref, ref.slug, target, sources);
}

/** A game on this Mac: its folder, read-only, for this chat. */
async function localGame(ref: MentionRef, target: MentionTarget): Promise<Resolved> {
  const folder = ref.game ? await target.libraryDir(ref.game) : null;
  if (!folder) return { outcome: miss(ref, MentionMiss.Gone) };
  return { outcome: { ...tagOf(ref), result: MentionResult.Read }, folder };
}

/** A genex.games game or tool anyone may take (or the person's own): a fresh read-only copy. */
async function reference(
  ref: MentionRef,
  slug: string,
  target: MentionTarget,
  sources: MentionSources,
): Promise<Resolved> {
  const world = await sources.world(slug);
  const own = world.authorId !== null && world.authorId === (await sources.me().catch(() => null));
  if (!(world.remixable || own) || !world.cloneUrl) return { outcome: miss(ref, MentionMiss.NotTakeable) };
  const refs = path.join(target.gameDir, REFS_DIR);
  const dest = path.join(refs, slug);
  const fresh = path.join(refs, `.${slug}-${Date.now().toString(36)}`);
  await mkdir(refs, { recursive: true });
  try {
    await sources.clone(world.cloneUrl, fresh);
    // A reference is read, never committed to: the author's history stays theirs.
    await rm(path.join(fresh, ".git"), { recursive: true, force: true });
    await rm(dest, { recursive: true, force: true });
    await rename(fresh, dest);
  } catch {
    await rm(fresh, { recursive: true, force: true });
    return { outcome: miss(ref, MentionMiss.NotDownloaded) };
  }
  const relative = toPosixRelative(path.relative(target.gameDir, dest));
  return { outcome: { ...tagOf(ref), result: MentionResult.Copied, path: relative } };
}

/** An asset's module, written into the game under a name no file has yet. */
async function asset(ref: MentionRef, slug: string, target: MentionTarget, sources: MentionSources): Promise<Resolved> {
  if (!target.webGame) return { outcome: miss(ref, MentionMiss.NotWebGame) };
  const found = assetModule(await sources.assetManifest(slug));
  if (!found) return { outcome: miss(ref, MentionMiss.NotDownloaded) };
  const dir = path.join(target.gameDir, ASSETS_DIR);
  await mkdir(dir, { recursive: true });
  const name = await freeName(dir, found.filename);
  await atomicWriteText(path.join(dir, name), ASSET_HEADER + found.code);
  return {
    outcome: { ...tagOf(ref), result: MentionResult.Added, path: `${ASSETS_DIR}/${name}` },
    ...(found.usage ? { usage: found.usage } : {}),
  };
}

/** The module an asset manifest carries, when it is one a game may take. */
export function assetModule(body: unknown): { code: string; filename: string; usage?: string } | null {
  const manifest = field(body, "manifest");
  const source = field(manifest, "source");
  const code = field(source, "code");
  const filename = field(source, "filename");
  if (typeof code !== "string" || code.length === 0) return null;
  if (Buffer.byteLength(code) > ASSET_MODULE_MAX_BYTES) return null;
  if (typeof filename !== "string" || !MODULE_NAME.test(filename)) return null;
  const usage = field(field(manifest, "usage"), "promptHint");
  return { code, filename, ...(typeof usage === "string" && usage ? { usage: usage.slice(0, 600) } : {}) };
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** `name`, or `name-2.ts`, `name-3.ts`… when the game already has a file of that name. */
async function freeName(dir: string, name: string): Promise<string> {
  const taken = new Set(await readdir(dir).catch(() => [] as string[]));
  const ext = path.extname(name);
  const stem = name.slice(0, -ext.length);
  let candidate = name;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${stem}-${n}${ext}`;
  return candidate;
}
