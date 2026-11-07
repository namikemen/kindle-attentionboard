import { Router, Request, Response } from 'express';
import { gatherDashboardData } from '../render/templateRenderer';
import { timerManager } from '../collectors/timerManager';
import {
  generateKindleSnapshot,
  getTabState,
  nextTab,
  normalizeTabId,
  setActiveTab,
} from '../render/snapshot';

export const apiRouter = Router();

// GET /api/data - Full JSON telemetry
apiRouter.get('/data', async (_req: Request, res: Response) => {
  try {
    const data = await gatherDashboardData();
    res.json({
      success: true,
      tabState: getTabState(),
      data,
    });
  } catch (error: unknown) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to gather metrics',
    });
  }
});

// GET /api/tab - Current tab state
apiRouter.get('/tab', (_req: Request, res: Response) => {
  res.json({
    success: true,
    ...getTabState(),
  });
});

// POST /api/tab - Switch active tab (1, 2, or 3) or toggle autoCycle
apiRouter.post('/tab', async (req: Request, res: Response) => {
  const rawTab = req.body?.tab ?? req.query?.tab;
  const rawCycle = req.body?.autoCycle ?? req.query?.autoCycle;
  const tab = rawTab !== undefined ? normalizeTabId(rawTab) : getTabState().activeTab;
  const autoCycle =
    typeof rawCycle === 'boolean'
      ? rawCycle
      : typeof rawCycle === 'string'
        ? rawCycle === 'true'
        : undefined;

  const state = setActiveTab(tab, autoCycle);
  // Pre-render the selected tab snapshot in background
  generateKindleSnapshot(true, state.activeTab).catch(() => {});
  res.json({
    success: true,
    ...state,
  });
});

// POST /api/tab/next - Cycle to next tab (1 -> 2 -> 3 -> 1)
apiRouter.post('/tab/next', async (_req: Request, res: Response) => {
  const state = nextTab();
  generateKindleSnapshot(true, state.activeTab).catch(() => {});
  res.json({
    success: true,
    ...state,
  });
});

// Timer Controls
apiRouter.post('/timer/start', (_req: Request, res: Response) => {
  timerManager.start();
  res.json({ success: true, timer: timerManager.getState() });
});

apiRouter.post('/timer/pause', (_req: Request, res: Response) => {
  timerManager.pause();
  res.json({ success: true, timer: timerManager.getState() });
});

apiRouter.post('/timer/toggle', (_req: Request, res: Response) => {
  timerManager.toggle();
  res.json({ success: true, timer: timerManager.getState() });
});

apiRouter.post('/timer/reset', (req: Request, res: Response) => {
  const duration = typeof req.query.duration === 'string' ? parseInt(req.query.duration, 10) : undefined;
  timerManager.reset(duration);
  res.json({ success: true, timer: timerManager.getState() });
});

// Force refresh
apiRouter.post('/refresh', async (req: Request, res: Response) => {
  try {
    const tab = req.query.tab !== undefined ? normalizeTabId(req.query.tab) : undefined;
    const buf = await generateKindleSnapshot(true, tab);
    res.json({
      success: true,
      bytes: buf.length,
      tab: tab || getTabState().activeTab,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to refresh snapshot',
    });
  }
});
