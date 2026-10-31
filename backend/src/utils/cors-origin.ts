/**
 * Which browser origins may call the API.
 *
 * - No Origin header (curl, server-to-server): allowed.
 * - The server's own origin: allowed. A browser labels every POST — even from a
 *   page this server itself serves (/auth/*, /app/) — with Origin: <its own
 *   address>, and a fixed list that omitted it rejected the login page and the
 *   web dashboard's session refresh with a 500.
 * - chrome-extension://<32 a-p chars>: allowed (any id, so the Web Store id works
 *   too). Auth is the bearer token / zx_ key, not the origin.
 * - The configured extra origins (localhost dev, FRONTEND_URL).
 */
export function isAllowedOrigin(
  origin: string | undefined,
  selfOrigin: string,
  extraOrigins: string[]
): boolean {
  if (!origin) return true;
  if (origin === selfOrigin) return true;
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true;
  return extraOrigins.includes(origin);
}
