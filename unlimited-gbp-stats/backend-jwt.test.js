/**
 * backend-jwt.test.js — plain Node assertions for the backend-JWT freshness
 * decision. Run: node backend-jwt.test.js  →  prints "ALL TESTS PASSED".
 *
 * Regression guard for the dashboard's analytics/report calls. Those hit
 * validateJWT-guarded routes and for a long time sent `_authUser.accessToken`,
 * a field that never existed — so every call 401'd and silently fell back to
 * locally-computed data. background.js now persists the real backend JWT and
 * uses chooseJwtAction() to keep it fresh: cached while valid, rotated via
 * /api/auth/refresh, or re-minted through connectBackend().
 */
'use strict';

const { chooseJwtAction, expiryFromExpiresIn, STORAGE_KEYS, DEFAULT_SKEW_MS } =
  require('./backend-jwt.js');

let n = 0;
function assert(cond, msg) {
  n++;
  if (!cond) { throw new Error('FAILED #' + n + ': ' + msg); }
}
function eq(a, b, msg) {
  assert(a === b, (msg || '') + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')');
}

const NOW = 1_700_000_000_000;

// 1. Fresh cached token → use it as-is.
eq(
  chooseJwtAction({ jwt: 'a', refresh: 'r', exp: NOW + 10 * 60_000, now: NOW }),
  'use-cached',
  'a token well inside its lifetime is reused',
);

// 2. Token inside the skew margin → treated as already dead, rotate.
eq(
  chooseJwtAction({ jwt: 'a', refresh: 'r', exp: NOW + 30_000, now: NOW }),
  'refresh',
  'a token dying within the skew margin is refreshed, not handed out',
);

// 3. Expired token, refresh token present → rotate.
eq(
  chooseJwtAction({ jwt: 'a', refresh: 'r', exp: NOW - 1, now: NOW }),
  'refresh',
  'expired access token with a refresh token → refresh',
);

// 4. Expired token, no refresh token → full re-mint.
eq(
  chooseJwtAction({ jwt: 'a', refresh: null, exp: NOW - 1, now: NOW }),
  'remint',
  'no refresh token → re-mint via connectBackend',
);

// 5. Nothing stored at all (signed out / fresh install) → re-mint path.
eq(
  chooseJwtAction({ jwt: null, refresh: null, exp: 0, now: NOW }),
  'remint',
  'empty store → re-mint',
);

// 6. forceRefresh ignores a still-valid cached token (used after a 401).
eq(
  chooseJwtAction({ jwt: 'a', refresh: 'r', exp: NOW + 10 * 60_000, now: NOW, forceRefresh: true }),
  'refresh',
  'forceRefresh bypasses a fresh cached token',
);

// 7. forceRefresh with no refresh token → re-mint.
eq(
  chooseJwtAction({ jwt: 'a', refresh: null, exp: NOW + 10 * 60_000, now: NOW, forceRefresh: true }),
  'remint',
  'forceRefresh with no refresh token → re-mint',
);

// 8. Default skew margin is a minute.
eq(DEFAULT_SKEW_MS, 60_000, 'default skew margin is 60s');

// 9. expiryFromExpiresIn: backend sends 900 (seconds) → 15 min out.
eq(expiryFromExpiresIn(900, NOW), NOW + 900_000, 'expiresIn 900s → +15min');

// 10. expiryFromExpiresIn: missing / zero / garbage → default 15 min.
eq(expiryFromExpiresIn(undefined, NOW), NOW + 15 * 60_000, 'undefined expiresIn → +15min default');
eq(expiryFromExpiresIn(0, NOW), NOW + 15 * 60_000, 'zero expiresIn → +15min default');
eq(expiryFromExpiresIn('nope', NOW), NOW + 15 * 60_000, 'non-numeric expiresIn → +15min default');

// 11. A token issued now is immediately considered fresh by chooseJwtAction.
{
  const exp = expiryFromExpiresIn(900, NOW);
  eq(
    chooseJwtAction({ jwt: 'a', refresh: 'r', exp, now: NOW }),
    'use-cached',
    'a token just issued is usable right away',
  );
}

// 12. Storage key names are the ones background.js and dashboard.js remove on sign-out.
eq(STORAGE_KEYS.jwt, 'gbpBackendJWT', 'jwt storage key');
eq(STORAGE_KEYS.refresh, 'gbpBackendRefresh', 'refresh storage key');
eq(STORAGE_KEYS.exp, 'gbpBackendJWTExp', 'expiry storage key');

console.log('ALL TESTS PASSED (' + n + ' assertions)');
