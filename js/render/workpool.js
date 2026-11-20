// Starwright — a small pool of module workers for terrain chunks and texture bakes, with a main-thread fallback.
//
//   const pool = getPool();
//   const job = pool.run({ kind: 'chunk', body: 'verda', face, level, ix, iy, N }, priority);   // smaller = sooner
//   job.promise.then(result => …);  job.cancel();  job.setPriority(p)
//   pool.pending   number of jobs queued or running
import { SYSTEM } from '../core/bodies.js';
import { buildChunk } from './terrainmesh.js';
import { bakeRows, bakeCloudRows } from './bodybake.js';

/** Run a job on the calling thread (also used when workers are unavailable). */
export function runJobSync(m) {
  const body = SYSTEM.byId[m.body];
  if (m.kind === 'chunk') return { chunk: buildChunk(body, m.face, m.level, m.ix, m.iy, m.N) };
  if (m.kind === 'bake') return { rows: bakeRows(body, m.width, m.height, m.row0, m.row1) };
  if (m.kind === 'clouds') return { rows: bakeCloudRows(body, m.width, m.height, m.row0, m.row1) };
  throw new Error('unknown job ' + m.kind);
}

class Pool {
  constructor() {
    this.workers = [];
    this.queue = [];
    this.jobs = new Map();
    this.nextId = 1;
    this.pending = 0;
    this.failed = false;
    this._timer = null;
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const n = Math.max(1, Math.min(4, hc - 1));
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./terrainworker.js', import.meta.url), { type: 'module' });
        const slot = { w, busy: null, ready: false };
        w.onmessage = (ev) => this._onMessage(slot, ev.data);
        w.onerror = (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); this._onFail(slot); };
        this.workers.push(slot);
      }
    } catch { this.failed = true; }
  }

  _onFail(slot) {
    // a worker that cannot start (old browser, file://): fall back to time-sliced work on the main thread
    const i = this.workers.indexOf(slot);
    if (i >= 0) this.workers.splice(i, 1);
    try { slot.w.terminate(); } catch { /* already gone */ }
    if (slot.busy) { this.queue.push(slot.busy); slot.busy = null; }
    if (!this.workers.length) this.failed = true;
    this._pump();
  }

  _onMessage(slot, data) {
    if (data.ready) { slot.ready = true; this._pump(); return; }
    const job = slot.busy;
    slot.busy = null;
    if (job && job.id === data.id) {
      this.jobs.delete(job.id); this.pending--;
      if (job.cancelled) job.resolve(null);
      else if (data.error) job.reject(new Error(data.error));
      else job.resolve(data);
    }
    this._pump();
  }

  _pump() {
    if (!this.queue.length) return;
    if (this.failed) {
      if (!this._timer) this._timer = setTimeout(() => { this._timer = null; this._mainSlice(); }, 0);
      return;
    }
    for (const slot of this.workers) {
      if (!this.queue.length) break;
      if (slot.busy || !slot.ready) continue;
      const job = this._take();
      if (!job) break;
      slot.busy = job;
      slot.w.postMessage({ id: job.id, ...job.msg });
    }
  }

  _take() {
    const q = this.queue;
    while (q.length) {
      let best = 0;
      for (let i = 1; i < q.length; i++) if (q[i].priority < q[best].priority) best = i;
      const job = q[best];
      q[best] = q[q.length - 1]; q.pop();
      if (job.cancelled) { this.jobs.delete(job.id); this.pending--; job.resolve(null); continue; }
      return job;
    }
    return null;
  }

  _mainSlice() {
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < 6) {
      const job = this._take();
      if (!job) break;
      this.jobs.delete(job.id); this.pending--;
      try { job.resolve(runJobSync(job.msg)); } catch (err) { job.reject(err); }
    }
    this._pump();
  }

  run(msg, priority = 0) {
    const job = { id: this.nextId++, msg, priority, cancelled: false, resolve: null, reject: null };
    job.promise = new Promise((res, rej) => { job.resolve = res; job.reject = rej; });
    job.cancel = () => { job.cancelled = true; };
    job.setPriority = (p) => { job.priority = p; };
    this.jobs.set(job.id, job); this.pending++;
    this.queue.push(job);
    this._pump();
    return job;
  }
}

let pool = null;
export function getPool() { return pool || (pool = new Pool()); }
