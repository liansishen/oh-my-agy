import { unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_TIMEOUT_MS = 3000;

export interface ClipboardImage {
  readonly data: Uint8Array;
  readonly mimeType: 'image/png';
}

export interface ClipboardOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
}

interface ExecResult {
  readonly ok: boolean;
  readonly stdout: Uint8Array;
}

/**
 * Checks whether a byte buffer starts with the standard 8-byte PNG signature.
 */
export function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_MAGIC.byteLength) return false;
  for (let i = 0; i < PNG_MAGIC.byteLength; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Detects whether the current process is running inside an SSH session.
 */
export function isRemoteSshSession(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return Boolean(env['SSH_CONNECTION'] || env['SSH_CLIENT'] || env['SSH_TTY']);
}

/**
 * Detects environments where no local desktop clipboard is reachable
 * (e.g. a pure SSH session on a headless Linux server without X11/Wayland forwarding).
 */
export function isRemoteSshWithoutDisplay(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32' || platform === 'darwin') {
    return false;
  }
  const hasDisplay = Boolean(env['WAYLAND_DISPLAY'] || env['DISPLAY']);
  return !hasDisplay && isRemoteSshSession(env);
}

/**
 * Reports whether local OS clipboard tools can reasonably be queried in this environment.
 */
export function isClipboardAvailable(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32' || platform === 'darwin') {
    return true;
  }
  return Boolean(env['WAYLAND_DISPLAY'] || env['DISPLAY']);
}

async function runCommand(
  cmd: readonly string[],
  options: { stdinText?: string; timeoutMs: number },
): Promise<ExecResult> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    proc = Bun.spawn([...cmd], {
      stdin: options.stdinText !== undefined ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
  } catch {
    return { ok: false, stdout: new Uint8Array(0) };
  }

  try {
    if (options.stdinText !== undefined && proc.stdin && typeof proc.stdin !== 'number') {
      proc.stdin.write(options.stdinText);
      await proc.stdin.end();
    }

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc?.kill();
        } catch {
          // ignore kill failures
        }
        resolve('timeout');
      }, options.timeoutMs);
    });

    const stdoutPromise =
      proc.stdout && typeof proc.stdout !== 'number'
        ? new Response(proc.stdout).bytes()
        : Promise.resolve(new Uint8Array(0));

    const outcome = await Promise.race([
      Promise.all([proc.exited, stdoutPromise]).then(([code, stdout]) => ({
        kind: 'done' as const,
        code,
        stdout,
      })),
      timeoutPromise.then(() => ({ kind: 'timeout' as const })),
    ]);

    if (timedOut || outcome.kind === 'timeout') {
      return { ok: false, stdout: new Uint8Array(0) };
    }

    return { ok: outcome.code === 0, stdout: outcome.stdout };
  } catch {
    return { ok: false, stdout: new Uint8Array(0) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readImageWindows(timeoutMs: number): Promise<ClipboardImage | null> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 0 }',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $img) { exit 0 }',
    '$ms = New-Object System.IO.MemoryStream',
    'try {',
    '  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    '  [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))',
    '} finally {',
    '  $ms.Dispose()',
    '  $img.Dispose()',
    '}',
  ].join('; ');

  const res = await runCommand(
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-Command', script],
    { timeoutMs },
  );
  if (!res.ok || res.stdout.byteLength === 0) return null;

  const base64 = new TextDecoder().decode(res.stdout).trim();
  if (base64.length === 0) return null;

  try {
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    return isPngBytes(bytes) ? { data: bytes, mimeType: 'image/png' } : null;
  } catch {
    return null;
  }
}

async function readImageDarwin(timeoutMs: number): Promise<ClipboardImage | null> {
  // Prefer `pngpaste` when installed (fast, no temp file)
  const pngpaste = await runCommand(['pngpaste', '-'], { timeoutMs });
  if (pngpaste.ok && isPngBytes(pngpaste.stdout)) {
    return { data: pngpaste.stdout, mimeType: 'image/png' };
  }

  // Fallback to AppleScript exporting PNG clipboard class to a temp file
  const tempFile = join(tmpdir(), `oma-clip-${process.pid}-${randomBytes(6).toString('hex')}.png`);
  const escaped = tempFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'try',
    '  set pngData to the clipboard as «class PNGf»',
    `  set outFile to open for access POSIX file "${escaped}" with write permission`,
    '  set eof outFile to 0',
    '  write pngData to outFile',
    '  close access outFile',
    'on error',
    '  try',
    `    close access POSIX file "${escaped}"`,
    '  end try',
    '  error number -128',
    'end try',
  ].join('\n');

  try {
    const res = await runCommand(['osascript', '-e', script], { timeoutMs });
    if (!res.ok) return null;
    const raw = await readFile(tempFile);
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    return isPngBytes(bytes) ? { data: bytes, mimeType: 'image/png' } : null;
  } catch {
    return null;
  } finally {
    await unlink(tempFile).catch(() => {});
  }
}

async function readImageLinux(
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<ClipboardImage | null> {
  if (env['WAYLAND_DISPLAY']) {
    const res = await runCommand(['wl-paste', '--no-newline', '--type', 'image/png'], {
      timeoutMs,
    });
    if (res.ok && isPngBytes(res.stdout)) {
      return { data: res.stdout, mimeType: 'image/png' };
    }
  }

  if (env['DISPLAY']) {
    const res = await runCommand(
      ['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o'],
      { timeoutMs },
    );
    if (res.ok && isPngBytes(res.stdout)) {
      return { data: res.stdout, mimeType: 'image/png' };
    }
  }

  return null;
}

/**
 * Reads a PNG image from the local system clipboard.
 *
 * Gracefully degrades and returns `null` when no image is present, required
 * clipboard tools are unavailable, or running in a headless/pure SSH remote
 * session.
 */
export async function readClipboardImage(
  options: ClipboardOptions = {},
): Promise<ClipboardImage | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!isClipboardAvailable(env, platform)) {
    return null;
  }

  switch (platform) {
    case 'win32':
      return readImageWindows(timeoutMs);
    case 'darwin':
      return readImageDarwin(timeoutMs);
    default:
      return readImageLinux(env, timeoutMs);
  }
}

/**
 * Reads plain UTF-8 text from the local system clipboard.
 * Returns `null` when unavailable, empty, or in a headless/pure SSH remote session.
 */
export async function readClipboardText(
  options: ClipboardOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!isClipboardAvailable(env, platform)) {
    return null;
  }

  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'if (-not [System.Windows.Forms.Clipboard]::ContainsText()) { exit 2 }',
      '[Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText())',
    ].join('; ');
    const res = await runCommand(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { timeoutMs },
    );
    if (!res.ok) return null;
    return new TextDecoder().decode(res.stdout);
  }

  if (platform === 'darwin') {
    const res = await runCommand(['pbpaste'], { timeoutMs });
    if (!res.ok) return null;
    return new TextDecoder().decode(res.stdout);
  }

  if (env['WAYLAND_DISPLAY']) {
    const res = await runCommand(['wl-paste', '--no-newline'], { timeoutMs });
    if (res.ok) return new TextDecoder().decode(res.stdout);
  }

  if (env['DISPLAY']) {
    const xclip = await runCommand(['xclip', '-selection', 'clipboard', '-o'], { timeoutMs });
    if (xclip.ok) return new TextDecoder().decode(xclip.stdout);
    const xsel = await runCommand(['xsel', '--clipboard', '--output'], { timeoutMs });
    if (xsel.ok) return new TextDecoder().decode(xsel.stdout);
  }

  return null;
}

/**
 * Copies UTF-8 text into the local system clipboard.
 * Returns `true` on success, `false` on failure or headless/pure SSH remote sessions.
 */
export async function writeClipboardText(
  text: string,
  options: ClipboardOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!isClipboardAvailable(env, platform)) {
    return false;
  }

  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
      '$t = [Console]::In.ReadToEnd()',
      'if ($t.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetText($t) }',
    ].join('; ');
    const res = await runCommand(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { stdinText: text, timeoutMs },
    );
    return res.ok;
  }

  if (platform === 'darwin') {
    const res = await runCommand(['pbcopy'], { stdinText: text, timeoutMs });
    return res.ok;
  }

  if (env['WAYLAND_DISPLAY']) {
    const res = await runCommand(['wl-copy'], { stdinText: text, timeoutMs });
    if (res.ok) return true;
  }

  if (env['DISPLAY']) {
    const xclip = await runCommand(['xclip', '-selection', 'clipboard'], {
      stdinText: text,
      timeoutMs,
    });
    if (xclip.ok) return true;
    const xsel = await runCommand(['xsel', '--clipboard', '--input'], {
      stdinText: text,
      timeoutMs,
    });
    if (xsel.ok) return true;
  }

  return false;
}
