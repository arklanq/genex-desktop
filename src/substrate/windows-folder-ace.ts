/**
 * The sandbox user's read-attributes entry on one folder, set or taken back on that folder alone.
 * It allows SYNCHRONIZE too: CreateFileW adds it to every synchronous open, and Node's stat opens
 * the folder that way on Windows before 11 24H2 (no GetFileInformationByName), so an entry with
 * read attributes alone refused the harness's realpath with EPERM on `AppData`.
 *
 * `icacls`, like every call that sets a folder's DACL by name or handle (SetNamedSecurityInfo,
 * SetSecurityInfo, PowerShell's Set-Acl), re-propagates the folder's inheritable entries to
 * everything under it, even when the entry it adds is not inheritable. A grant on `AppData` walked
 * all of it (1.6 s per 10,000 files on a hosted runner, 16 ms on an empty folder) and held each
 * folder open while it did, so removing a folder in there failed meanwhile. `SetFileSecurityW`
 * writes the one folder's DACL and nothing else, which is all an entry without inheritance needs.
 * Node cannot call it, so one Windows PowerShell run per batch does, through a P/Invoke defined
 * at run time (no compiler). Where PowerShell may not do that (Constrained Language Mode), or
 * does not answer, the batch falls back to `icacls`: slow, but the same entries.
 */
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";

const run = promisify(execFile);

/** What one edit does to the sandbox user's entry on its folder. */
export const FolderAceOp = {
  /** Allow FILE_READ_ATTRIBUTES and SYNCHRONIZE, without inheritance: merged into an explicit allow it already has. */
  Grant: "grant",
  /** Remove every explicit allow for the SID, as `icacls /remove:g` does; its denies stay. */
  Remove: "remove",
} as const;
export type FolderAceOp = (typeof FolderAceOp)[keyof typeof FolderAceOp];

/** One change to one folder's own DACL. */
export interface FolderAceEdit {
  dir: string;
  sid: string;
  op: FolderAceOp;
}

/** What became of one edit: done, or the reason Windows refused it. */
export type FolderAceOutcome = { ok: true } | { ok: false; error: string };

/** Applies edits in order and answers one outcome per edit; never throws. */
export type FolderAceEditor = (edits: readonly FolderAceEdit[]) => Promise<FolderAceOutcome[]>;
/** {@link FolderAceEditor} for process exit, when nothing asynchronous runs any more. */
export type FolderAceEditorSync = (edits: readonly FolderAceEdit[]) => FolderAceOutcome[];

const MESSAGE = {
  /** A refusal the script gave no words for. */
  Refused: "refused",
} as const;

/** How long one PowerShell batch or one `icacls` call may take. */
const TOOL_TIMEOUT_MS = 15 * SECOND_MS;
/** The variable that hands a batch to the script: base64 of its UTF-8 JSON, so no console code page touches a path. */
const EDITS_ENV = "GENEX_FOLDER_ACES";

/**
 * Edits each folder's DACL through GetFileSecurityW and SetFileSecurityW, which touch that folder
 * only. The DACL is edited as raw entries, never through .NET's canonicalizing ACL classes, so an
 * order srt-win or anyone else chose survives. Writes one JSON outcome per edit, as UTF-8 bytes.
 */
export const FOLDER_ACE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${EDITS_ENV})) | ConvertFrom-Json
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'GenexFolderAce'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$type = $assembly.DefineDynamicModule('GenexFolderAce').DefineType('GenexFolderAce', 'Public, Class')
$import = [Runtime.InteropServices.DllImportAttribute]
$fields = [Reflection.FieldInfo[]]@($import.GetField('SetLastError'), $import.GetField('CharSet'))
$values = [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode)
foreach ($native in @(
    @('GetFileSecurityW', [Type[]]@([string], [int], [byte[]], [int], [int].MakeByRefType())),
    @('SetFileSecurityW', [Type[]]@([string], [int], [byte[]])))) {
  $method = $type.DefineMethod($native[0], 'Public, Static, PinvokeImpl', [bool], $native[1])
  $attribute = New-Object Reflection.Emit.CustomAttributeBuilder($import.GetConstructor([Type[]]@([string])), [object[]]@('advapi32.dll'), [Reflection.PropertyInfo[]]@(), [object[]]@(), $fields, $values)
  $method.SetCustomAttribute($attribute)
}
$api = $type.CreateType()
$DACL = 4
# FILE_READ_ATTRIBUTES | SYNCHRONIZE
$READ_ATTRIBUTES = 0x100080
# Read the call's error before anything else runs: a function call or a variable lookup in
# between makes PowerShell's own calls, which overwrite it.
function Refused($code) { New-Object ComponentModel.Win32Exception ([int]$code) }
function ExplicitAllow($ace, $sid) {
  ($ace -is [Security.AccessControl.QualifiedAce]) -and (-not $ace.IsInherited) -and
    ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed) -and ($ace.SecurityIdentifier -eq $sid)
}
function Grant($acl, $sid) {
  for ($i = 0; $i -lt $acl.Count; $i++) {
    $ace = $acl[$i]
    if ((ExplicitAllow $ace $sid) -and $ace.AceFlags -eq [Security.AccessControl.AceFlags]::None) {
      if (($ace.AccessMask -band $READ_ATTRIBUTES) -eq $READ_ATTRIBUTES) { return $false }
      $ace.AccessMask = $ace.AccessMask -bor $READ_ATTRIBUTES
      $acl[$i] = $ace
      return $true
    }
  }
  $at = 0
  while ($at -lt $acl.Count -and -not $acl[$at].IsInherited -and "$($acl[$at].AceType)" -like '*Denied*') { $at++ }
  $acl.InsertAce($at, (New-Object Security.AccessControl.CommonAce([Security.AccessControl.AceFlags]::None, [Security.AccessControl.AceQualifier]::AccessAllowed, $READ_ATTRIBUTES, $sid, $false, $null)))
  return $true
}
function Remove($acl, $sid) {
  $changed = $false
  for ($i = $acl.Count - 1; $i -ge 0; $i--) {
    if (ExplicitAllow $acl[$i] $sid) { $acl.RemoveAce($i); $changed = $true }
  }
  return $changed
}
function Edit($edit) {
  $needed = 0
  $ok = $api::GetFileSecurityW($edit.dir, $DACL, $null, 0, [ref]$needed); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($needed -le 0) { throw (Refused $code) }
  $bytes = New-Object byte[] $needed
  $ok = $api::GetFileSecurityW($edit.dir, $DACL, $bytes, $needed, [ref]$needed); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if (-not $ok) { throw (Refused $code) }
  $sd = New-Object Security.AccessControl.RawSecurityDescriptor($bytes, 0)
  $acl = $sd.DiscretionaryAcl
  if ($null -eq $acl) { return }
  $sid = New-Object Security.Principal.SecurityIdentifier ([string]$edit.sid)
  $changed = if ($edit.op -eq '${FolderAceOp.Grant}') { Grant $acl $sid } else { Remove $acl $sid }
  if (-not $changed) { return }
  $sd.DiscretionaryAcl = $acl
  $out = New-Object byte[] $sd.BinaryLength
  $sd.GetBinaryForm($out, 0)
  $ok = $api::SetFileSecurityW($edit.dir, $DACL, $out); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if (-not $ok) { throw (Refused $code) }
}
$outcomes = foreach ($edit in @($request)) {
  try { Edit $edit; @{ ok = $true } } catch { @{ ok = $false; error = $_.Exception.Message } }
}
$json = ConvertTo-Json -InputObject @($outcomes) -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
`;

/** Windows PowerShell by its full path: a folder on PATH must not stand in for it. */
function powershell(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The PowerShell command line and environment that run one batch. */
export function folderAceCommand(edits: readonly FolderAceEdit[], env: NodeJS.ProcessEnv = process.env) {
  const script = Buffer.from(FOLDER_ACE_SCRIPT, "utf16le").toString("base64");
  const payload = Buffer.from(JSON.stringify(edits), "utf8").toString("base64");
  return {
    file: powershell(env),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script],
    env: { ...env, [EDITS_ENV]: payload },
  };
}

/** The script's answer, when it is one outcome per edit; anything else is null. */
export function folderAceOutcomes(stdout: string, count: number): FolderAceOutcome[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length !== count) return null;
    return parsed.map((item: unknown): FolderAceOutcome => {
      const answer = typeof item === "object" && item !== null ? item : {};
      if ("ok" in answer && answer.ok === true) return { ok: true };
      return { ok: false, error: "error" in answer ? String(answer.error) : MESSAGE.Refused };
    });
  } catch {
    return null;
  }
}

/** The `icacls` arguments that make the same change, walking everything under the folder. */
export function icaclsArgs(edit: FolderAceEdit): string[] {
  return edit.op === FolderAceOp.Grant
    ? [edit.dir, "/grant", `*${edit.sid}:(S,RA)`]
    : [edit.dir, "/remove:g", `*${edit.sid}`];
}

/** A failed icacls call's own words: Node's message names only the command, icacls writes to stdout. */
function icaclsFailure(error: unknown): string {
  const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout).trim() : "";
  return [errorMessage(error), stdout].filter(Boolean).join(": ");
}

/** What an editor runs; each default is the real program, with `env` (default: this process's). */
export interface FolderAceTools {
  env?: NodeJS.ProcessEnv;
  /** Runs PowerShell and answers what it wrote; rejects when it fails or does not finish. */
  powershell?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
  /** Runs `icacls`; rejects with its output when it fails. */
  icacls?: (args: string[]) => Promise<void>;
}

async function runPowerShell(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const running = run(file, args, { env, timeout: TOOL_TIMEOUT_MS, windowsHide: true, encoding: "utf8" });
  // PowerShell may wait for its input to end before it exits; it reads none.
  running.child.stdin?.end();
  return (await running).stdout;
}

async function runIcacls(args: string[]): Promise<void> {
  await run("icacls", args, { timeout: TOOL_TIMEOUT_MS, windowsHide: true });
}

/** Each edit through `icacls`, one call each. */
async function viaIcacls(icacls: (args: string[]) => Promise<void>, edits: readonly FolderAceEdit[]) {
  const outcomes: FolderAceOutcome[] = [];
  for (const edit of edits) {
    try {
      await icacls(icaclsArgs(edit));
      outcomes.push({ ok: true });
    } catch (error) {
      outcomes.push({ ok: false, error: icaclsFailure(error) });
    }
  }
  return outcomes;
}

/** An editor that runs one PowerShell batch, and `icacls` for the batch when PowerShell cannot. */
export function folderAceEditor(tools: FolderAceTools = {}): FolderAceEditor {
  const powershellRun = tools.powershell ?? runPowerShell;
  const icacls = tools.icacls ?? runIcacls;
  return async (edits) => {
    if (edits.length === 0) return [];
    const command = folderAceCommand(edits, tools.env);
    const stdout = await powershellRun(command.file, command.args, command.env).catch(() => "");
    return folderAceOutcomes(stdout, edits.length) ?? viaIcacls(icacls, edits);
  };
}

/** {@link folderAceEditor} for process exit, with the real programs. */
export function folderAceEditorSync(env: NodeJS.ProcessEnv = process.env): FolderAceEditorSync {
  return (edits) => {
    if (edits.length === 0) return [];
    const command = folderAceCommand(edits, env);
    const options = { env: command.env, timeout: TOOL_TIMEOUT_MS, windowsHide: true } as const;
    try {
      const stdout = execFileSync(command.file, command.args, {
        ...options,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const outcomes = folderAceOutcomes(stdout, edits.length);
      if (outcomes) return outcomes;
    } catch {
      /* PowerShell could not run the batch: icacls below */
    }
    return edits.map((edit): FolderAceOutcome => {
      try {
        execFileSync("icacls", icaclsArgs(edit), { ...options, stdio: "pipe" });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: icaclsFailure(error) };
      }
    });
  };
}

/** The editor the sandbox uses. */
export const editFolderAces: FolderAceEditor = folderAceEditor();
/** The editor the sandbox uses on process exit. */
export const editFolderAcesSync: FolderAceEditorSync = folderAceEditorSync();
