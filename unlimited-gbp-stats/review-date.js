/**
 * review-date.js — shared review date parsing and bucketing utilities
 * Works as a browser global (window.GBPDate) and as a Node module.
 */

/* eslint-disable no-var */
(function () {
  'use strict';

  /**
   * Parse a raw review date string (absolute OR relative) into a YYYY-MM-DD string.
   * @param {string} relStr
   * @param {Date} [now=new Date()]
   * @returns {string|null}
   */
  function parseRelativeReviewDate(relStr, now) {
    if (now === undefined) now = new Date();
    if (!relStr) return null;
    var s = relStr.trim();

    // "Feb 2023" / "November 2024"  (Month YYYY)
    var absMonth = s.match(/^([a-z]+)\s+(\d{4})$/i);
    if (absMonth) {
      var MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      var mo = MONTHS[absMonth[1].slice(0,3).toLowerCase()];
      if (mo !== undefined) return dateToYMD(new Date(parseInt(absMonth[2]), mo, 1));
    }

    // "Feb 16, 2024" / "November 16 2024"  (Month Day[,] Year)
    var absDay = s.match(/^[a-z]+ \d{1,2},? \d{4}$/i);
    if (absDay) { var d0 = new Date(s); if (!isNaN(d0)) return dateToYMD(d0); }

    // "2 weeks ago" / "3 months ago" etc.
    var rel = s.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i);
    if (rel) {
      var n = parseInt(rel[1]); var d1 = new Date(now);
      switch (rel[2].toLowerCase()) {
        case 'second': d1.setSeconds(d1.getSeconds()-n); break;
        case 'minute': d1.setMinutes(d1.getMinutes()-n); break;
        case 'hour':   d1.setHours(d1.getHours()-n); break;
        case 'day':    d1.setDate(d1.getDate()-n); break;
        case 'week':   d1.setDate(d1.getDate()-n*7); break;
        case 'month':  d1.setMonth(d1.getMonth()-n); break;
        case 'year':   d1.setFullYear(d1.getFullYear()-n); break;
      }
      return dateToYMD(d1);
    }

    // "a week ago" / "a month ago" / "a year ago"
    var aRel = s.match(/^a\s+(week|month|year)\s+ago$/i);
    if (aRel) {
      var d2 = new Date(now);
      switch (aRel[1].toLowerCase()) {
        case 'week':  d2.setDate(d2.getDate()-7); break;
        case 'month': d2.setMonth(d2.getMonth()-1); break;
        case 'year':  d2.setFullYear(d2.getFullYear()-1); break;
      }
      return dateToYMD(d2);
    }

    // "7 Feb 2023" / "16 Nov 2024"  (Day Month Year)
    var dmy = s.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i);
    if (dmy) {
      var MONTHS2 = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      var mo2 = MONTHS2[dmy[2].slice(0,3).toLowerCase()];
      if (mo2 !== undefined) return dateToYMD(new Date(parseInt(dmy[3]), mo2, parseInt(dmy[1])));
    }

    return null;
  }

  /**
   * Resolve a review object to a Date (or null).
   * Prefers reviewedAtISO; falls back to parsing reviewedAt.
   * @param {object} review
   * @param {Date} [now=new Date()]
   * @returns {Date|null}
   */
  function resolveReviewDate(review, now) {
    if (now === undefined) now = new Date();
    if (review && review.reviewedAtISO) {
      // Parse plain YYYY-MM-DD as LOCAL midnight (not UTC) so the calendar day
      // is preserved when bucketKey reads local date components.
      var d = /^\d{4}-\d{2}-\d{2}$/.test(review.reviewedAtISO)
        ? new Date(review.reviewedAtISO + 'T00:00:00')
        : new Date(review.reviewedAtISO);
      if (!isNaN(d)) return d;
    }
    if (review && review.reviewedAt) {
      var iso = parseRelativeReviewDate(review.reviewedAt, now);
      if (iso) { var d2 = new Date(iso); if (!isNaN(d2)) return d2; }
    }
    return null;
  }

  // ── Bucket helpers ──────────────────────────────────────────────────────────

  /** Return Monday of the ISO week containing date d */
  function mondayOf(d) {
    var day = d.getDay(); // 0=Sun
    var diff = (day === 0) ? -6 : 1 - day;
    var m = new Date(d);
    m.setDate(d.getDate() + diff);
    return m;
  }

  function padTwo(n) { return n < 10 ? '0' + n : '' + n; }

  function dateToYMD(d) {
    return d.getFullYear() + '-' + padTwo(d.getMonth()+1) + '-' + padTwo(d.getDate());
  }

  function bucketKey(d, granularity) {
    switch (granularity) {
      case 'day':   return dateToYMD(d);
      case 'week':  return dateToYMD(mondayOf(d));
      case 'month': return d.getFullYear() + '-' + padTwo(d.getMonth()+1);
      case 'year':  return '' + d.getFullYear();
      default:      return d.getFullYear() + '-' + padTwo(d.getMonth()+1);
    }
  }

  function bucketLabel(key, granularity) {
    var MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    switch (granularity) {
      case 'day': {
        // key = YYYY-MM-DD
        var parts = key.split('-');
        var mo = parseInt(parts[1]) - 1;
        return parseInt(parts[2]) + ' ' + MONTH_SHORT[mo];
      }
      case 'week': {
        // key = YYYY-MM-DD (Monday)
        var wparts = key.split('-');
        var wmo = parseInt(wparts[1]) - 1;
        return parseInt(wparts[2]) + ' ' + MONTH_SHORT[wmo];
      }
      case 'month': {
        // key = YYYY-MM
        var mparts = key.split('-');
        return MONTH_SHORT[parseInt(mparts[1])-1] + ' ' + mparts[0];
      }
      case 'year':
        return key;
      default: {
        var dparts = key.split('-');
        return MONTH_SHORT[parseInt(dparts[1])-1] + ' ' + dparts[0];
      }
    }
  }

  /** Advance a period key by one step */
  function nextKey(key, granularity) {
    switch (granularity) {
      case 'day': {
        var d = new Date(key + 'T00:00:00');
        d.setDate(d.getDate() + 1);
        return dateToYMD(d);
      }
      case 'week': {
        var wd = new Date(key + 'T00:00:00');
        wd.setDate(wd.getDate() + 7);
        return dateToYMD(wd);
      }
      case 'month': {
        var parts = key.split('-');
        var y = parseInt(parts[0]), m = parseInt(parts[1]);
        m++; if (m > 12) { m = 1; y++; }
        return y + '-' + padTwo(m);
      }
      case 'year': {
        return '' + (parseInt(key) + 1);
      }
      default: {
        var dparts = key.split('-');
        var dy = parseInt(dparts[0]), dm = parseInt(dparts[1]);
        dm++; if (dm > 12) { dm = 1; dy++; }
        return dy + '-' + padTwo(dm);
      }
    }
  }

  /**
   * Bucket reviews by actual review date.
   * @param {Array} reviews
   * @param {string} granularity  'day'|'week'|'month'|'year'
   * @param {Date} [now=new Date()]
   * @returns {Array<{key, label, count, cumulative}>}
   */
  function bucketReviewsByPeriod(reviews, granularity, now) {
    if (now === undefined) now = new Date();
    if (!Array.isArray(reviews) || reviews.length === 0) return [];

    // Resolve dates and bucket
    var counts = {};
    var minKey = null, maxKey = null;

    for (var i = 0; i < reviews.length; i++) {
      var d = resolveReviewDate(reviews[i], now);
      if (!d) continue;
      var k = bucketKey(d, granularity);
      counts[k] = (counts[k] || 0) + 1;
      if (minKey === null || k < minKey) minKey = k;
      if (maxKey === null || k > maxKey) maxKey = k;
    }

    if (minKey === null) return [];

    // Gap-fill: enumerate all periods between min and max
    var MAX_DAY_BUCKETS = 730;
    var result = [];
    var current = minKey;
    var iters = 0;
    var skipGapFill = false;

    // Count actual buckets to decide if we need to cap
    if (granularity === 'day') {
      var dMin = new Date(minKey + 'T00:00:00');
      var dMax = new Date(maxKey + 'T00:00:00');
      var span = Math.round((dMax - dMin) / (1000*60*60*24)) + 1;
      if (span > MAX_DAY_BUCKETS) skipGapFill = true;
    }

    if (skipGapFill) {
      // Return only real buckets in sorted order
      var keys = Object.keys(counts).sort();
      var cum = 0;
      for (var ki = 0; ki < keys.length; ki++) {
        var kk = keys[ki];
        cum += counts[kk];
        result.push({ key: kk, label: bucketLabel(kk, granularity), count: counts[kk], cumulative: cum });
      }
      return result;
    }

    var cumulative = 0;
    while (current <= maxKey && iters < 10000) {
      iters++;
      var cnt = counts[current] || 0;
      cumulative += cnt;
      result.push({ key: current, label: bucketLabel(current, granularity), count: cnt, cumulative: cumulative });
      if (current === maxKey) break;
      current = nextKey(current, granularity);
    }

    return result;
  }

  var GBPDate = {
    parseRelativeReviewDate: parseRelativeReviewDate,
    resolveReviewDate: resolveReviewDate,
    bucketReviewsByPeriod: bucketReviewsByPeriod,
  };

  if (typeof window !== 'undefined') { window.GBPDate = GBPDate; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = GBPDate; }
})();
