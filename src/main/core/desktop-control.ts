/**
 * The studio's hold on computer control: whether a desktop driver is installed, the desktop
 * sessions running now, and the one switch that stops them all (the global stop shortcut and the
 * app's quit). Every `desktop` tool a delegation is handed is made here, so nothing drives the
 * person's computer that this registry cannot stop.
 */
import type { DesktopApp, DesktopDriver } from "../../substrate/desktop-driver.ts";
import { type DesktopQuestion, type DesktopTools, type DesktopToolsDeps, desktopTools } from "./desktop-tools.ts";

/** What the model reads when no driver is installed. */
const MESSAGE = { noDriver: "no cua-driver is bundled or installed" } as const;

/** How computer control is reached on this machine. */
export interface DesktopControlOptions {
  /** The installed driver, or null when there is none (or this platform has no desktop control yet). */
  findDriver: () => Promise<string | null>;
  /** Start a driver session over the installed binary. */
  connect: (binary: string) => Promise<DesktopDriver>;
  /** Whether an app is the studio itself: never driven, so no agent can answer its own consent card. */
  ownApp: (app: DesktopApp) => boolean;
  /** Drive a VM's desktop rather than this Mac's (`GENEX_COMPUTER_VM`): every app inside it is the VM's. */
  vm?: boolean;
  /** Told how many sessions hold the computer, whenever it changes: the stop shortcut lives while any do. */
  onActive?: (count: number) => void;
  /** Stop what runs the driver once no session holds it: the app's own embedded daemon. */
  shutdown?: () => Promise<void>;
}

/** One session's desktop: where its frames go, how its person is asked, and what its screen shows. */
export type DesktopSessionDeps = Pick<
  DesktopToolsDeps,
  "frameDir" | "frame" | "downscale" | "maxActions" | "enabled" | "engineApps"
> & {
  ask: (question: DesktopQuestion, app?: DesktopApp) => Promise<boolean>;
};

/** The registry: what is installed, what is running, and how to stop it all. */
export function desktopControl(options: DesktopControlOptions) {
  const running = new Set<DesktopTools>();
  let found: Promise<string | null> | null = null;
  const binary = () => {
    found ??= options.findDriver().catch(() => null);
    return found;
  };
  return {
    /** Whether computer control can be offered here: a driver is installed. */
    available: async (): Promise<boolean> => (await binary()) !== null,
    /** The `desktop` tool for one session, stopped with it or by {@link stopAll}. */
    toolsFor: (deps: DesktopSessionDeps): DesktopTools => {
      // A session holds the computer from the moment its driver is connected until it is released.
      const hold = (held: DesktopTools) => {
        running.add(held);
        options.onActive?.(running.size);
      };
      const tools = desktopTools({
        ...deps,
        ownApp: options.ownApp,
        ...(options.vm ? { vm: true } : {}),
        connect: async () => {
          const path = await binary();
          if (!path) throw new Error(MESSAGE.noDriver);
          const driver = await options.connect(path);
          hold(held);
          return driver;
        },
      });
      const held: DesktopTools = {
        ...tools,
        release: async () => {
          if (running.delete(held)) options.onActive?.(running.size);
          await tools.release();
        },
      };
      return held;
    },
    /** How many desktop sessions are holding the computer now. */
    active: (): number => running.size,
    /** Stop every desktop session at once: the person's stop, or the app quitting. */
    stopAll: async (): Promise<void> => {
      const all = [...running];
      running.clear();
      options.onActive?.(0);
      await Promise.all(all.map((tools) => tools.release().catch(() => {})));
      await options.shutdown?.().catch(() => {});
    },
    /** Look for the driver again (after the person installs it). */
    rescan: (): void => {
      found = null;
    },
  };
}

/** The studio's computer-control registry. */
export type DesktopControl = ReturnType<typeof desktopControl>;
