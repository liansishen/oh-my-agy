/**
 * Windows `/D:/...` 及 `File /D:/...` 路径标准化、跨平台目录对比与 RFC 8089 file:/// URI 转换。
 * 对齐 docs/DESIGN.md 4.2.5。
 */

import path from "node:path";

const DEFAULT_IS_WINDOWS = process.platform === "win32";

/** 匹配 Windows 前导斜杠盘符路径，如 `/D:/Projects/oh-my-agy` 或 `/d:` */
const WIN_LEADING_SLASH_DRIVE_RE = /^\/([A-Za-z]:(?:[\\/].*)?)$/;

/** 匹配常规 Windows 盘符路径，如 `D:/Projects/...` 或 `D:\Projects\...` */
const WIN_DRIVE_PATH_RE = /^[A-Za-z]:(?:[\\/].*)?$/;

/**
 * 匹配工具标题中嵌有 Windows 前导斜杠路径的格式，
 * 如 `File /D:/Projects/oh-my-agy/README.md`、`Read /D:/a/b.ts` 等。
 * 排除含 `:` 的前缀（避免误匹配 `file:///D:/...` URI）。
 */
const WIN_TITLE_PREFIX_SLASH_DRIVE_RE =
  /^([^/\\:\r\n]+?\s+)\/([A-Za-z]:(?:[\\/].*)?)$/;

/**
 * 将 agy acp 返回的路径或工具标题标准化为当前平台展示格式。
 * - Windows：剥离 `/D:/...` 及 `File /D:/...` 的前导 `/`，并将路径中的 `/` 转换为 `\`；
 * - Linux / macOS：原样保留。
 */
export function normalizeDisplayPath(
  raw: string,
  isWin: boolean = DEFAULT_IS_WINDOWS,
): string {
  if (!raw || !isWin) {
    return raw;
  }

  const leadingMatch = WIN_LEADING_SLASH_DRIVE_RE.exec(raw);
  if (leadingMatch && leadingMatch[1]) {
    return leadingMatch[1].replace(/\//g, "\\");
  }

  if (WIN_DRIVE_PATH_RE.test(raw)) {
    return raw.replace(/\//g, "\\");
  }

  const titleMatch = WIN_TITLE_PREFIX_SLASH_DRIVE_RE.exec(raw);
  if (titleMatch && titleMatch[1] && titleMatch[2]) {
    return `${titleMatch[1]}${titleMatch[2].replace(/\//g, "\\")}`;
  }

  return raw;
}

/** 内部规范化目录路径用于比较 */
function canonicalizeDir(dir: string, isWin: boolean): string {
  const trimmed = dir.trim();
  if (!trimmed) {
    return "";
  }

  if (isWin) {
    // 1. 去掉 Windows 前导斜杠 `/D:/...` 并统一分隔符为 `\`
    let normalized = normalizeDisplayPath(trimmed, true).replace(/\//g, "\\");
    // 2. 单独的盘符 `D:` 补齐根分隔符 `D:\` 便于与 `D:\` 一致对比
    if (/^[A-Za-z]:$/.test(normalized)) {
      normalized += "\\";
    }
    // 3. 解析 `.`、`..` 与重复分隔符
    normalized = path.win32.normalize(normalized);
    // 4. 去掉非根目录末尾的 `\`（保留 `D:\` 或 UNC 根）
    while (
      normalized.length > 1 &&
      normalized.endsWith("\\") &&
      !/^[A-Za-z]:\\$/.test(normalized) &&
      !/^\\\\[^\\]+\\[^\\]+\\$/.test(normalized)
    ) {
      normalized = normalized.slice(0, -1);
    }
    return normalized.toLowerCase();
  }

  let normalized = path.posix.normalize(trimmed);
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * 跨平台目录相等性判断：
 * - 先标准化路径（含剥离 Windows `/D:/...` 前导斜杠与末尾分隔符）；
 * - Windows 大小写不敏感；Linux/macOS 大小写敏感。
 */
export function sameDir(
  a: string,
  b: string,
  isWin: boolean = DEFAULT_IS_WINDOWS,
): boolean {
  const ca = canonicalizeDir(a, isWin);
  const cb = canonicalizeDir(b, isWin);
  if (!ca || !cb) {
    return false;
  }
  return ca === cb;
}

/** 对 URI 单个路径段执行 RFC 3986 编码 */
function encodeUriSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 将本地路径可靠转换为 RFC 8089 `file:///` URI（供 ACP `resource` / `resource_link` 块使用）。
 * 支持 Windows 盘符路径（含 `/D:/...` 与 `D:\...`）、UNC 路径与 POSIX 绝对路径。
 */
export function toFileUri(
  inputPath: string,
  isWin: boolean = DEFAULT_IS_WINDOWS,
): string {
  const trimmed = inputPath.trim();
  if (/^file:\/\//i.test(trimmed)) {
    return trimmed;
  }

  let target = trimmed;

  // 若是 `/D:/...` 格式，先剥离前导斜杠统一识别为 Windows 盘符路径
  const slashDriveMatch = WIN_LEADING_SLASH_DRIVE_RE.exec(target);
  if (slashDriveMatch && slashDriveMatch[1]) {
    target = slashDriveMatch[1];
  }

  const isWinDrive = /^[A-Za-z]:(?:[\\/]|$)/.test(target);
  const isUnc = target.startsWith("\\\\") || (isWin && target.startsWith("//"));

  if (isWinDrive) {
    const winInput = /^[A-Za-z]:$/.test(target)
      ? `${target}\\`
      : target.replace(/\//g, "\\");
    const normalized = path.win32.normalize(winInput);
    const slashForm = normalized.replace(/\\/g, "/");
    const segments = slashForm.split("/");
    const drive = segments[0] ?? "";
    const rest = segments
      .slice(1)
      .filter((seg, idx, arr) => !(seg === "" && idx === arr.length - 1 && arr.length === 1))
      .map(encodeUriSegment);
    return `file:///${drive}/${rest.join("/")}`.replace(/\/+$/, () =>
      // 保留盘符根路径 file:///D:/
      slashForm.length <= 3 ? "/" : "",
    );
  }

  if (isUnc) {
    const slashForm = target.replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = slashForm.split("/").filter((p) => p.length > 0);
    const host = parts[0] ?? "";
    const rest = parts.slice(1).map(encodeUriSegment);
    return `file://${host}/${rest.join("/")}`;
  }

  // POSIX 绝对路径或相对路径
  let absPath = target;
  if (!absPath.startsWith("/")) {
    absPath = isWin ? path.win32.resolve(target) : path.posix.resolve(target);
    if (/^[A-Za-z]:[\\/]/.test(absPath)) {
      return toFileUri(absPath, true);
    }
  }

  const normalized = path.posix.normalize(absPath);
  const segments = normalized.split("/").map((seg, idx) =>
    idx === 0 ? "" : encodeUriSegment(seg),
  );
  return `file://${segments.join("/")}`;
}

/** 将 `file:///` URI 反向还原为本地路径（辅助用途） */
export function fromFileUri(
  uri: string,
  isWin: boolean = DEFAULT_IS_WINDOWS,
): string {
  if (!/^file:\/\//i.test(uri)) {
    return normalizeDisplayPath(uri, isWin);
  }
  const withoutScheme = uri.slice("file://".length);
  const decoded = decodeURIComponent(withoutScheme);
  if (/^\/[A-Za-z]:(?:\/|$)/.test(decoded)) {
    return isWin ? decoded.slice(1).replace(/\//g, "\\") : decoded;
  }
  if (!decoded.startsWith("/") && isWin) {
    // UNC: file://host/share -> \\host\share
    return `\\\\${decoded.replace(/\//g, "\\")}`;
  }
  return decoded;
}
