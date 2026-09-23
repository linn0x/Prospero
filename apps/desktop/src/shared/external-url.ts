const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const ABSOLUTE_URL_PROTOCOL = /^[a-z][a-z0-9+.-]*:/i;
const BLOCKED_PROTOCOLS = new Set(["javascript:", "data:", "vbscript:"]);

export const EXTERNAL_URL_REGEX = /(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|mailto:)[^\s"'<>`]+[^\s"':,.!?{}|\\^~[\]`()<>]/;

export function normalizeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || WINDOWS_DRIVE_PATH.test(trimmed) || !ABSOLUTE_URL_PROTOCOL.test(trimmed)) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    if (BLOCKED_PROTOCOLS.has(url.protocol.toLowerCase())) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
