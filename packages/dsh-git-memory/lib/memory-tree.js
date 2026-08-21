/**
 * Memory tree contract shared by the host plugin, the synchronizer, and the
 * migration tool. A memory root may only ever contain these categories:
 *
 *   payload:     model-writable memory documents (summary.md + 3 directories)
 *   readonly:    reference documents copied into staging but never modified
 *   operational: host-owned bookkeeping (sync watermark + run journal)
 *   forbidden:   anything else (VCS internals, helper scripts, foreign files)
 *
 * The staging worktree that headless DSH is allowed to touch contains only
 * payload documents plus the readonly reference file. A change to any other
 * category (or a foreign path) fails the whole sync before live apply.
 */

export const CATEGORY = Object.freeze({
  PAYLOAD: "payload",
  READONLY: "readonly",
  OPERATIONAL: "operational",
  FORBIDDEN: "forbidden",
});

export const PAYLOAD_NAMES = Object.freeze(["summary.md", "handbook", "rollouts", "archive"]);
export const READONLY_NAMES = Object.freeze(["README.md"]);
export const OPERATIONAL_NAMES = Object.freeze([".last-sync", ".sync"]);

/** Split a contract path into segments, rejecting anything unsafe. */
export function pathSegments(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new TypeError("memory path must be a non-empty string");
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new TypeError("memory path must be relative");
  }
  if (relativePath.endsWith("/")) {
    throw new TypeError("memory path must not end with a slash");
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`unsafe memory path: ${relativePath}`);
  }
  return parts;
}

/**
 * Classify a relative path. Throws TypeError on an unsafe path so callers
 * never silently treat an absolute or escaping path as a memory document.
 */
export function classifyPath(relativePath) {
  const parts = pathSegments(relativePath);
  const first = parts[0];
  if (PAYLOAD_NAMES.includes(first)) return CATEGORY.PAYLOAD;
  if (first === "README.md" && parts.length === 1) return CATEGORY.READONLY;
  if (first === ".last-sync" && parts.length === 1) return CATEGORY.OPERATIONAL;
  if (first === ".sync") return CATEGORY.OPERATIONAL;
  return CATEGORY.FORBIDDEN;
}

export function isPayloadPath(relativePath) {
  return classifyPath(relativePath) === CATEGORY.PAYLOAD;
}

export function isReadonlyPath(relativePath) {
  return classifyPath(relativePath) === CATEGORY.READONLY;
}

export function isOperationalPath(relativePath) {
  return classifyPath(relativePath) === CATEGORY.OPERATIONAL;
}

export function isForbiddenPath(relativePath) {
  return classifyPath(relativePath) === CATEGORY.FORBIDDEN;
}

/** A staging tree may contain only payload documents and the readonly reference. */
export function isStagingAllowedPath(relativePath) {
  const category = classifyPath(relativePath);
  return category === CATEGORY.PAYLOAD || category === CATEGORY.READONLY;
}

/** Root-relative names that a safe clear operation must never touch. */
export const CLEAR_EXCLUDED_NAMES = Object.freeze([
  ...READONLY_NAMES,
  ...OPERATIONAL_NAMES,
  ".git",
  "scripts",
]);
