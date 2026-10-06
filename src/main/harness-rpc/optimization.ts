/** Harness RPC: optimization candidates, which have registered, isolated source authority. */
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { git } from "../../substrate/snapshots.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { PromotionOutcome } from "../../substrate/game-candidate.ts";

/** Why an optimization call from the harness is refused. */
const MESSAGE = {
  unknownBaseline: "unknown baseline snapshot",
  unknownGameBaseline: "unknown game baseline snapshot",
} as const;

export function optimizationRpc(core: StudioCore, x: CoreInternals) {
  return {
    // Optimization has registered, isolated source authority; never arbitrary caller roots.
    [HostMethod.OptimizationBaseline]: async (p) => {
      const snapshot = core.snapshotIndex.get(p.snapshotId);
      if (!snapshot?.git.game) throw new Error(MESSAGE.unknownBaseline);
      return {
        snapshotId: snapshot.snapshot_id,
        commit: snapshot.git.game,
        tree: (await git(core.snapshots.dirFor(p.project), ["rev-parse", `${snapshot.git.game}^{tree}`])).trim(),
      };
    },
    [HostMethod.OptimizationOpen]: async (p) => {
      const baseline = core.snapshotIndex.get(p.baselineSnapshotId);
      if (!baseline?.git.game) throw new Error(MESSAGE.unknownGameBaseline);
      return core.candidates.open(p.project, p.runId, p.baselineSnapshotId, baseline.git.game);
    },
    [HostMethod.OptimizationFreeze]: async (p) => core.candidates.freeze(p.candidateId),
    [HostMethod.OptimizationPromote]: async (p) => {
      const result = await core.candidates.promote(
        p.candidateId,
        p.expectedLive,
        p.verifiedCandidate,
        await x.previews.runFile(p.resultArtifact),
      );
      if (result.outcome === PromotionOutcome.Promoted)
        core.emit(UiEvent.GameChanged, { project: (await core.candidates.get(p.candidateId)).project });
      return result;
    },
    [HostMethod.OptimizationReconcile]: async (p) => core.candidates.reconcile(p.project, p.baseline, p.candidate),
    [HostMethod.OptimizationClose]: async (p) => {
      // A candidate's two copies each may have run a game backend instance: stopped before they go.
      const candidate = await core.candidates.get(p.candidateId).catch(() => null);
      if (candidate)
        await Promise.all([candidate.root, candidate.baselineRoot].map((root) => core.backends.discard(root)));
      return core.candidates.close(p.candidateId);
    },
  } satisfies Partial<HarnessHostHandlers>;
}
