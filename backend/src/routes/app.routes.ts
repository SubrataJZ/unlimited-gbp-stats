import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { validateJWT } from '../middlewares/auth.middleware';
import { asyncHandler } from '../middlewares/error.middleware';
import { resolveOrgId, getSyncBundleForOrg } from '../services/intel.service';
import { shapeDashboard } from '../services/dashboard.service';

/**
 * Web dashboard — read-only view of the data the extension syncs, for any
 * browser or phone. Same pattern as auth-pages.routes.ts: static files served
 * by the backend, same origin as the API, so the refresh cookie just works.
 * Public URL: https://gbp.zixify.zixai.in/backend/app/
 */

// ── API: GET /api/app/overview ─────────────────────────────────────────────
export const appApiRouter = Router();

appApiRouter.get(
  '/overview',
  validateJWT,
  asyncHandler(async (req: Request, res: Response) => {
    const orgId = await resolveOrgId(req.user!.id);
    const businesses = shapeDashboard(await getSyncBundleForOrg(orgId));
    res.set('Cache-Control', 'no-store').json({ ok: true, businesses });
  })
);

// ── Pages: /app/ ───────────────────────────────────────────────────────────
export const appPagesRouter = Router();

const DIR = path.join(__dirname, '../templates/app');
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf-8');
const FILES: Record<string, { body: string; type: string }> = {
  'app.js': { body: read('app.js'), type: 'application/javascript' },
  'styles.css': { body: read('styles.css'), type: 'text/css' },
  'manifest.webmanifest': { body: read('manifest.webmanifest'), type: 'application/manifest+json' },
  'icon.svg': { body: read('icon.svg'), type: 'image/svg+xml' },
};
const shell = read('shell.html');

const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'";

appPagesRouter.get('/', (req: Request, res: Response) => {
  // Relative asset/API paths need the trailing slash: /backend/app → /backend/app/
  if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(301, 'app/');
  res
    .type('html')
    .set('Content-Security-Policy', PAGE_CSP)
    .set('Cache-Control', 'no-cache')
    .set('X-Robots-Tag', 'noindex')
    .send(shell);
});

appPagesRouter.get('/:file', (req: Request, res: Response) => {
  const f = FILES[req.params.file];
  if (!f) return res.status(404).send('Not found');
  res.type(f.type).set('Cache-Control', 'no-cache').set('Content-Security-Policy', PAGE_CSP).send(f.body);
});
