import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { gatherDashboardData, renderDashboardHtml } from '../render/templateRenderer';
import {
  generateKindleSnapshot,
  getCachedSnapshot,
  getTabState,
  normalizeTabId,
  setActiveTab,
  TabId,
} from '../render/snapshot';
import { getTile, getTileManifest } from '../render/tiles';

export const webRouter = Router();

// GET / - Interactive live browser dashboard
webRouter.get('/', async (req: Request, res: Response) => {
  try {
    let tab: TabId = getTabState().activeTab;
    if (req.query.tab !== undefined) {
      tab = normalizeTabId(req.query.tab);
      setActiveTab(tab);
    }
    const isDemo = req.query.demo === '1';
    const data = await gatherDashboardData(isDemo);
    const html = renderDashboardHtml(data, true, tab);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: unknown) {
    res.status(500).send(`<h3>Error loading AttentionBoard:</h3><pre>${String(error)}</pre>`);
  }
});

// GET /render - Clean snapshot view for headless Chrome
webRouter.get('/render', async (req: Request, res: Response) => {
  try {
    const tab = req.query.tab !== undefined ? normalizeTabId(req.query.tab) : getTabState().activeTab;
    const isDemo = req.query.demo === '1';
    const data = await gatherDashboardData(isDemo);
    const html = renderDashboardHtml(data, false, tab);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: unknown) {
    res.status(500).send(`<h3>Error:</h3><pre>${String(error)}</pre>`);
  }
});

function getStylesPath(): string {
  const localPath = path.resolve(__dirname, '../render/views/styles.css');
  if (fs.existsSync(localPath)) return localPath;
  return path.resolve(__dirname, '../../src/render/views/styles.css');
}

// GET /styles.css - High contrast e-ink CSS
webRouter.get('/styles.css', (_req: Request, res: Response) => {
  const cssPath = getStylesPath();
  if (fs.existsSync(cssPath)) {
    res.setHeader('Content-Type', 'text/css');
    res.sendFile(cssPath);
  } else {
    res.status(404).send('Not found');
  }
});

// GET /dash.png - Kindle e-ink image endpoint for curl + fbink
webRouter.get('/dash.png', async (req: Request, res: Response) => {
  const force = req.query.force === 'true';
  const tabOverride = req.query.tab !== undefined ? normalizeTabId(req.query.tab) : undefined;
  try {
    const buffer = await generateKindleSnapshot(force, tabOverride);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(buffer);
  } catch (error: unknown) {
    const cached = getCachedSnapshot(tabOverride);
    if (cached) {
      res.setHeader('Content-Type', 'image/png');
      res.send(cached);
      return;
    }
    res.status(500).send(`PNG generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// GET /dash/manifest - Per-band hashes so the Kindle downloads only what changed
webRouter.get('/dash/manifest', async (req: Request, res: Response) => {
  const tab = req.query.tab !== undefined ? normalizeTabId(req.query.tab) : getTabState().activeTab;
  try {
    const manifest = await getTileManifest(tab);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(manifest);
  } catch (error: unknown) {
    res.status(500).send(`Manifest generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});

// GET /dash/tile?i=N - A single band of the current dashboard
webRouter.get('/dash/tile', async (req: Request, res: Response) => {
  const tab = req.query.tab !== undefined ? normalizeTabId(req.query.tab) : getTabState().activeTab;
  const index = parseInt(String(req.query.i), 10);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).send('Query parameter "i" must be a non-negative integer');
    return;
  }
  try {
    const tile = await getTile(tab, index);
    if (!tile) {
      res.status(404).send(`Tile ${index} not found`);
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(tile);
  } catch (error: unknown) {
    res.status(500).send(`Tile generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});
