import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type PluginEntrypointKind = "file" | "directory" | "any";

const WINDOWS_DRIVE_PATH_PATTERN = /^[a-zA-Z]:/;
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export function isSafePackageRelativeEntrypoint(entrypoint: string): boolean {
  const candidate = entrypoint.trim();
  if (!candidate || candidate.includes("\0")) return false;
  if (
    path.isAbsolute(candidate)
    || candidate.startsWith("/")
    || candidate.startsWith("\\")
    || candidate.startsWith("//")
    || candidate.startsWith("\\\\")
    || WINDOWS_DRIVE_PATH_PATTERN.test(candidate)
    || URL_SCHEME_PATTERN.test(candidate)
  ) {
    return false;
  }

  return candidate
    .replace(/\\/g, "/")
    .split("/")
    .every(segment => segment !== "..");
}

export function isPathWithinDirectory(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function resolvePackageRelativeEntrypoint(packageRoot: string, entrypoint: string): string | null {
  if (!isSafePackageRelativeEntrypoint(entrypoint)) return null;

  const resolvedPackageRoot = path.resolve(packageRoot);
  const resolvedEntrypoint = path.resolve(resolvedPackageRoot, entrypoint);
  if (!isPathWithinDirectory(resolvedPackageRoot, resolvedEntrypoint)) return null;

  return resolvedEntrypoint;
}

export function resolveExistingPackageEntrypoint(
  packageRoot: string,
  entrypoint: string,
  expectedKind: PluginEntrypointKind = "any",
): string | null {
  const resolvedEntrypoint = resolvePackageRelativeEntrypoint(packageRoot, entrypoint);
  if (!resolvedEntrypoint || !existsSync(resolvedEntrypoint)) return null;

  let entrypointStat;
  let realPackageRoot: string;
  let realEntrypoint: string;
  try {
    entrypointStat = statSync(resolvedEntrypoint);
    realPackageRoot = realpathSync(path.resolve(packageRoot));
    realEntrypoint = realpathSync(resolvedEntrypoint);
  } catch {
    return null;
  }

  if (expectedKind === "file" && !entrypointStat.isFile()) return null;
  if (expectedKind === "directory" && !entrypointStat.isDirectory()) return null;
  if (!isPathWithinDirectory(realPackageRoot, realEntrypoint)) return null;

  return resolvedEntrypoint;
}
