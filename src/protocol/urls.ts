export function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function roomUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  return new URL(normalizedPath, `${normalizeBaseUrl(baseUrl)}/`).toString();
}
