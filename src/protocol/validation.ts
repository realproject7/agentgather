export const SLUG_PATTERN = /^[a-z0-9-]+$/;
export const MAX_SLUG_LENGTH = 64;

export function isSafeSlug(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export function assertSafeSlug(value: string, label: string): void {
  if (!isSafeSlug(value)) {
    throw new Error(`${label} must be lowercase [a-z0-9-], 1-${MAX_SLUG_LENGTH} chars`);
  }
}

export function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}
