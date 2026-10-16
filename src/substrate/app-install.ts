/**
 * Installing a Mac app for the person from an engine plugin's setup card (Unity Hub, Godot): its
 * download with the bytes counted for the card, the check that its maker signed it (Apple accepts
 * the signature and it names the maker's team) before anything is copied, and its copy into
 * Applications under another name first, renamed only once whole, so a half-copied app never reads
 * as installed. Programs run through the caller's runner, so tests stand in for each one.
 */
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { MINUTE_MS } from "../shared/duration.ts";

/** How long checking a signature or copying an app may take. */
export const APP_COPY_MS = 5 * MINUTE_MS;

/** Runs a program and answers what it printed and on its error stream; rejects when it fails. */
export type AppRunner = (command: string, args: string[], timeoutMs: number) => Promise<{ out: string; err: string }>;

/** Why an app download or copy failed. Wire values: never rename one. */
export const AppInstallProblem = { Download: "download", NotSigned: "not-signed", Copy: "copy" } as const;
export type AppInstallProblem = (typeof AppInstallProblem)[keyof typeof AppInstallProblem];

/** A failed download or copy, with what the person reads. */
export class AppInstallError extends Error {
  readonly problem: AppInstallProblem;
  constructor(problem: AppInstallProblem, detail: string) {
    super(detail);
    this.problem = problem;
  }
}

/** Downloads `url` into `file`, telling `onBytes` how far it got; a stop through `signal` ends it. */
export async function downloadFile(
  fetcher: typeof fetch,
  url: string,
  file: string,
  options: { signal: AbortSignal; onBytes: (done: number, total: number | undefined) => void },
): Promise<void> {
  const fail = (error: unknown) => {
    throw new AppInstallError(AppInstallProblem.Download, error instanceof Error ? error.message : String(error));
  };
  const response = await fetcher(url, { signal: options.signal }).catch(fail);
  if (!response.ok || !response.body) throw new AppInstallError(AppInstallProblem.Download, `HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || undefined;
  let done = 0;
  options.onBytes(done, total);
  const body = Readable.fromWeb(response.body as WebReadableStream);
  body.on("data", (chunk: Buffer) => {
    done += chunk.length;
    options.onBytes(done, total);
  });
  await pipeline(body, createWriteStream(file), { signal: options.signal }).catch(fail);
  options.onBytes(total ?? done, total);
}

/** Whether an app is signed by `team`: Apple accepts its signature and the signature names that team. */
export async function signedByTeam(run: AppRunner, app: string, team: string): Promise<boolean> {
  try {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], APP_COPY_MS);
    // codesign describes a signature on its error stream.
    const described = await run("/usr/bin/codesign", ["-dv", app], APP_COPY_MS);
    return described.err.split(/\r?\n/).includes(`TeamIdentifier=${team}`);
  } catch {
    return false;
  }
}

/**
 * Copies a checked app into `applications` as `name`: beside under another name first, renamed only
 * once whole. Refused, with nothing copied, unless `team` signed it.
 */
export async function placeApp(
  run: AppRunner,
  app: string,
  place: { applications: string; name: string; team: string },
): Promise<void> {
  if (!(await signedByTeam(run, app, place.team))) throw new AppInstallError(AppInstallProblem.NotSigned, place.name);
  const partial = path.join(place.applications, `.${place.name}.genex-copy`);
  await rm(partial, { recursive: true, force: true });
  try {
    await run("/usr/bin/ditto", [app, partial], APP_COPY_MS);
    await rename(partial, path.join(place.applications, place.name));
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw new AppInstallError(AppInstallProblem.Copy, error instanceof Error ? error.message : String(error));
  }
}

/**
 * A made-up Mac a development test points an engine plugin at (its `Applications` and `home`), so an
 * engine's setup card can be tried in the real app on a computer that has the engine; the host
 * passes it to plugin backends (`substrate/plugins/process.ts`). Never set for a person.
 */
export const ENGINE_TEST_ROOT = "STUDIO_ENGINE_TEST_ROOT";

/** The made-up Mac's folders under {@link ENGINE_TEST_ROOT}, when a development test names an absolute one on a Mac. */
export function engineTestMac(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { applications: string; home: string } | undefined {
  const root = env[ENGINE_TEST_ROOT];
  if (!root || !path.posix.isAbsolute(root) || platform !== "darwin") return undefined;
  return { applications: path.posix.join(root, "Applications"), home: path.posix.join(root, "home") };
}
