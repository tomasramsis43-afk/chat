'use strict';

const NAME_RE = /^[a-z0-9_:]+$/;

class Metric {
  constructor(name, type, help) {
    this.name = name;
    this.type = type;
    this.help = help;
    this.values = new Map(); // labelKey -> value
  }
}

const series = new Map(); // name -> Metric

function labelKey(labels) {
  const ks = Object.keys(labels || {}).sort();
  return ks.map((k) => `${k}\u0000${String(labels[k])}`).join('|');
}

function labelString(labels) {
  const ks = Object.keys(labels || {}).sort();
  if (!ks.length) return '';
  const parts = ks.map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${parts.join(',')}}`;
}

function metric(name, type, help) {
  if (!NAME_RE.test(name)) throw new Error(`invalid metric name: ${name}`);
  let m = series.get(name);
  if (!m) {
    m = new Metric(name, type, help);
    series.set(name, m);
  }
  return m;
}

function emit(name, value, labels) {
  metric(name, 'gauge', '').values.set(labelKey(labels), value);
  return value;
}

function inc(name, labels, by) {
  const lk = labelKey(labels);
  const m = metric(name, 'counter', '');
  m.values.set(lk, (m.values.get(lk) || 0) + by);
  return m.values.get(lk);
}

function gauge(name, labels, value) {
  return emit(name, value, labels);
}

function incGauge(name, labels, by) {
  const lk = labelKey(labels);
  const m = metric(name, 'gauge', '');
  m.values.set(lk, (m.values.get(lk) || 0) + by);
  return m.values.get(lk);
}

function recordRequest(req, res, next) {
  const method = String(req.method || '').toLowerCase();
  inc('http_requests_total', { method }, 1);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    const status = String(res.statusCode);
    inc('http_responses_total', { status }, 1);
    inc('http_request_duration_seconds_sum', {}, durSeconds);
    inc('http_request_duration_seconds_count', {}, 1);
    if (res.statusCode >= 500) inc('http_errors_total', {}, 1);
  });
  res.on('close', () => {
    if (!res.writableFinished) inc('http_requests_aborted_total', {}, 1);
  });
  next();
}

function pushRuntime(lines, opts) {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  lines.push('# HELP process_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${process.uptime()}`);
  lines.push('# HELP process_cpu_seconds_total Cumulative process CPU seconds');
  lines.push('# TYPE process_cpu_seconds_total counter');
  lines.push(`process_cpu_seconds_total ${(cpu.user + cpu.system) / 1e6}`);
  lines.push('# HELP process_memory_rss_bytes Resident set size bytes');
  lines.push('# TYPE process_memory_rss_bytes gauge');
  lines.push(`process_memory_rss_bytes ${mem.rss}`);
  lines.push('# HELP process_memory_heap_used_bytes Heap used bytes');
  lines.push('# TYPE process_memory_heap_used_bytes gauge');
  lines.push(`process_memory_heap_used_bytes ${mem.heapUsed}`);
  lines.push('# HELP process_memory_heap_total_bytes Heap total bytes');
  lines.push('# TYPE process_memory_heap_total_bytes gauge');
  lines.push(`process_memory_heap_total_bytes ${mem.heapTotal}`);
  lines.push('# HELP process_memory_external_bytes External memory bytes');
  lines.push('# TYPE process_memory_external_bytes gauge');
  lines.push(`process_memory_external_bytes ${mem.external || 0}`);
  const db = opts && opts.db;
  if (db) {
    lines.push('# HELP db_pool_total_connections Database pool total connections');
    lines.push('# TYPE db_pool_total_connections gauge');
    lines.push(`db_pool_total_connections ${db.total || 0}`);
    lines.push('# HELP db_pool_idle_connections Database pool idle connections');
    lines.push('# TYPE db_pool_idle_connections gauge');
    lines.push(`db_pool_idle_connections ${db.idle || 0}`);
    lines.push('# HELP db_pool_waiting_requests Database pool queued requests');
    lines.push('# TYPE db_pool_waiting_requests gauge');
    lines.push(`db_pool_waiting_requests ${db.waiting || 0}`);
  }
}

function render(opts) {
  const lines = [];
  for (const name of Array.from(series.keys()).sort()) {
    const m = series.get(name);
    if (!m) continue;
    for (const [lk, value] of m.values) {
      const labels = {};
      if (lk) {
        for (const chunk of lk.split('|')) {
          const sep = chunk.indexOf('\u0000');
          if (sep > 0) labels[chunk.slice(0, sep)] = chunk.slice(sep + 1);
        }
      }
      if (m.help) {
        lines.push(`# HELP ${name} ${m.help}`);
        lines.push(`# TYPE ${name} ${m.type}`);
      }
      lines.push(`${name}${labelString(labels)} ${value}`);
    }
  }
  pushRuntime(lines, opts);
  return lines.join('\n') + '\n';
}

function reset() {
  series.clear();
}

module.exports = { inc, gauge, incGauge, recordRequest, render, reset };