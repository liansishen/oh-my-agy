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
  isRuntimeInterpreterPath,
  parseSha256Sums,
  parseUpdateArgs,
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
