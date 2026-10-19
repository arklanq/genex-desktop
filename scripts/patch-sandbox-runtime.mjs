/** Local, version-guarded fixes to SRT 0.0.73, applied at install and build time.
 *
 * 1. An absolute executable needs no subprocess PATH lookup. SRT otherwise runs `which /bin/bash`
 *    with a one-second timeout and reports a present shell as missing under load.
 * 2. Windows `initialize()` runs srt-win without holding the event loop. SRT spawns its egress
 *    check (seconds on a fresh process) and the folder grants and deny stamps (which scale with
 *    the folders) with `spawnSync`; on Electron's main thread that froze the start window into
 *    "Not Responding". The same srt-win calls run through SRT's own `runSrtWinAsync` instead.
 * 3. Those steps report how long they took (`setStudioStepLog`), so Genex's log shows which part
 *    of a slow start the time went to.
 *
 * Policy generation, arguments and outcomes are untouched. */
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const require = createRequire(import.meta.url);

/** `original` with each [from, to] replaced once; a `from` found other than once means SRT changed. */
function replaceOnce(original, edits, what) {
  let fixed = original;
  for (const [from, to] of edits) {
    if (fixed.split(from).length !== 2) throw new Error(`${what} changed; the sandbox patch requires review`);
    fixed = fixed.replace(from, to);
  }
  return fixed;
}

/** Apply `patch` to `file` (relative to SRT's `dist`) unless `marker` shows it was applied. */
async function patchFile(dist, file, marker, patch) {
  const target = path.join(dist, file);
  const original = await readFile(target, "utf8");
  if (original.includes(marker)) return;
  await writeFile(target, patch(original));
}

const WHICH_MARKER = "// Studio: absolute executable lookup";
const ASYNC_MARKER = "// Studio: srt-win off the event loop";

/**
 * The async twins of SRT's `grantWindowsAcl` and `stampWindowsAcl` (same arguments, same errors),
 * and the step log they and the egress check report to.
 */
const ACL_ASYNC = `
${ASYNC_MARKER}: initialize() grants and stamps through these.
let studioStepLog;
/** Genex's log of how long each srt-win step of initialize took: \`(step, ms)\`. */
export function setStudioStepLog(log) {
    studioStepLog = log;
}
function studioStep(step, started) {
    studioStepLog?.(step, Date.now() - started);
}
export async function grantWindowsAclAsync(opts) {
    const holder = opts.holderPid ?? process.pid;
    const stdin = JSON.stringify({ read: opts.read, write: opts.write });
    const started = Date.now();
    const r = await runSrtWinAsync(['acl', 'grant', '--holder-pid', \`\${holder}\`, '--sandbox-user-sid', opts.sandboxUserSid], { timeoutMs: 60000, stdin, srtWin: opts.srtWin });
    studioStep('acl grant', started);
    logForDebugging(\`[Sandbox Windows] acl grant exit=\${r.status}: \${r.stderr || r.stdout}\`);
    if (r.status !== 0) {
        throw new WindowsSandboxError('acl_grant_failed', \`srt-win acl grant exited \${r.status}: \${r.stderr || r.stdout}\`);
    }
}
export async function stampWindowsAclAsync(opts) {
    const holder = opts.holderPid ?? process.pid;
    const stdin = JSON.stringify({ denyRead: opts.denyRead, denyWrite: opts.denyWrite });
    const started = Date.now();
    const r = await runSrtWinAsync(['acl', 'stamp', '--holder-pid', \`\${holder}\`, '--sandbox-user-sid', opts.sandboxUserSid], { timeoutMs: 60000, stdin, srtWin: opts.srtWin });
    studioStep('acl stamp', started);
    logForDebugging(\`[Sandbox Windows] acl stamp exit=\${r.status}: \${r.stderr || r.stdout}\`);
    if (r.status !== 0) {
        throw new WindowsSandboxError('acl_stamp_failed', \`srt-win acl stamp exited \${r.status} \` +
            (r.status === 2 ? '(partial — some inputs skipped)' : '(failed)') +
            \`: \${r.stderr || r.stdout}\`);
    }
}
`;

export async function patchSandboxRuntime() {
  const pkg = require.resolve("@anthropic-ai/sandbox-runtime/package.json");
  const metadata = JSON.parse(await readFile(pkg, "utf8"));
  if (metadata.version !== "0.0.73")
    throw new Error("Review the sandbox-runtime patches before changing sandbox-runtime version");
  const dist = path.join(path.dirname(pkg), "dist");
  await patchFile(dist, "utils/which.js", WHICH_MARKER, (original) => {
    const marker = "export function whichSync(bin) {";
    return (
      "import { accessSync, statSync, constants } from 'node:fs';\nimport { isAbsolute } from 'node:path';\n" +
      replaceOnce(
        original,
        [
          [
            marker,
            `${marker}
    ${WHICH_MARKER} must not depend on a timed subprocess.
    if (isAbsolute(bin)) {
        try { accessSync(bin, constants.X_OK); return statSync(bin).isFile() ? bin : null; }
        catch { return null; }
    }`,
          ],
        ],
        "Sandbox executable lookup",
      )
    );
  });
  await patchFile(dist, "sandbox/windows-sandbox-utils.js", ASYNC_MARKER, (original) => {
    const verify = "const r = runSrtWin(['wfp', 'verify', '--target', target], {";
    const fixed = replaceOnce(
      original,
      [
        [
          verify,
          `${ASYNC_MARKER}: the egress check.\n        const started = Date.now();\n        const r = await runSrtWinAsync(['wfp', 'verify', '--target', target], {`,
        ],
        [
          "logForDebugging(`[Sandbox Windows] wfp verify exit=",
          "studioStep('wfp verify', started);\n        logForDebugging(`[Sandbox Windows] wfp verify exit=",
        ],
      ],
      "srt-win's egress check",
    );
    return `${fixed}${ACL_ASYNC}`;
  });
  await patchFile(dist, "sandbox/sandbox-manager.js", ASYNC_MARKER, (original) =>
    replaceOnce(
      original,
      [
        [
          "stampWindowsAcl, restoreWindowsAcl, grantWindowsAcl, revokeWindowsAcl,",
          "stampWindowsAcl, restoreWindowsAcl, grantWindowsAcl, revokeWindowsAcl, grantWindowsAclAsync, stampWindowsAclAsync,",
        ],
        [
          "                grantWindowsAcl({",
          `                ${ASYNC_MARKER}.\n                await grantWindowsAclAsync({`,
        ],
        ["                stampWindowsAcl({", "                await stampWindowsAclAsync({"],
      ],
      "SandboxManager's Windows initialize",
    ),
  );
  await patchFile(
    dist,
    "index.js",
    ASYNC_MARKER,
    (original) =>
      `${original}\n${ASYNC_MARKER}.\nexport { grantWindowsAclAsync, stampWindowsAclAsync, setStudioStepLog } from './sandbox/windows-sandbox-utils.js';\n`,
  );
}
