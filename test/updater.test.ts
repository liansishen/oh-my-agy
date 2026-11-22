import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareSemver,
  detectHostArch,
  IMAGE_FILE_MACHINE_AMD64,
  IMAGE_FILE_MACHINE_ARM64,
  IMAGE_FILE_MACHINE_I386,
  isRuntimeInterpreterPath,
  mapWindowsMachineToNodeArch,
  parseSha256Sums,
  parseUpdateArgs,
  queryWindowsNativeMachine,
  replaceExecutableSafely,
  resolveReleaseAssetName,
  runUpdateCommand,
  sha256Hex,
  UpdateCliParseError,
} from '../src/app/updater';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oma-updater-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createStreamCapture() {
  let out = '';
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      },
    },
    text: () => out,
  };
}

describe('oma update — SemVer, asset mapping, SHA256 & argument parsing', () => {
  test('compareSemver orders stable and prerelease versions accurately', () => {
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('v0.1.1', '0.1.0')).toBeGreaterThan(0);
    expect(compareSemver('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareSemver('0.2.0', '0.2.0-rc.1')).toBeGreaterThan(0);
    expect(compareSemver('0.2.0-beta.2', '0.2.0-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('0.1.0', '0.2.0')).toBeLessThan(0);
  });

  test('resolveReleaseAssetName maps supported OS/arch pairs', () => {
    expect(resolveReleaseAssetName('win32', 'x64')).toBe('oma-windows-x64.exe');
    expect(resolveReleaseAssetName('win32', 'arm64')).toBe('oma-windows-arm64.exe');
    expect(resolveReleaseAssetName('linux', 'x64')).toBe('oma-linux-x64');
    expect(resolveReleaseAssetName('linux', 'arm64')).toBe('oma-linux-arm64');
    expect(resolveReleaseAssetName('darwin', 'arm64')).toBe('oma-darwin-arm64');
    expect(resolveReleaseAssetName('darwin', 'x64')).toBe('oma-darwin-x64');
    expect(resolveReleaseAssetName('freebsd', 'x64')).toBeNull();
  });

  test('parseSha256Sums parses GNU coreutils & BSD checksum lines', () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'B'.repeat(64);
    const parsed = parseSha256Sums(
      `# comment\n${hashA}  oma-linux-x64\n${hashB} *./oma-windows-x64.exe\n`,
    );
    expect(parsed.get('oma-linux-x64')).toBe(hashA);
    expect(parsed.get('oma-windows-x64.exe')).toBe('b'.repeat(64));
  });

  test('parseUpdateArgs validates flags and env defaults', () => {
    const opts = parseUpdateArgs(['--check', '--force', '--version=0.2.0', '--repo', 'foo/bar'], {});
    expect(opts).toEqual({
      check: true,
      force: true,
      help: false,
      version: 'v0.2.0',
      repo: 'foo/bar',
    });

    const fromEnv = parseUpdateArgs([], { OMA_REPO: 'alice/oma-fork' });
    expect(fromEnv.repo).toBe('alice/oma-fork');

    expect(() => parseUpdateArgs(['--repo', 'not-a-repo'], {})).toThrow(UpdateCliParseError);
    expect(() => parseUpdateArgs(['--unknown'], {})).toThrow(UpdateCliParseError);
  });

  test('isRuntimeInterpreterPath protects bun/node binaries from accidental overwrite', () => {
    expect(isRuntimeInterpreterPath('C:\\Users\\me\\bun.exe')).toBe(true);
    expect(isRuntimeInterpreterPath('/usr/local/bin/bun')).toBe(true);
    expect(isRuntimeInterpreterPath('/usr/bin/node')).toBe(true);
    expect(isRuntimeInterpreterPath('C:\\Users\\me\\AppData\\Local\\Programs\\oma\\oma.exe')).toBe(false);
    expect(isRuntimeInterpreterPath('/root/.local/bin/oma')).toBe(false);
  });
});

describe('oma update — end-to-end download, SHA256 verification & binary replacement', () => {
  test('--check reports available update without modifying binary', async () => {
    const tmp = makeTempDir();
    const targetExe = join(tmp, 'oma.exe');
    writeFileSync(targetExe, 'old-binary');
    const stdout = createStreamCapture();
    const stderr = createStreamCapture();

    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.2.0',
          html_url: 'https://github.com/liansishen/oh-my-agy/releases/tag/v0.2.0',
          assets: [
            {
              name: 'oma-windows-x64.exe',
              browser_download_url: 'https://downloads.test/oma-windows-x64.exe',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;

    const code = await runUpdateCommand(['--check'], {
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      execPath: targetExe,
      env: {},
      fetch: mockFetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toContain('Update available: v0.1.0 -> v0.2.0');
    expect(readFileSync(targetExe, 'utf8')).toBe('old-binary');
    expect(stderr.text()).toBe('');
  });

  test('downloads binary, verifies SHA256, and replaces Windows exe cleanly', async () => {
    const tmp = makeTempDir();
    const targetExe = join(tmp, 'oma.exe');
    writeFileSync(targetExe, 'old-v0.1.0');

    const newPayload = new TextEncoder().encode('new-v0.2.0-binary-content');
    const expectedHash = sha256Hex(newPayload);

    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.2.0',
            html_url: 'https://github.com/liansishen/oh-my-agy/releases/tag/v0.2.0',
            assets: [
              {
                name: 'oma-windows-x64.exe',
                browser_download_url: 'https://downloads.test/oma-windows-x64.exe',
              },
              {
                name: 'SHA256SUMS.txt',
                browser_download_url: 'https://downloads.test/SHA256SUMS.txt',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('oma-windows-x64.exe')) {
        return new Response(newPayload, { status: 200 });
      }
      if (url.endsWith('SHA256SUMS.txt')) {
        return new Response(`${expectedHash}  oma-windows-x64.exe\n`, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const stdout = createStreamCapture();
    const stderr = createStreamCapture();

    const code = await runUpdateCommand([], {
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      execPath: targetExe,
      env: {},
      fetch: mockFetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toContain('Verified SHA256');
    expect(stdout.text()).toContain('Updated oma: v0.1.0 -> v0.2.0');
    expect(readFileSync(targetExe, 'utf8')).toBe('new-v0.2.0-binary-content');
    expect(existsSync(`${targetExe}.old`)).toBe(false);
    expect(stderr.text()).toBe('');
  });

  test('aborts update and preserves existing binary on SHA256 mismatch', async () => {
    const tmp = makeTempDir();
    const targetExe = join(tmp, 'oma');
    writeFileSync(targetExe, 'safe-original');

    const badPayload = new TextEncoder().encode('tampered-bytes');
    const wrongHash = '0'.repeat(64);

    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.2.0',
            html_url: 'https://github.com/liansishen/oh-my-agy/releases/tag/v0.2.0',
            assets: [
              { name: 'oma-linux-x64', browser_download_url: 'https://downloads.test/oma-linux-x64' },
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://downloads.test/SHA256SUMS.txt' },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('oma-linux-x64')) return new Response(badPayload, { status: 200 });
      if (url.endsWith('SHA256SUMS.txt')) return new Response(`${wrongHash}  oma-linux-x64\n`, { status: 200 });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const stdout = createStreamCapture();
    const stderr = createStreamCapture();

    const code = await runUpdateCommand([], {
      currentVersion: '0.1.0',
      platform: 'linux',
      arch: 'x64',
      execPath: targetExe,
      env: {},
      fetch: mockFetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(1);
    expect(stderr.text()).toContain('SHA256 checksum mismatch');
    expect(readFileSync(targetExe, 'utf8')).toBe('safe-original');
  });

  test('aborts update and preserves existing binary when SHA256SUMS.txt is missing, fails to download, or omits the asset', async () => {
    const scenarios = [
      {
        name: 'missing SHA256SUMS.txt asset',
        assets: [{ name: 'oma-linux-x64', browser_download_url: 'https://downloads.test/oma-linux-x64' }],
        sumsResponse: null as Response | null,
        expectedErr: 'missing required SHA256SUMS.txt',
      },
      {
        name: 'SHA256SUMS.txt HTTP 500',
        assets: [
          { name: 'oma-linux-x64', browser_download_url: 'https://downloads.test/oma-linux-x64' },
          { name: 'SHA256SUMS.txt', browser_download_url: 'https://downloads.test/SHA256SUMS.txt' },
        ],
        sumsResponse: new Response('server error', { status: 500 }),
        expectedErr: 'failed to download SHA256SUMS.txt',
      },
      {
        name: 'SHA256SUMS.txt missing entry for asset',
        assets: [
          { name: 'oma-linux-x64', browser_download_url: 'https://downloads.test/oma-linux-x64' },
          { name: 'SHA256SUMS.txt', browser_download_url: 'https://downloads.test/SHA256SUMS.txt' },
        ],
        sumsResponse: new Response(`${'a'.repeat(64)}  oma-darwin-arm64\n`, { status: 200 }),
        expectedErr: 'does not contain a checksum entry',
      },
    ];

    for (const sc of scenarios) {
      const tmp = makeTempDir();
      const targetExe = join(tmp, 'oma');
      writeFileSync(targetExe, 'safe-original');
      const mockFetch = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/releases/latest')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v0.9.0',
              html_url: 'https://github.com/liansishen/oh-my-agy/releases/tag/v0.9.0',
              assets: sc.assets,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('oma-linux-x64')) return new Response('new-binary', { status: 200 });
        if (url.endsWith('SHA256SUMS.txt') && sc.sumsResponse) return sc.sumsResponse;
        return new Response('not found', { status: 404 });
      }) as unknown as typeof globalThis.fetch;

      const stdout = createStreamCapture();
      const stderr = createStreamCapture();
      const code = await runUpdateCommand([], {
        currentVersion: '0.1.0',
        platform: 'linux',
        arch: 'x64',
        execPath: targetExe,
        env: {},
        fetch: mockFetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(code, sc.name).toBe(1);
      expect(stderr.text(), sc.name).toContain(sc.expectedErr);
      expect(readFileSync(targetExe, 'utf8'), sc.name).toBe('safe-original');
    }
  });

  test('win32 arm64 prefers native asset, refuses x64 fallback without Windows 11 emulation, and falls back to x64 even on HTTP 429 rate limit', async () => {
    const x64Bytes = new TextEncoder().encode('verified-x64-payload');
    const x64Hash = sha256Hex(x64Bytes);

    // 1) Windows 10 ARM64 (build 19045 < 22000, no x64 emulation) MUST refuse x64 fallback and keep original binary
    const tmpWin10 = makeTempDir();
    const exeWin10 = join(tmpWin10, 'oma.exe');
    writeFileSync(exeWin10, 'working-arm64-orig');
    let downloadedX64OnWin10 = false;
    const mockFetchWin10 = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.9.1',
            html_url: 'https://github.com/liansishen/oh-my-agy/releases/tag/v0.9.1',
            assets: [
              { name: 'oma-windows-x64.exe', browser_download_url: 'https://downloads.test/oma-windows-x64.exe' },
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://downloads.test/SHA256SUMS.txt' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('SHA256SUMS.txt')) return new Response(`${x64Hash}  oma-windows-x64.exe\n`, { status: 200 });
      if (url.endsWith('oma-windows-x64.exe')) {
        downloadedX64OnWin10 = true;
        return new Response(x64Bytes, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const stdout10 = createStreamCapture();
    const stderr10 = createStreamCapture();
    const code10 = await runUpdateCommand([], {
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'arm64',
      osRelease: '10.0.19045',
      execPath: exeWin10,
      env: {},
      fetch: mockFetchWin10,
      stdout: stdout10.stream,
      stderr: stderr10.stream,
    });
    expect(code10).toBe(1);
    expect(downloadedX64OnWin10).toBe(false);
    expect(stderr10.text()).toContain('Windows 11');
    expect(readFileSync(exeWin10, 'utf8')).toBe('working-arm64-orig');

    // 2) Windows 11 ARM64 (build 22631) under GitHub REST API HTTP 429 rate limit:
    // discovers actual published x64 asset from SHA256SUMS.txt without 404ing on missing ARM64 asset!
    const tmpWin11 = makeTempDir();
    const exeWin11 = join(tmpWin11, 'oma.exe');
    writeFileSync(exeWin11, 'old-arm64');
    let requestedMissingArm64 = false;
    const mockFetch429 = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://api.github.com/')) {
        return new Response('too many requests', { status: 429 });
      }
      if (url === 'https://github.com/liansishen/oh-my-agy/releases/latest') {
        const res = new Response('', { status: 200 });
        Object.defineProperty(res, 'url', {
          value: 'https://github.com/liansishen/oh-my-agy/releases/tag/v0.9.2',
        });
        return res;
      }
      if (url.endsWith('/v0.9.2/SHA256SUMS.txt')) {
        return new Response(`${x64Hash}  oma-windows-x64.exe\n`, { status: 200 });
      }
      if (url.endsWith('/v0.9.2/oma-windows-arm64.exe')) {
        requestedMissingArm64 = true;
        return new Response('not found', { status: 404 });
      }
      if (url.endsWith('/v0.9.2/oma-windows-x64.exe')) {
        return new Response(x64Bytes, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const stdout11 = createStreamCapture();
    const stderr11 = createStreamCapture();
    const code11 = await runUpdateCommand([], {
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'arm64',
      osRelease: '10.0.22631',
      execPath: exeWin11,
      env: {},
      fetch: mockFetch429,
      stdout: stdout11.stream,
      stderr: stderr11.stream,
    });

    expect(code11).toBe(0);
    expect(requestedMissingArm64).toBe(false);
    expect(stdout11.text()).toContain('falling back to oma-windows-x64.exe');
    expect(readFileSync(exeWin11, 'utf8')).toBe('verified-x64-payload');

    // 3) Emulated x64 binary (`arch: 'x64'`) running on Windows ARM64 host (`PROCESSOR_ARCHITEW6432=ARM64`):
    // automatically detects host ARM64 and upgrades cleanly back to native `oma-windows-arm64.exe`!
    const tmpUpgrade = makeTempDir();
    const exeEmulated = join(tmpUpgrade, 'oma.exe');
    writeFileSync(exeEmulated, 'old-emulated-x64');
    const arm64Bytes = new TextEncoder().encode('native-arm64-binary');
    const arm64Hash = sha256Hex(arm64Bytes);
    const mockFetchNativeArm64 = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v1.0.0',
            html_url: 'https://github.com/liansishen/oh-my-agy/releases/tag/v1.0.0',
            assets: [
              { name: 'oma-windows-arm64.exe', browser_download_url: 'https://downloads.test/oma-windows-arm64.exe' },
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://downloads.test/SHA256SUMS.txt' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('SHA256SUMS.txt')) return new Response(`${arm64Hash}  oma-windows-arm64.exe\n`, { status: 200 });
      if (url.endsWith('oma-windows-arm64.exe')) return new Response(arm64Bytes, { status: 200 });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    // 3) Fallback when Win32 native probe is unavailable (`null`): `PROCESSOR_ARCHITEW6432=ARM64`
    // detects host ARM64 and upgrades cleanly back to native `oma-windows-arm64.exe`.
    const stdoutNative = createStreamCapture();
    const stderrNative = createStreamCapture();
    const codeNative = await runUpdateCommand([], {
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      env: { PROCESSOR_ARCHITEW6432: 'ARM64' },
      probeWin32NativeMachine: () => null,
      execPath: exeEmulated,
      fetch: mockFetchNativeArm64,
      stdout: stdoutNative.stream,
      stderr: stderrNative.stream,
    });
    expect(codeNative).toBe(0);
    expect(readFileSync(exeEmulated, 'utf8')).toBe('native-arm64-binary');

    // 4) Windows 11 Prism x64 emulation on Snapdragon / ARM64 where `PROCESSOR_ARCHITEW6432`
    // is UNSET: `IsWow64Process2` reports `IMAGE_FILE_MACHINE_ARM64` (`0xAA64`), so the updater
    // still selects and installs the native `oma-windows-arm64.exe` even when no x64 asset exists!
    const tmpPrism = makeTempDir();
    const exePrism = join(tmpPrism, 'oma.exe');
    writeFileSync(exePrism, 'old-prism-x64');
    const stdoutPrism = createStreamCapture();
    const stderrPrism = createStreamCapture();
    const codePrism = await runUpdateCommand([], {
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      env: { PROCESSOR_ARCHITECTURE: 'AMD64' },
      probeWin32NativeMachine: () => IMAGE_FILE_MACHINE_ARM64,
      execPath: exePrism,
      fetch: mockFetchNativeArm64,
      stdout: stdoutPrism.stream,
      stderr: stderrPrism.stream,
    });
    expect(codePrism).toBe(0);
    expect(readFileSync(exePrism, 'utf8')).toBe('native-arm64-binary');

    // 5) Authoritative Win32 probe MUST NOT be overridden by a conflicting `PROCESSOR_ARCHITEW6432`:
    // when `IsWow64Process2` reports `IMAGE_FILE_MACHINE_AMD64`, env spoofing `ARM64` must NOT
    // download or install an ARM64 binary onto an x64 host!
    const tmpAmd64 = makeTempDir();
    const exeAmd64 = join(tmpAmd64, 'oma.exe');
    writeFileSync(exeAmd64, 'real-x64-binary');
    const stdoutAmd64 = createStreamCapture();
    const stderrAmd64 = createStreamCapture();
    const codeAmd64 = await runUpdateCommand([], {
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      env: { PROCESSOR_ARCHITEW6432: 'ARM64' },
      probeWin32NativeMachine: () => IMAGE_FILE_MACHINE_AMD64,
      execPath: exeAmd64,
      fetch: mockFetchNativeArm64,
      stdout: stdoutAmd64.stream,
      stderr: stderrAmd64.stream,
    });
    expect(codeAmd64).toBe(1);
    expect(stderrAmd64.text()).toContain('oma-windows-x64.exe');
    expect(readFileSync(exeAmd64, 'utf8')).toBe('real-x64-binary');

    // Direct helper verification + live Win32 FFI sanity check on Windows hosts
    expect(mapWindowsMachineToNodeArch(IMAGE_FILE_MACHINE_ARM64)).toBe('arm64');
    expect(mapWindowsMachineToNodeArch(IMAGE_FILE_MACHINE_AMD64)).toBe('x64');
    expect(mapWindowsMachineToNodeArch(IMAGE_FILE_MACHINE_I386)).toBe('ia32');
    expect(
      detectHostArch('win32', 'x64', {}, () => IMAGE_FILE_MACHINE_ARM64),
    ).toBe('arm64');
    expect(
      detectHostArch('win32', 'x64', { PROCESSOR_ARCHITEW6432: 'ARM64' }, () => IMAGE_FILE_MACHINE_AMD64),
    ).toBe('x64');
    expect(
      detectHostArch('win32', 'ia32', {}, () => IMAGE_FILE_MACHINE_AMD64),
    ).toBe('x64');
    if (process.platform === 'win32') {
      const liveMachine = queryWindowsNativeMachine();
      expect(liveMachine).not.toBeNull();
      expect(mapWindowsMachineToNodeArch(liveMachine!)).not.toBeNull();
    }
  });

  test('falls back to github.com/releases/latest redirect when API returns 403 rate limit', async () => {
    const tmp = makeTempDir();
    const targetExe = join(tmp, 'oma');
    writeFileSync(targetExe, 'v0.1.0');
    const newBytes = new TextEncoder().encode('v0.3.0-linux');
    const digest = sha256Hex(newBytes);

    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://api.github.com/')) {
        return new Response('rate limit exceeded', { status: 403 });
      }
      if (url === 'https://github.com/liansishen/oh-my-agy/releases/latest') {
        const res = new Response('', { status: 200 });
        Object.defineProperty(res, 'url', {
          value: 'https://github.com/liansishen/oh-my-agy/releases/tag/v0.3.0',
        });
        return res;
      }
      if (url.endsWith('/v0.3.0/oma-linux-x64')) {
        return new Response(newBytes, { status: 200 });
      }
      if (url.endsWith('/v0.3.0/SHA256SUMS.txt')) {
        return new Response(`${digest}  oma-linux-x64\n`, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const stdout = createStreamCapture();
    const stderr = createStreamCapture();

    const code = await runUpdateCommand([], {
      currentVersion: '0.1.0',
      platform: 'linux',
      arch: 'x64',
      execPath: targetExe,
      env: {},
      fetch: mockFetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(readFileSync(targetExe, 'utf8')).toBe('v0.3.0-linux');
    expect(stdout.text()).toContain('Updated oma: v0.1.0 -> v0.3.0');
  });

  test('refuses to overwrite bun runtime binary when run from source', async () => {
    const stdout = createStreamCapture();
    const stderr = createStreamCapture();

    const code = await runUpdateCommand([], {
      currentVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\bun.exe',
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(1);
    expect(stderr.text()).toContain('refusing to overwrite');
  });

  test('replaceExecutableSafely replaces target binary directly when called on POSIX path', () => {
    const tmp = makeTempDir();
    const realBin = join(tmp, 'real-oma');
    writeFileSync(realBin, 'old');
    const installed = replaceExecutableSafely(
      realBin,
      new TextEncoder().encode('new'),
      process.platform,
    );
    expect(installed).toBe(realBin);
    expect(readFileSync(realBin, 'utf8')).toBe('new');

    // On POSIX (or Windows with symlink permission), verify symlink target preservation
    if (process.platform !== 'win32') {
      const linkPath = join(tmp, 'link-oma');
      symlinkSync(realBin, linkPath);
      const updated = replaceExecutableSafely(
        linkPath,
        new TextEncoder().encode('via-link'),
        'linux',
      );
      expect(updated).toBe(realBin);
      expect(readFileSync(realBin, 'utf8')).toBe('via-link');
    }
  });
});
