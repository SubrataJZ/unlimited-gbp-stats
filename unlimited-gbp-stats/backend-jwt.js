/**
 * backend-jwt.js — the pure decision logic for keeping a backend JWT access
 * token fresh. Works as a browser/worker global (self.GBPBackendJWT) and as a
 * Node module, same dual-export pattern as metrics-payload.js.
 *
 * The extension's dashboard calls /api/analytics/* and /api/reports/generate,
 * which the backend guards with validateJWT — a real 15-minute access token,
 * not the long-lived zx_ ingest key. connectBackend() in background.js mints one
 * as a byproduct of provisioning the zx_ key; background.js persists it under
 * these keys and uses chooseJwtAction() to decide, on each request, whether the
 * cached token is still usable, can be rotated via /api/auth/refresh, or needs a
 * full re-mint through connectBackend().
 */
/* eslint-disable no-var */
(function () {
  'use strict';

  // chrome.storage.local keys. Kept here so background.js and the sign-out
  // handler in dashboard.js cannot drift apart on the spelling.
  var STORAGE_KEYS = {
    jwt:     'gbpBackendJWT',
    refresh: 'gbpBackendRefresh',
    exp:     'gbpBackendJWTExp',
  };

  // Default clock-skew margin: never hand out a token that dies within a minute.
  var DEFAULT_SKEW_MS = 60 * 1000;

  /**
   * Decide what to do to obtain a usable access token.
   *
   * @param {object}  s
   * @param {?string} s.jwt          the cached access token, if any
   * @param {?string} s.refresh      the cached refresh token, if any
   * @param {number}  s.exp          cached access-token expiry, epoch ms
   * @param {boolean} [s.forceRefresh=false]  ignore the cached token even if fresh
   * @param {number}  [s.now=Date.now()]
   * @param {number}  [s.skewMs=60000]
   * @returns {'use-cached'|'refresh'|'remint'}
   */
  function chooseJwtAction(s) {
    s = s || {};
    var now = typeof s.now === 'number' ? s.now : Date.now();
    var skew = typeof s.skewMs === 'number' ? s.skewMs : DEFAULT_SKEW_MS;
    var exp = typeof s.exp === 'number' ? s.exp : 0;

    if (!s.forceRefresh && s.jwt && now < exp - skew) return 'use-cached';
    if (s.refresh) return 'refresh';
    return 'remint';
  }

  /**
   * Compute the stored expiry timestamp for a freshly issued token.
   * expiresIn is seconds (the backend returns 900); fall back to 15 minutes.
   */
  function expiryFromExpiresIn(expiresIn, now) {
    now = typeof now === 'number' ? now : Date.now();
    var secs = Number(expiresIn);
    var ttlMs = secs > 0 ? secs * 1000 : 15 * 60 * 1000;
    return now + ttlMs;
  }

  var GBPBackendJWT = {
    STORAGE_KEYS: STORAGE_KEYS,
    DEFAULT_SKEW_MS: DEFAULT_SKEW_MS,
    chooseJwtAction: chooseJwtAction,
    expiryFromExpiresIn: expiryFromExpiresIn,
  };

  if (typeof window !== 'undefined') { window.GBPBackendJWT = GBPBackendJWT; }
  if (typeof self !== 'undefined') { self.GBPBackendJWT = GBPBackendJWT; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = GBPBackendJWT; }
})();
