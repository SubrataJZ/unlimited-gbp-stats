/**
 * metrics-payload.js — pure builder for the /api/ingest/metrics payload.
 * Works as a browser global (window.GBPMetricsPayload) and as a Node module,
 * same dual-export pattern as review-date.js.
 *
 * Maps local IndexedDB metric records (see storage.js saveMetric) to the
 * shape backend/src/controllers/metrics-ingest.controller.ts validates.
 */
/* eslint-disable no-var */
(function () {
  'use strict';

  // Must match VALID_METRIC_TYPES in metrics-ingest.controller.ts exactly.
  var VALID_METRIC_TYPES = {
    overview: true,
    calls: true,
    chat_clicks: true,
    bookings: true,
    directions: true,
    website_clicks: true,
  };

  /**
   * Build one metric entry for the payload, or null if it should be skipped
   * (unknown metricType — A3 would 400 on those).
   * @param {object} record  Local metric record from storage.js saveMetric.
   * @returns {object|null}
   */
  function buildMetricEntry(record) {
    if (!record || !VALID_METRIC_TYPES[record.metricType]) return null;

    var entry = {
      metricType: record.metricType,
      year: record.year,
      month: record.month,
      total: record.total,
    };

    if (Array.isArray(record.daily) && record.daily.length > 0) {
      entry.daily = record.daily;
    }

    if (record.yoyPercent !== null && record.yoyPercent !== undefined) {
      entry.yoyPercent = record.yoyPercent;
    }

    if (record.breakdown !== undefined && record.breakdown !== null) {
      entry.breakdown = record.breakdown;
    }

    if (record.searchTerms !== undefined && record.searchTerms !== null) {
      entry.searchTerms = record.searchTerms;
    }

    entry.isDerived = !!record.derived;

    // collectedAt: local records store epoch ms (Date.now()); A3 requires an
    // ISO string and only accepts typeof value === 'string'. When absent or
    // falsy (0 = reserved for backfill rows), omit the field entirely so A3
    // stamps now() — correct for a live push.
    if (record.collectedAt) {
      entry.collectedAt = new Date(record.collectedAt).toISOString();
    }

    return entry;
  }

  /**
   * Build the full /api/ingest/metrics payload for one business.
   * @param {object} business  { id, name }
   * @param {Array}  metrics   Array of local metric records for this business.
   * @returns {{businesses: Array}}
   */
  function buildMetricsPayload(business, metrics) {
    var entries = [];
    var list = Array.isArray(metrics) ? metrics : [];
    for (var i = 0; i < list.length; i++) {
      var entry = buildMetricEntry(list[i]);
      if (entry) entries.push(entry);
    }

    var b = {
      name: (business && business.name) || String((business && business.id) || 'Unknown'),
      // MUST match buildIntelPayload's googlePlaceId in background.js — same
      // key → same TrackedBusiness row. Do not change independently.
      googlePlaceId: String((business && business.id) || ''),
      isOwn: true,
      metrics: entries,
    };

    return { businesses: [b] };
  }

  var GBPMetricsPayload = {
    buildMetricsPayload: buildMetricsPayload,
    buildMetricEntry: buildMetricEntry,
    VALID_METRIC_TYPES: VALID_METRIC_TYPES,
  };

  if (typeof window !== 'undefined') { window.GBPMetricsPayload = GBPMetricsPayload; }
  if (typeof self !== 'undefined') { self.GBPMetricsPayload = GBPMetricsPayload; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = GBPMetricsPayload; }
})();
