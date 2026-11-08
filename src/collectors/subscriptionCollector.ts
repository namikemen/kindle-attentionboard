import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

const execAsync = promisify(exec);

export interface QuotaWindow {
  label: '5-HOUR' | 'WEEKLY' | string;
  remainingPercent: number;
  resetAt: string | null;
}

export interface QuotaProvider {
  name: string;
  windows: QuotaWindow[];
}

export interface SubscriptionQuota {
  available: boolean;
  provider: string;
  providers: QuotaProvider[];
  fetchedAt: string | null;
  error?: string;
}

const PROVIDER = 'GOOGLE AI PRO';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — `agy --print "/usage"` takes ~2.5s

let cachedQuota: SubscriptionQuota | null = null;
let cachedAt = 0;
let inFlight: Promise<SubscriptionQuota> | null = null;

function resolveAgyBinary(): string {
  const envBin = process.env.AGY_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  const homeBin = path.join(os.homedir(), '.gemini/bin/agy');
  if (fs.existsSync(homeBin)) return homeBin;
  // Fall back to PATH; exec will fail with ENOENT and we degrade gracefully.
  return 'agy';
}

function parseUsageOutput(stdout: string): QuotaProvider[] {
  const providers: QuotaProvider[] = [];
  const seenLabels = new Map<string, Set<string>>();

  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields.length < 3) continue;

    const name = fields[0].trim();
    const rawLabel = fields[1].trim();
    const pctRaw = fields[2].trim();
    if (!name || !rawLabel) continue;

    const remainingPercent = Number.parseFloat(pctRaw.replace(/%/g, ''));
    if (!Number.isFinite(remainingPercent)) continue;

    const lower = rawLabel.toLowerCase();
    let label: string;
    if (lower.includes('weekly')) label = 'WEEKLY';
    else if (lower.includes('five hour')) label = '5-HOUR';
    else label = rawLabel;

    const resetRaw = fields[3] ? fields[3].trim() : '';
    const resetAt = resetRaw || null;

    let provider = providers.find((p) => p.name === name);
    if (!provider) {
      provider = { name, windows: [] };
      providers.push(provider);
      seenLabels.set(name, new Set());
    }

    const seen = seenLabels.get(name)!;
    if (seen.has(label)) continue; // drop duplicates, keep first occurrence
    seen.add(label);

    provider.windows.push({ label, remainingPercent, resetAt });
  }

  return providers;
}

async function fetchSubscriptionQuota(): Promise<SubscriptionQuota> {
  const bin = resolveAgyBinary();
  try {
    const { stdout } = await execAsync(`"${bin}" --print "/usage" --print-timeout 20s --output-format text`, {
      timeout: 12000,
      maxBuffer: 1024 * 1024,
    });

    const providers = parseUsageOutput(stdout);
    if (providers.length === 0) {
      return {
        available: false,
        provider: PROVIDER,
        providers: [],
        fetchedAt: null,
        error: 'No quota rows parsed from agy output',
      };
    }

    const result: SubscriptionQuota = {
      available: true,
      provider: PROVIDER,
      providers,
      fetchedAt: new Date().toISOString(),
    };
    cachedQuota = result;
    cachedAt = Date.now();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      provider: PROVIDER,
      providers: [],
      fetchedAt: null,
      error: message,
    };
  }
}

export async function getSubscriptionQuota(): Promise<SubscriptionQuota> {
  if (cachedQuota && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedQuota;
  }
  if (inFlight) {
    return inFlight;
  }
  inFlight = fetchSubscriptionQuota().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
