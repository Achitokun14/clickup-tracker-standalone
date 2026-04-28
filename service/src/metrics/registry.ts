import * as promClient from 'prom-client';

// Singleton Prometheus registry. Wired into MetricsController. Default
// Node metrics auto-collect; the named counters/histograms below are
// what the EventsService and SyncService increment as they work.
export const register = new promClient.Registry();
register.setDefaultLabels({ service: 'clickup-tracker' });

export const eventsTotal = new promClient.Counter({
  name: 'cup_tracker_events_total',
  help: 'Total events ingested, by kind + outcome.',
  labelNames: ['kind', 'outcome'] as const,
  registers: [register],
});

export const clickupRequestsTotal = new promClient.Counter({
  name: 'cup_tracker_clickup_requests_total',
  help: 'Total ClickUp API requests by status class (2xx, 4xx, 5xx).',
  labelNames: ['status_class'] as const,
  registers: [register],
});

export const syncDurationSeconds = new promClient.Histogram({
  name: 'cup_tracker_sync_duration_seconds',
  help: 'Sync job duration.',
  labelNames: ['kind'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

promClient.collectDefaultMetrics({ register });
