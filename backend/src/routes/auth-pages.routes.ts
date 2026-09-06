import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

/**
 * Server-rendered auth pages: /auth/login, /auth/signup, /auth/forgot-password,
 * /auth/reset-password. Same origin as the API, so the httpOnly refresh cookie
 * works and there is no CORS to configure. The pages are static apart from the
 * {{MODE}} / {{TITLE}} substitution; all logic is in the browser (app.js) and
 * hits ../api/auth/*.
 *
 * Public URL depends on the proxy: locally /auth/login, in production (backend
 * mounted under /backend/) https://gbp.zixify.zixai.in/backend/auth/login.
 */

const router = Router();

const DIR = path.join(__dirname, '../templates/auth');
const shell = fs.readFileSync(path.join(DIR, 'shell.html'), 'utf-8');
const styles = fs.readFileSync(path.join(DIR, 'styles.css'), 'utf-8');
const appJs = fs.readFileSync(path.join(DIR, 'app.js'), 'utf-8');

type Mode = 'login' | 'signup' | 'forgot' | 'reset';
const PAGES: Record<string, { mode: Mode; title: string }> = {
  login: { mode: 'login', title: 'Sign in' },
  signup: { mode: 'signup', title: 'Create account' },
  'forgot-password': { mode: 'forgot', title: 'Forgot password' },
  'reset-password': { mode: 'reset', title: 'Reset password' },
};

// Scoped CSP for these pages only (helmet's global default is stricter and would
// block the inline style attributes in the template). Scripts stay 'self'-only.
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'";

router.get('/styles.css', (_req: Request, res: Response) => {
  res.type('text/css').set('Cache-Control', 'public, max-age=3600').send(styles);
});

router.get('/app.js', (_req: Request, res: Response) => {
  res
    .type('application/javascript')
    .set('Cache-Control', 'public, max-age=3600')
    .set('Content-Security-Policy', PAGE_CSP)
    .send(appJs);
});

function renderPage(res: Response, spec: { mode: Mode; title: string }): void {
  const html = shell
    .replace(/\{\{MODE\}\}/g, spec.mode)
    .replace(/\{\{TITLE\}\}/g, spec.title);
  res
    .type('html')
    .set('Content-Security-Policy', PAGE_CSP)
    .set('X-Robots-Tag', 'noindex')
    .send(html);
}

router.get('/', (_req: Request, res: Response) => renderPage(res, PAGES.login));

router.get('/:page', (req: Request, res: Response) => {
  const spec = PAGES[req.params.page];
  renderPage(res, spec || PAGES.login);
});

export default router;
