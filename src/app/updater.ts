import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { release as getOsRelease } from 'node:os';
import { dirname, join } from 'node:path';
import { OMA_VERSION } from './fallback';

export const DEFAULT_OMA_REPO = 'liansishen/oh-my-agy';
export const SHA256SUMS_ASSET_NAME = 'SHA256SUMS.txt';

export interface UpdateCliOptions {
  readonly check: boolean;
  readonly force: boolean;
  readonly help: boolean;
  readonly version?: string;
  readonly repo: string;
  readonly targetPath?: string;
}

export class UpdateCliParseError extends Error {
  override name = 'UpdateCliParseError';
}

export interface ReleaseAsset {
  readonly name: string;
  readonly downloadUrl: string;
}

export interface ReleaseInfo {
  readonly tagName: string;
  readonly version: string;
  readonly htmlUrl: string;
  readonly assets: readonly ReleaseAsset[];
  /** Base download URL used when API metadata was unavailable (HTTP 403/429 fallback). */
  readonly baseDownloadUrl?: string;
  /** True when `assets` were synthesized without GitHub REST API asset listing. */
  readonly assetsSynthesized?: boolean;
}

export interface RunUpdateDeps {
  readonly currentVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Override OS kernel release string (e.g. `10.0.22631` vs `10.0.19045`) for deterministic tests. */
  readonly osRelease?: string;
  /** Override Win32 `IsWow64Process2` native machine query (e.g. `0xAA64` for ARM64) in tests. */
  readonly probeWin32NativeMachine?: () => number | null;
  readonly execPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly stdout?: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
}

export const IMAGE_FILE_MACHINE_I386 = 0x014c;
export const IMAGE_FILE_MACHINE_ARMNT = 0x01c4;
export const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
export const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;

/**
 * Map a Win32 `IMAGE_FILE_MACHINE_*` value (from `IsWow64Process2`) to a Node/Bun arch string.
 */
export function mapWindowsMachineToNodeArch(machine: number): string | null {
  switch (machine) {
    case IMAGE_FILE_MACHINE_ARM64:
      return 'arm64';
    case IMAGE_FILE_MACHINE_AMD64:
      return 'x64';
    case IMAGE_FILE_MACHINE_I386:
      return 'ia32';
    case IMAGE_FILE_MACHINE_ARMNT:
      return 'arm';
    default:
      return null;
  }
}

let cachedWin32NativeMachine: number | null | undefined;

/**
 * Query the true native Windows host machine architecture via `kernel32.dll!IsWow64Process2`.
 * Unlike `PROCESSOR_ARCHITEW6432` (which can be unset under Windows 11 Prism x64 emulation
 * on ARM64 hardware), `IsWow64Process2` always returns the host's native `IMAGE_FILE_MACHINE_*`
 * code (e.g. `0xAA64` on Windows ARM64).
 */
export function queryWindowsNativeMachine(): number | null {
  if (process.platform !== 'win32') return null;
  if (cachedWin32NativeMachine !== undefined) {
    return cachedWin32NativeMachine;
  }
  try {
    const req = createRequire(import.meta.url);
    const ffi = req('bun:ffi') as {
      dlopen: (
        path: string,
        symbols: Record<string, { args: readonly unknown[]; returns: unknown }>,
      ) => {
        symbols: {
          GetCurrentProcess: () => unknown;
          IsWow64Process2: (hProcess: unknown, pProcessMachine: unknown, pNativeMachine: unknown) => boolean;
        };
        close: () => void;
      };
      FFIType: { ptr: unknown; bool: unknown };
      ptr: (buf: ArrayBufferView) => unknown;
    };
    const kernel32 = ffi.dlopen('kernel32.dll', {
      GetCurrentProcess: { args: [], returns: ffi.FFIType.ptr },
      IsWow64Process2: {
        args: [ffi.FFIType.ptr, ffi.FFIType.ptr, ffi.FFIType.ptr],
        returns: ffi.FFIType.bool,
      },
    });
    try {
      const hProcess = kernel32.symbols.GetCurrentProcess();
      const processMachine = new Uint16Array(1);
      const nativeMachine = new Uint16Array(1);
      const ok = kernel32.symbols.IsWow64Process2(
        hProcess,
        ffi.ptr(processMachine),
        ffi.ptr(nativeMachine),
      );
      cachedWin32NativeMachine = ok && nativeMachine[0] ? nativeMachine[0] : null;
    } finally {
      kernel32.close();
    }
  } catch {
    cachedWin32NativeMachine = null;
  }
  return cachedWin32NativeMachine;
}

/**
 * Detect the underlying host CPU architecture (distinct from `process.arch` when
 * an emulated x64 binary runs on a Windows ARM64 host). Uses Win32 `IsWow64Process2`
 * first so Prism x64 emulation on Snapdragon / ARM64 is detected accurately even when
 * `PROCESSOR_ARCHITEW6432` is unset, then falls back to Windows architecture env vars.
 */
export function detectHostArch(
  platform: NodeJS.Platform = process.platform,
  processArch: string = process.arch,
  env: Readonly<Record<string, string | undefined>> = process.env,
  probeWin32NativeMachine?: () => number | null,
): string {
  if (platform === 'win32') {
    const nativeMachine = probeWin32NativeMachine
      ? probeWin32NativeMachine()
      : process.platform === 'win32' && processArch !== 'arm64'
        ? queryWindowsNativeMachine()
        : null;
    const mappedNative = nativeMachine !== null ? mapWindowsMachineToNodeArch(nativeMachine) : null;
    if (mappedNative !== null) {
      return mappedNative;
    }

    const wow64Host = env['PROCESSOR_ARCHITEW6432']?.trim().toUpperCase();
    if (wow64Host === 'ARM64') return 'arm64';
    const procArch = env['PROCESSOR_ARCHITECTURE']?.trim().toUpperCase();
    if (procArch === 'ARM64') return 'arm64';
    if (wow64Host === 'AMD64' && processArch === 'ia32') {
      return 'x64';
    }
  }
  return processArch;
}

/**
 * Determine whether a Windows ARM64 host supports x64 user-mode emulation
 * (introduced in Windows 11, NT build >= 22000).
 */
export function supportsWindowsArm64X64Emulation(osRelease: string = getOsRelease()): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(osRelease.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const build = Number(match[3]);
  if (major > 10) return true;
  return major === 10 && build >= 22000;
}

export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

export function normalizeVersionTag(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('v') || trimmed.startsWith('V') ? `v${trimmed.slice(1)}` : `v${trimmed}`;
}

export function stripVersionPrefix(raw: string): string {
  return raw.trim().replace(/^[vV]/, '');
}

export function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = stripVersionPrefix(raw);
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const pre = match[4]
    ? match[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return { major, minor, patch, prerelease: pre };
}

/**
 * Compare two SemVer strings (`a` vs `b`).
 * Returns `< 0` if `a < b`, `0` if equal, `> 0` if `a > b`.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return stripVersionPrefix(a).localeCompare(stripVersionPrefix(b));
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    if (typeof ai === 'number' && typeof bi === 'number') return ai - bi;
    if (typeof ai === 'number') return -1;
    if (typeof bi === 'number') return 1;
    return ai.localeCompare(bi);
  }
  return 0;
}

/**
 * Map runtime platform + arch to the canonical GitHub Release binary filename.
 */
export function resolveReleaseAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === 'win32') {
    if (arch === 'x64') return 'oma-windows-x64.exe';
    if (arch === 'arm64') return 'oma-windows-arm64.exe';
    return null;
  }
  if (platform === 'linux') {
    if (arch === 'x64') return 'oma-linux-x64';
    if (arch === 'arm64') return 'oma-linux-arm64';
    return null;
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'oma-darwin-arm64';
    if (arch === 'x64') return 'oma-darwin-x64';
    return null;
  }
  return null;
}

/**
 * Detect whether `execPath` points to a runtime interpreter (`bun` / `node`)
 * instead of a compiled standalone `oma` executable.
 */
export function isRuntimeInterpreterPath(execPath: string): boolean {
  const base = execPath.replace(/^.*[\\/]/, '').toLowerCase();
  return (
    base === 'bun' ||
    base === 'bun.exe' ||
    base === 'node' ||
    base === 'node.exe'
  );
}

/**
 * Parse standard `SHA256SUMS.txt` content (`<64-hex>  <filename>` or `*<filename>`).
 */
export function parseSha256Sums(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!match) continue;
    const digest = match[1]!.toLowerCase();
    const filename = match[2]!.trim().replace(/^\.\//, '');
    map.set(filename, digest);
  }
  return map;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').toLowerCase();
}

export function formatUpdateHelpText(): string {
  return [
    'Usage: oma update [flags]',
    '',
    'Check for and install the latest Oh My Agy (oma) release from GitHub.',
    '',
    'Flags:',
    '      --check              Check for available updates without installing',
    '  -f, --force              Reinstall even if already on the latest version',
    '      --version <tag>      Install a specific release tag (e.g. v0.1.0)',
    `      --repo <owner/name>  Override GitHub repository (default: ${DEFAULT_OMA_REPO})`,
    '      --target <path>      Override destination executable path',
    '  -h, --help               Show this help message',
  ].join('\n');
}

export function parseUpdateArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): UpdateCliOptions {
  let check = false;
  let force = false;
  let help = false;
  let version: string | undefined;
  let repo = env['OMA_REPO']?.trim() || DEFAULT_OMA_REPO;
  let targetPath: string | undefined;

  const takeValue = (
    flag: string,
    inlineValue: string | undefined,
    index: number,
  ): [string, number] => {
    if (inlineValue !== undefined) return [inlineValue, index];
    const next = argv[index + 1];
    if (next === undefined) {
      throw new UpdateCliParseError(`Option ${flag} requires a value`);
    }
    return [next, index + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    let flag = arg;
    let inlineValue: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flag = arg.slice(0, eq);
        inlineValue = arg.slice(eq + 1);
      }
    }

    switch (flag) {
      case '--check':
        if (inlineValue !== undefined) {
          throw new UpdateCliParseError(`Option ${flag} does not accept a value`);
        }
        check = true;
        break;
      case '-f':
      case '--force':
        if (inlineValue !== undefined) {
          throw new UpdateCliParseError(`Option ${flag} does not accept a value`);
        }
        force = true;
        break;
      case '-h':
      case '--help':
        if (inlineValue !== undefined) {
          throw new UpdateCliParseError(`Option ${flag} does not accept a value`);
        }
        help = true;
        break;
      case '--version':
      case '--tag': {
        const [val, nextIdx] = takeValue(flag, inlineValue, i);
        version = normalizeVersionTag(val);
        i = nextIdx;
        break;
      }
      case '--repo': {
        const [val, nextIdx] = takeValue(flag, inlineValue, i);
        const trimmed = val.trim();
        if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
          throw new UpdateCliParseError(`Invalid --repo format (expected owner/name): ${val}`);
        }
        repo = trimmed;
        i = nextIdx;
        break;
      }
      case '--target': {
        const [val, nextIdx] = takeValue(flag, inlineValue, i);
        targetPath = val.trim();
        i = nextIdx;
        break;
      }
      default:
        throw new UpdateCliParseError(`Unknown update option: ${arg}`);
    }
  }

  return {
    check,
    force,
    help,
    ...(version ? { version } : {}),
    repo,
    ...(targetPath ? { targetPath } : {}),
  };
}

function buildGithubHeaders(
  currentVersion: string,
  env: Readonly<Record<string, string | undefined>>,
  accept?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': `oma/${stripVersionPrefix(currentVersion)}`,
  };
  if (accept) {
    headers['Accept'] = accept;
  }
  const token = env['OMA_GITHUB_TOKEN']?.trim() || env['GITHUB_TOKEN']?.trim() || env['GH_TOKEN']?.trim();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Fallback tag discovery via `https://github.com/<repo>/releases/latest` redirect
 * when GitHub's unauthenticated REST API rate-limits the client (HTTP 403/429).
 */
async function resolveLatestTagViaRedirect(
  repo: string,
  assetName: string,
  currentVersion: string,
  env: Readonly<Record<string, string | undefined>>,
  fetchFn: typeof globalThis.fetch,
): Promise<ReleaseInfo> {
  const url = `https://github.com/${repo}/releases/latest`;
  const res = await fetchFn(url, {
    method: 'GET',
    redirect: 'follow',
    headers: buildGithubHeaders(currentVersion, env),
  });
  if (!res.ok) {
    throw new Error(`GitHub latest release redirect failed (HTTP ${res.status})`);
  }
  const finalUrl = res.url || url;
  const tagMatch = /\/releases\/tag\/([^/?#]+)/.exec(finalUrl);
  if (!tagMatch || !tagMatch[1]) {
    throw new Error(`Could not determine latest release tag from ${finalUrl}`);
  }
  const tagName = decodeURIComponent(tagMatch[1]);
  const baseDownload = `https://github.com/${repo}/releases/download/${encodeURIComponent(tagName)}`;
  return {
    tagName,
    version: stripVersionPrefix(tagName),
    htmlUrl: finalUrl,
    baseDownloadUrl: baseDownload,
    assetsSynthesized: true,
    assets: [
      { name: assetName, downloadUrl: `${baseDownload}/${assetName}` },
      { name: SHA256SUMS_ASSET_NAME, downloadUrl: `${baseDownload}/${SHA256SUMS_ASSET_NAME}` },
    ],
  };
}

/**
 * Query GitHub Releases for either `latest` or a pinned tag.
 */
export async function fetchReleaseInfo(options: {
  readonly repo: string;
  readonly tag?: string;
  readonly assetName: string;
  readonly currentVersion: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchFn: typeof globalThis.fetch;
}): Promise<ReleaseInfo> {
  const { repo, tag, assetName, currentVersion, env, fetchFn } = options;
  const apiUrl = tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${repo}/releases/latest`;

  const res = await fetchFn(apiUrl, {
    method: 'GET',
    headers: buildGithubHeaders(currentVersion, env, 'application/vnd.github+json'),
  });

  if (res.status === 404) {
    throw new Error(
      tag
        ? `Release ${tag} was not found in https://github.com/${repo}/releases`
        : `No published GitHub Releases found in https://github.com/${repo}/releases`,
    );
  }

  if ((res.status === 403 || res.status === 429) && !tag) {
    return resolveLatestTagViaRedirect(repo, assetName, currentVersion, env, fetchFn);
  }

  if (!res.ok) {
    if (tag) {
      const baseDownload = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
      return {
        tagName: tag,
        version: stripVersionPrefix(tag),
        htmlUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
        baseDownloadUrl: baseDownload,
        assetsSynthesized: true,
        assets: [
          { name: assetName, downloadUrl: `${baseDownload}/${assetName}` },
          { name: SHA256SUMS_ASSET_NAME, downloadUrl: `${baseDownload}/${SHA256SUMS_ASSET_NAME}` },
        ],
      };
    }
    throw new Error(`GitHub API request failed (HTTP ${res.status}): ${res.statusText}`);
  }

  const data = (await res.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
    assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
  };
  const tagName = typeof data.tag_name === 'string' ? data.tag_name.trim() : '';
  if (!tagName) {
    throw new Error('GitHub release metadata missing tag_name');
  }
  const htmlUrl =
    typeof data.html_url === 'string' && data.html_url.trim()
      ? data.html_url.trim()
      : `https://github.com/${repo}/releases/tag/${encodeURIComponent(tagName)}`;

  const assets: ReleaseAsset[] = [];
  if (Array.isArray(data.assets)) {
    for (const a of data.assets) {
      if (typeof a?.name === 'string' && typeof a?.browser_download_url === 'string') {
        assets.push({ name: a.name, downloadUrl: a.browser_download_url });
      }
    }
  }

  return {
    tagName,
    version: stripVersionPrefix(tagName),
    htmlUrl,
    assets,
  };
}

/**
 * Clean up a leftover `<exe>.old` backup left behind by a previous Windows self-update.
 */
export function cleanupStaleWindowsBackup(execPath: string = process.execPath): void {
  if (process.platform !== 'win32') return;
  if (isRuntimeInterpreterPath(execPath)) return;
  const backupPath = `${execPath}.old`;
  try {
    if (existsSync(backupPath)) {
      rmSync(backupPath, { force: true });
    }
  } catch {
    // Best-effort cleanup; ignore if still locked by another process.
  }
}

/**
 * Replace an installed `oma` binary safely on both Windows and Unix:
 * - Resolves symlinks so updating `/usr/local/bin/oma -> ~/.local/bin/oma` replaces
 *   the real target and keeps the symlink intact.
 * - On Windows, moves the currently running `.exe` aside to `<dest>.old` before
 *   moving `<dest>.new` into place, with automatic rollback on failure.
 * - On POSIX, writes to a sibling temp file, `chmod 0o755`, and atomically `renameSync`s.
 */
export function replaceExecutableSafely(
  targetPath: string,
  newBytes: Uint8Array,
  platform: NodeJS.Platform = process.platform,
): string {
  let realTarget = targetPath;
  try {
    if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
      realTarget = realpathSync(targetPath);
    }
  } catch {
    realTarget = targetPath;
  }

  const parentDir = dirname(realTarget);
  mkdirSync(parentDir, { recursive: true });

  const stagingPath = join(
    parentDir,
    platform === 'win32'
      ? `.oma-update-${process.pid}.new.exe`
      : `.oma-update-${process.pid}.tmp`,
  );

  writeFileSync(stagingPath, newBytes);
  if (platform !== 'win32') {
    chmodSync(stagingPath, 0o755);
  }

  if (platform === 'win32') {
    const backupPath = `${realTarget}.old`;
    try {
      if (existsSync(backupPath)) {
        rmSync(backupPath, { force: true });
      }
    } catch {
      // Ignore if an earlier backup is still busy; try another backup name below if needed.
    }

    const hadExisting = existsSync(realTarget);
    let movedOld = false;
    try {
      if (hadExisting) {
        renameSync(realTarget, backupPath);
        movedOld = true;
      }
      renameSync(stagingPath, realTarget);
    } catch (err) {
      if (movedOld && !existsSync(realTarget) && existsSync(backupPath)) {
        try {
          renameSync(backupPath, realTarget);
        } catch {
          // Best-effort rollback
        }
      }
      try {
        if (existsSync(stagingPath)) rmSync(stagingPath, { force: true });
      } catch {
        // Ignore
      }
      throw err;
    }

    // Best-effort immediate removal of backup (will succeed when not self-updating,
    // and otherwise be cleaned up automatically on next startup).
    try {
      if (existsSync(backupPath)) rmSync(backupPath, { force: true });
    } catch {
      // Expected while the old running exe handle is still open on Windows.
    }

    return realTarget;
  }

  try {
    renameSync(stagingPath, realTarget);
    return realTarget;
  } catch (err) {
    try {
      if (existsSync(stagingPath)) rmSync(stagingPath, { force: true });
    } catch {
      // Ignore
    }
    throw err;
  }
}

export async function runUpdateCommand(
  argv: readonly string[],
  deps: RunUpdateDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const env = deps.env ?? process.env;
  const currentVersion = deps.currentVersion ?? OMA_VERSION;
  const platform = deps.platform ?? process.platform;
  const arch = detectHostArch(
    platform,
    deps.arch ?? process.arch,
    env,
    deps.probeWin32NativeMachine,
  );
  const execPath = deps.execPath ?? process.execPath;
  const fetchFn = deps.fetch ?? globalThis.fetch;

  let opts: UpdateCliOptions;
  try {
    opts = parseUpdateArgs(argv, env);
  } catch (err) {
    if (err instanceof UpdateCliParseError) {
      stderr.write(`oma update: ${err.message}\n\n${formatUpdateHelpText()}\n`);
      return 2;
    }
    throw err;
  }

  if (opts.help) {
    stdout.write(`${formatUpdateHelpText()}\n`);
    return 0;
  }

  const assetName = resolveReleaseAssetName(platform, arch);
  if (!assetName) {
    stderr.write(
      `oma update: unsupported platform/architecture (${platform}-${arch}).\n` +
        `Download or build from source at https://github.com/${opts.repo}\n`,
    );
    return 1;
  }

  const destination = opts.targetPath ?? execPath;
  if (!opts.check && isRuntimeInterpreterPath(destination)) {
    stderr.write(
      'oma update: running from source via bun/node runtime; refusing to overwrite the runtime binary.\n' +
        'Update via `git pull`, run `oma update --check`, or install the standalone binary first.\n',
    );
    return 1;
  }

  stdout.write(
    `Checking ${opts.repo} for ${opts.version ? `release ${opts.version}` : 'the latest release'}...\n`,
  );

  let release: ReleaseInfo;
  try {
    release = await fetchReleaseInfo({
      repo: opts.repo,
      tag: opts.version,
      assetName,
      currentVersion,
      env,
      fetchFn,
    });
  } catch (err) {
    stderr.write(
      `oma update: failed to fetch release metadata: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const cmp = compareSemver(release.version, currentVersion);
  const alreadyLatest = !opts.version && cmp <= 0;
  const samePinned = Boolean(opts.version) && compareSemver(release.version, currentVersion) === 0;

  if (opts.check) {
    if (cmp > 0) {
      stdout.write(
        `Update available: v${stripVersionPrefix(currentVersion)} -> ${release.tagName}\n` +
          `Release: ${release.htmlUrl}\n` +
          `Run \`oma update\` to install.\n`,
      );
    } else {
      stdout.write(
        `oma is up to date (current: v${stripVersionPrefix(currentVersion)}, latest: ${release.tagName}).\n`,
      );
    }
    return 0;
  }

  if ((alreadyLatest || samePinned) && !opts.force) {
    stdout.write(
      `oma is already up to date (v${stripVersionPrefix(currentVersion)}). Pass --force to reinstall.\n`,
    );
    return 0;
  }

  // Fetch and parse required SHA256SUMS.txt BEFORE selecting/downloading the binary so that:
  // 1) Even under GitHub REST API 403/429 fallback, we know the exact published asset set.
  // 2) We never download or replace the binary without an authoritative checksum entry.
  const sumsAsset = release.assets.find(a => a.name === SHA256SUMS_ASSET_NAME);
  if (!sumsAsset) {
    stderr.write(
      `oma update: release ${release.tagName} is missing required ${SHA256SUMS_ASSET_NAME}.\n` +
        'Aborting update for safety.\n',
    );
    return 1;
  }

  let sumsText: string;
  try {
    const sumsRes = await fetchFn(sumsAsset.downloadUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: buildGithubHeaders(currentVersion, env),
    });
    if (!sumsRes.ok) {
      throw new Error(`HTTP ${sumsRes.status} ${sumsRes.statusText}`);
    }
    sumsText = await sumsRes.text();
  } catch (err) {
    stderr.write(
      `oma update: failed to download ${SHA256SUMS_ASSET_NAME}: ${err instanceof Error ? err.message : String(err)}\n` +
        'Aborting update for safety.\n',
    );
    return 1;
  }

  const sumsMap = parseSha256Sums(sumsText);

  const resolveAssetEntry = (name: string): ReleaseAsset | undefined => {
    const listed = release.assets.find(a => a.name === name);
    if (listed) return listed;
    if (release.assetsSynthesized && release.baseDownloadUrl && sumsMap.has(name)) {
      return { name, downloadUrl: `${release.baseDownloadUrl}/${name}` };
    }
    return undefined;
  };

  let resolvedAssetName = assetName;
  let binaryAsset =
    (!release.assetsSynthesized || sumsMap.has(assetName))
      ? resolveAssetEntry(assetName)
      : undefined;

  if (!binaryAsset && platform === 'win32' && arch === 'arm64') {
    const x64AssetName = 'oma-windows-x64.exe';
    const x64Candidate =
      (!release.assetsSynthesized || sumsMap.has(x64AssetName))
        ? resolveAssetEntry(x64AssetName)
        : undefined;
    if (x64Candidate && sumsMap.has(x64AssetName)) {
      const osRel = deps.osRelease ?? getOsRelease();
      if (!supportsWindowsArm64X64Emulation(osRel)) {
        stderr.write(
          `oma update: release ${release.tagName} does not publish native "${assetName}", and Windows x64 emulation on ARM64 requires Windows 11 (build >= 22000, detected "${osRel}").\n` +
            'Aborting update to keep the existing binary intact.\n',
        );
        return 1;
      }
      resolvedAssetName = x64Candidate.name;
      binaryAsset = x64Candidate;
      stdout.write(
        `Native ${assetName} not published for ${release.tagName}; falling back to ${resolvedAssetName} (Windows 11 x64 emulation).\n`,
      );
    }
  }

  if (!binaryAsset) {
    stderr.write(
      `oma update: release ${release.tagName} does not contain asset "${assetName}".\n` +
        `Check ${release.htmlUrl}\n`,
    );
    return 1;
  }

  const expected = sumsMap.get(resolvedAssetName);
  if (!expected) {
    stderr.write(
      `oma update: ${SHA256SUMS_ASSET_NAME} does not contain a checksum entry for "${resolvedAssetName}".\n` +
        'Aborting update for safety.\n',
    );
    return 1;
  }

  stdout.write(`Downloading ${binaryAsset.name} (${release.tagName})...\n`);
  let binaryBytes: Uint8Array;
  try {
    const binRes = await fetchFn(binaryAsset.downloadUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: buildGithubHeaders(currentVersion, env, 'application/octet-stream'),
    });
    if (!binRes.ok) {
      throw new Error(`HTTP ${binRes.status} ${binRes.statusText}`);
    }
    binaryBytes = new Uint8Array(await binRes.arrayBuffer());
    if (binaryBytes.byteLength === 0) {
      throw new Error('Downloaded binary is empty (0 bytes)');
    }
  } catch (err) {
    stderr.write(
      `oma update: failed to download ${binaryAsset.name}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const actual = sha256Hex(binaryBytes);
  if (actual !== expected) {
    stderr.write(
      `oma update: SHA256 checksum mismatch for ${resolvedAssetName}!\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${actual}\n` +
        'Aborting update for safety.\n',
    );
    return 1;
  }
  stdout.write(`Verified SHA256 (${actual.slice(0, 12)}...).\n`);

  try {
    const installedPath = replaceExecutableSafely(destination, binaryBytes, platform);
    stdout.write(
      `Updated oma: v${stripVersionPrefix(currentVersion)} -> ${release.tagName}\n` +
        `Installed at: ${installedPath}\n`,
    );
    return 0;
  } catch (err) {
    stderr.write(
      `oma update: failed to replace binary at ${destination}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

/**
 * Helper used in tests or diagnostics to read a file's SHA256 digest.
 */
export function fileSha256Hex(filePath: string): string {
  return sha256Hex(readFileSync(filePath));
}
