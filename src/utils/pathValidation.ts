import * as path from "path";

/**
 * Injectable environment for validateWorkflowPath so both platforms'
 * semantics are unit-testable on any host. Production callers omit this and
 * get the real host platform, path implementation, env, and cwd.
 */
export interface PathValidationDeps {
  /** Path implementation to use (path.win32 or path.posix). */
  pathImpl?: path.PlatformPath;
  /** Platform whose dangerous-directory rules apply. */
  platform?: NodeJS.Platform;
  /** Environment variables (SystemRoot, ProgramFiles, ...). */
  env?: Record<string, string | undefined>;
  /** Base directory for resolving drive-relative/rooted paths. */
  cwd?: string;
}

/** POSIX system directories that must never be used as save/load targets. */
const POSIX_DANGEROUS_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/sys",
  "/proc",
  "/var/run",
  "/System",
  "/Library",
];

/** Convert backslashes to forward slashes and strip trailing slashes. */
function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Windows system directories that must never be used as save/load targets.
 * Derived from the environment (SystemRoot/SystemDrive/ProgramFiles/...) with
 * C:-based fallbacks, so machines with a non-standard system drive are still
 * covered. Returned in normalized forward-slash form without trailing slash.
 */
function getWin32DangerousPrefixes(
  env: Record<string, string | undefined>
): string[] {
  const systemDrive = normalizeSlashes(env.SystemDrive || "C:");
  const candidates = [
    env.SystemRoot || env.windir || `${systemDrive}/Windows`,
    env.ProgramFiles || `${systemDrive}/Program Files`,
    env["ProgramFiles(x86)"] || `${systemDrive}/Program Files (x86)`,
    env.ProgramW6432,
    env.ProgramData || `${systemDrive}/ProgramData`,
  ];

  const seen = new Set<string>();
  const prefixes: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeSlashes(candidate);
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      prefixes.push(normalized);
    }
  }
  return prefixes;
}

/**
 * True when checkPath IS the prefix directory or a child of it (never a
 * sibling like "C:/Windows-backup"). Both arguments must already be in
 * normalized forward-slash form without trailing slashes.
 */
function isUnderPrefix(
  checkPath: string,
  prefix: string,
  caseInsensitive: boolean
): boolean {
  const a = caseInsensitive ? checkPath.toLowerCase() : checkPath;
  const b = caseInsensitive ? prefix.toLowerCase() : prefix;
  return a === b || a.startsWith(b + "/");
}

/**
 * Validates a workflow directory path to prevent path traversal attacks.
 * Ensures the path is absolute, doesn't contain traversal sequences,
 * and doesn't point to dangerous system directories.
 *
 * The dangerous-directory blocklist is platform-aware and evaluated against
 * the resolved path:
 * - win32: SystemRoot (C:\Windows), Program Files, Program Files (x86),
 *   ProgramData — case-insensitive, matching the directory itself or its
 *   children only (siblings like C:\Windows-backup stay allowed). Device
 *   paths (\\?\, \\.\) are stripped and admin shares (\\host\c$\) mapped to
 *   their drive form before the check; 8.3 short-name segments (PROGRA~1)
 *   are rejected outright since they alias long names below string level.
 * - POSIX: /etc, /usr, /bin, /sbin, /sys, /proc, /var/run, /System, /Library.
 *
 * Supports:
 * - Standard paths: C:\Users\..., /home/user/...
 * - UNC paths: \\server\share\... or //server/share/...
 * - Mapped network drives: Z:\Projects\...
 */
export function validateWorkflowPath(
  inputPath: string,
  deps: PathValidationDeps = {}
): {
  valid: boolean;
  resolved: string;
  error?: string;
} {
  const pathImpl = deps.pathImpl ?? path;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const isWindows = platform === "win32";

  // Must be an absolute path
  if (!pathImpl.isAbsolute(inputPath)) {
    return {
      valid: false,
      resolved: inputPath,
      error: "Path must be absolute",
    };
  }

  // Normalize to forward slashes for consistent comparison
  const normalized = normalizeSlashes(inputPath);
  const isUNC = normalized.startsWith("//");

  // Forward-slash form of the resolved path (kept with trailing content as
  // path.resolve produces it; trailing slashes are only stripped for the
  // comparison below).
  const resolvedSlashes = isUNC
    ? normalized
    : pathImpl.resolve(cwd, inputPath).replace(/\\/g, "/");

  if (isUNC) {
    // For UNC paths (//server/share/...), path.resolve() strips the leading //
    // which makes the comparison fail. Instead, just check for traversal sequences.
    if (/\/\.\.\/|\/\.\.$/.test(normalized)) {
      return {
        valid: false,
        resolved: normalized,
        error: "Path contains traversal sequences",
      };
    }
  } else {
    // For standard paths, resolve and compare to catch .. traversal
    const resolvedForCompare = resolvedSlashes.replace(/\/+$/, "");
    if (resolvedForCompare !== normalized) {
      return {
        valid: false,
        resolved: resolvedForCompare,
        error: "Path contains traversal sequences",
      };
    }
  }

  // Block known dangerous system directories, evaluated against the resolved
  // path (which for non-UNC paths equals the normalized input at this point).
  let checkPath = isUNC ? normalized : resolvedSlashes.replace(/\/+$/, "");
  if (isWindows) {
    // Windows device-path prefixes (\\?\C:\... or \\.\C:\...) address the
    // same location as the plain path; strip them so the blocklist applies.
    checkPath = checkPath.replace(/^\/\/[?.]\//, "");

    // Admin shares (\\host\c$\...) address the target drive directly; map to
    // the drive-letter form so the system-directory blocklist applies.
    const adminShare = checkPath.match(/^\/\/[^/]+\/([a-zA-Z])\$(\/.*)?$/);
    if (adminShare) {
      checkPath = `${adminShare[1]}:${adminShare[2] ?? ""}`.replace(/\/+$/, "");
    }

    // 8.3 short names (PROGRA~1) alias long names at the filesystem level, so
    // a string-prefix blocklist can't soundly see through them — reject them.
    const shortNameSegment = checkPath
      .split("/")
      .find((seg) => /~\d+(\.[^./]*)?$/.test(seg));
    if (shortNameSegment) {
      return {
        valid: false,
        resolved: checkPath,
        error: `Windows 8.3 short names are not allowed (${shortNameSegment})`,
      };
    }
  }

  const dangerousPrefixes = isWindows
    ? getWin32DangerousPrefixes(env)
    : POSIX_DANGEROUS_PREFIXES;

  for (const prefix of dangerousPrefixes) {
    if (isUnderPrefix(checkPath, prefix, isWindows)) {
      return {
        valid: false,
        resolved: checkPath,
        error: `Access to ${prefix} is not allowed`,
      };
    }
  }

  return {
    valid: true,
    resolved: resolvedSlashes,
  };
}
