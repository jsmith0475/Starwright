// Starwright — worker that builds terrain chunks and bakes body textures off the main thread.
// Messages: { id, kind: 'chunk', body, face, level, ix, iy, N }  →  { id, chunk } (typed arrays transferred)
//           { id, kind: 'bake', body, width, height, row0, row1 } →  { id, rows } (see bodytex.js bakeRows)
import { SYSTEM } from '../core/bodies.js';
import { buildChunk } from './terrainmesh.js';
import { bakeRows, bakeCloudRows } from './bodybake.js';

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    const body = SYSTEM.byId[m.body];
    if (m.kind === 'chunk') {
      const c = buildChunk(body, m.face, m.level, m.ix, m.iy, m.N);
      self.postMessage({ id: m.id, chunk: c }, [c.pos.buffer, c.nrm.buffer, c.col.buffer, c.hs.buffer]);
    } else if (m.kind === 'bake') {
      const r = bakeRows(body, m.width, m.height, m.row0, m.row1);
      self.postMessage({ id: m.id, rows: r }, [r.color.buffer, r.normal.buffer]);
    } else if (m.kind === 'clouds') {
      const r = bakeCloudRows(body, m.width, m.height, m.row0, m.row1);
      self.postMessage({ id: m.id, rows: r }, [r.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};
self.postMessage({ ready: true });
