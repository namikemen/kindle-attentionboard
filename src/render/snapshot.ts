import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

const execAsync = promisify(exec);

export type TabId = 1 | 2 | 3;

interface CachedTabSnapshot {
  buffer: Buffer;
  timestamp: number;
}

let activeTab: TabId = 1;
let autoCycleTabs = false;
let lastCycleTime = 0;

const cachedByTab = new Map<TabId, CachedTabSnapshot>();
const pinnedUntilByTab = new Map<TabId, number>();
const RENDER_THROTTLE_MS = 10 * 1000; // 10s throttle per tab
const tempPngPath = path.resolve('/tmp/kindle-attentionboard-dash.png');

export function normalizeTabId(val: unknown): TabId {
  const n = typeof val === 'string' ? parseInt(val, 10) : typeof val === 'number' ? val : NaN;
  if (n === 1 || n === 2 || n === 3) return n;
  return activeTab;
}

/**
 * Keep the current snapshot for a tab valid for at least `ms`.
 *
 * Used by the tile manifest so a slow Kindle cannot have a batch of tile
 * requests straddle a re-render and end up compositing two different frames.
 */
export function pinSnapshot(tab: TabId, ms: number): void {
  const cached = cachedByTab.get(tab);
  if (!cached) return;
  // Tie the pin to the frame's own render time instead of "now". Re-pinning on
  // every manifest request must not keep an ever-older frame alive forever
  // (e.g. with a poll interval shorter than the pin window).
  const until = cached.timestamp + ms;
  const existing = pinnedUntilByTab.get(tab) ?? 0;
  pinnedUntilByTab.set(tab, Math.max(existing, until));
}

export function getTabState(): { activeTab: TabId; autoCycle: boolean } {
  return { activeTab, autoCycle: autoCycleTabs };
}

export function setActiveTab(tab: TabId, autoCycle?: boolean): { activeTab: TabId; autoCycle: boolean } {
  activeTab = tab;
  if (typeof autoCycle === 'boolean') {
    autoCycleTabs = autoCycle;
  }
  return getTabState();
}

export function nextTab(): { activeTab: TabId; autoCycle: boolean } {
  activeTab = ((activeTab % 3) + 1) as TabId;
  lastCycleTime = Date.now();
  return getTabState();
}

export async function generateKindleSnapshot(force: boolean = false, tabOverride?: TabId): Promise<Buffer> {
  const now = Date.now();

  if (!tabOverride && autoCycleTabs && now - lastCycleTime >= 15 * 1000) {
    activeTab = ((activeTab % 3) + 1) as TabId;
    lastCycleTime = now;
  }

  const targetTab: TabId = tabOverride || activeTab;
  const cached = cachedByTab.get(targetTab);

  // Return cached PNG for this tab if within the throttle window (or pinned by
  // an in-flight tile batch) unless a forced refresh was requested.
  const pinnedUntil = pinnedUntilByTab.get(targetTab) ?? 0;
  if (!force && cached && (now - cached.timestamp < RENDER_THROTTLE_MS || now < pinnedUntil)) {
    return cached.buffer;
  }

  // Unique temp file per render. Two server instances (or a stale file from a
  // previous failed run) must never make us return an older frame.
  const tabTempPath = path.resolve(`/tmp/kindle-attentionboard-tab${targetTab}-${process.pid}-${now}.png`);
  const renderUrl = `http://127.0.0.1:${config.port}/render?tab=${targetTab}`;
  const chromeCmd = `"${config.chromePath}" --headless=new --disable-gpu --hide-scrollbars --window-size=${config.kindleWidth},${config.kindleHeight} --screenshot="${tabTempPath}" "${renderUrl}"`;

  try {
    await execAsync(chromeCmd, { timeout: 15000 });
    if (fs.existsSync(tabTempPath)) {
      const buf = fs.readFileSync(tabTempPath);
      cachedByTab.set(targetTab, { buffer: buf, timestamp: now });
      // Also keep /tmp/kindle-attentionboard-dash.png updated with the latest active tab
      if (targetTab === activeTab) {
        try {
          fs.copyFileSync(tabTempPath, tempPngPath);
        } catch {
          // Ignore copy errors
        }
      }
      try {
        fs.unlinkSync(tabTempPath);
      } catch {
        // Ignore cleanup errors
      }
      return buf;
    }
  } catch (err) {
    try {
      fs.unlinkSync(tabTempPath);
    } catch {
      // Ignore cleanup errors
    }
    if (cached) return cached.buffer;
    throw new Error(`Headless snapshot generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (cached) return cached.buffer;
  throw new Error('Screenshot file was not produced by Chrome');
}

export function getCachedSnapshot(tabOverride?: TabId): Buffer | null {
  const targetTab = tabOverride || activeTab;
  return cachedByTab.get(targetTab)?.buffer || null;
}
