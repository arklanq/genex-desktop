/**
 * The window's first questions, answered before (and without) a core: where startup stands, Retry
 * and (Windows) Set up from the sandbox setup screen with a report when Set up fails, Try again, a
 * report and Quit when the studio would not start, and the
 * colours of the Windows and Linux title-bar controls (see-through over Home's background on Windows).
 * Registered once per launch, before any window opens.
 */
import { BootPhase } from "../../shared/boot.ts";
import { FEEDBACK_TEXT_MAX_CHARS, type FeedbackDraft, FeedbackScreen } from "../../shared/feedback.ts";
import type { WindowControls } from "../../shared/studio-api.ts";
import type { BootGate } from "../boot-gate.ts";
import type { IpcHandle } from "./registrar.ts";

/** A colour the overlay takes: opaque `#rrggbb`, nothing a CSS parser could read more into. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const MESSAGE = {
  invalidColors: "window controls must be two #rrggbb colours and a see-through flag",
  invalidReport: "a setup report needs the error it is about",
  /** The report's words: the team reads it in the admin panel beside the person's feedback. */
  setupReport: "Windows setup didn't finish (sent from the setup screen).\n\n",
  startReport: "Genex couldn't start (sent from the start screen).\n\n",
} as const;

export interface BootIpcDeps {
  gate: BootGate;
  /** Post a report, as Send feedback does, with what main can gather before a core exists. */
  report(draft: FeedbackDraft): Promise<void>;
  /** Repaint the studio window's title-bar overlay; a no-op where there is none (macOS). */
  setWindowControls(controls: WindowControls): void;
  /** Quit the app, from the screen of a studio that would not start. */
  quit(): void;
}

/** The two colours and the see-through flag the renderer sent, checked; throws on anything else. */
function windowControls(payload: unknown): WindowControls {
  const { color, symbolColor, seeThrough } = (payload ?? {}) as Partial<Record<keyof WindowControls, unknown>>;
  const valid = (value: unknown): value is string => typeof value === "string" && HEX_COLOR.test(value);
  const wellFormed = valid(color) && valid(symbolColor) && typeof seeThrough === "boolean";
  if (!wellFormed) throw new Error(MESSAGE.invalidColors);
  return { color, symbolColor, seeThrough };
}

/**
 * The report a failed Set up (or a studio that would not start, by `phase`) sends: its error, clipped to what a report may hold, and the recent
 * log. The screen is Home's, the only one before a studio exists. Throws on anything but a non-empty error.
 */
export function setupReportDraft(payload: unknown, phase: BootPhase = BootPhase.SandboxSetup): FeedbackDraft {
  const { error } = (payload ?? {}) as { error?: unknown };
  if (typeof error !== "string" || !error.trim()) throw new Error(MESSAGE.invalidReport);
  const lead = phase === BootPhase.Failed ? MESSAGE.startReport : MESSAGE.setupReport;
  const text = (lead + error.trim()).slice(0, FEEDBACK_TEXT_MAX_CHARS);
  return { text, screen: FeedbackScreen.Home, appLogs: true, chatId: null };
}

export function registerBootIpc(handle: IpcHandle, { gate, report, setWindowControls, quit }: BootIpcDeps): void {
  handle("studio:boot", () => gate.state());
  handle("studio:boot.retry", () => gate.retry());
  handle("studio:boot.setup", () => gate.setUp());
  handle("studio:boot.report", (payload) => report(setupReportDraft(payload, gate.state().phase)));
  handle("studio:boot.quit", () => quit());
  handle("studio:window.controls", (payload) => {
    setWindowControls(windowControls(payload));
  });
}
