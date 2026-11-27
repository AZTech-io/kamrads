// Garage pages and API. Everything goes through store.js, which only ever hands a person their own items
// (or everyone's, for admins).
import fs from 'node:fs';
import express from 'express';
import { sendPage } from '../pages.js';
import * as g from './store.js';

const fail = (res, e) => res.status(e.status || 400).json({ error: e.message });
const ok = fn => (req, res) => { try { res.json({ ok: true, ...(fn(req) || {}) }); } catch (e) { fail(res, e); } };

export function garageRoutes(app) {
  app.get('/garage', (req, res) => sendPage(res, 'garage.html', req.user));
  app.get('/api/garage', (req, res) => { try { res.json({ ...g.meta(req.user), ...g.listFor(req.user) }); } catch (e) { fail(res, e); } });
  app.post('/api/garage/assets', ok(req => ({ id: g.createAsset(req.user, req.body || {}) })));
  app.get('/api/garage/assets/:id', (req, res) => { try { res.json(g.assetView(req.user, req.params.id)); } catch (e) { fail(res, e); } });
  app.patch('/api/garage/assets/:id', ok(req => { g.updateAsset(req.user, req.params.id, req.body || {}); }));
  app.delete('/api/garage/assets/:id', ok(req => { g.deleteAsset(req.user, req.params.id); }));

  app.post('/api/garage/assets/:id/dues', ok(req => ({ id: g.addDue(req.user, req.params.id, req.body || {}) })));
  app.patch('/api/garage/dues/:id', ok(req => { g.updateDue(req.user, req.params.id, req.body || {}); }));
  app.delete('/api/garage/dues/:id', ok(req => { g.deleteDue(req.user, req.params.id); }));

  app.post('/api/garage/assets/:id/logs', ok(req => g.addLog(req.user, req.params.id, req.body || {})));
  app.delete('/api/garage/logs/:id', ok(req => { g.deleteLog(req.user, req.params.id); }));

  // Photos and PDFs come up as the raw file (not JSON), so a phone photo doesn't hit the JSON size limit
  app.post('/api/garage/assets/:id/files', express.raw({ type: () => true, limit: g.MAX_FILE }),
    ok(req => ({ id: g.addFile(req.user, req.params.id, req.body, { name: req.query.name, logId: req.query.log }) })));
  app.get('/api/garage/files/:id', (req, res) => {
    try {
      const f = g.fileFor(req.user, req.params.id);
      const file = g.filePath(f);
      if (!fs.existsSync(file)) return res.status(404).end();
      res.set({ 'content-type': f.mime, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename="${String(f.name).replace(/["\\\r\n]/g, '_')}"` });
      res.sendFile(file);
    } catch (e) { res.status(e.status || 400).end(); }
  });
  app.delete('/api/garage/files/:id', ok(req => { g.deleteFile(req.user, req.params.id); }));
  app.post('/api/garage/assets/:id/cover', ok(req => { g.setCover(req.user, req.params.id, req.body?.fileId); }));

  app.get('/api/garage/admins', (req, res) => { if (!g.isAdmin(req.user)) return res.status(403).json({ error: 'Admins only' }); res.json({ admins: g.admins(), main: g.mainUser() }); });
  app.post('/api/garage/admins', ok(req => { g.setAdmin(req.user, String(req.body?.user || '').toLowerCase(), !!req.body?.admin); return { admins: g.admins() }; }));
}
