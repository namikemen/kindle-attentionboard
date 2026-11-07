import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TopAppUsage {
  name: string;
  cpuPercent: number;
  memoryMb: number;
  processCount: number;
}

export interface SystemHealth {
  cpuUsagePercent: number;
  cpuUserPercent: number;
  cpuSysPercent: number;
  cpuCores: number;
  gpu: {
    usagePercent: number;
    rendererPercent: number;
    tilerPercent: number;
    memoryUsedMb: number;
    allocGb: number;
    cores: number;
  };
  memory: {
    totalGb: number;
    usedGb: number;
    freeGb: number;
    compressedGb: number;
    usedPercent: number;
  };
  disk: {
    totalGb: number;
    usedGb: number;
    freeGb: number;
    usedPercent: number;
  };
  loadAvg: [number, number, number];
  battery: {
    percent: number;
    isCharging: boolean;
    timeRemaining: string;
    powerSource: 'Battery' | 'AC Power';
  };
  uptimeHours: number;
  topCpuApps: TopAppUsage[];
  topMemApps: TopAppUsage[];
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const totalBytes = os.totalmem();
  const totalGb = parseFloat((totalBytes / (1024 ** 3)).toFixed(1));
  const cpuStart = os.cpus();
  const cpuCores = cpuStart.length || 8;

  const load = os.loadavg();
  const loadAvg: [number, number, number] = [
    parseFloat(load[0].toFixed(2)),
    parseFloat(load[1].toFixed(2)),
    parseFloat(load[2].toFixed(2)),
  ];

  // Run top, vm_stat, ioreg GPU, df, pmset, and ps in parallel
  const [topRes, vmRes, gpuRes, dfRes, battRes, psRes] = await Promise.allSettled([
    execAsync('top -l 1 -n 0 -s 0', { timeout: 5000 }),
    execAsync('vm_stat', { timeout: 3000 }),
    execAsync('ioreg -r -d 1 -c IOAccelerator | grep -E "PerformanceStatistics|gpu-core-count"', { timeout: 3000 }),
    execAsync('df -k /System/Volumes/Data 2>/dev/null || df -k /', { timeout: 3000 }),
    execAsync('pmset -g batt', { timeout: 3000 }),
    execAsync('ps -Ao %cpu,rss,comm', { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }),
  ]);

  // 1. CPU Usage from `top -l 1 -n 0 -s 0` (fallback to os.cpus() delta)
  const cpuEnd = os.cpus();
  let userDelta = 0;
  let sysDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < cpuStart.length; i++) {
    const s = cpuStart[i].times;
    const e = cpuEnd[i]?.times || s;
    const u = Math.max(0, (e.user - s.user) + (e.nice - s.nice));
    const sy = Math.max(0, (e.sys - s.sys) + (e.irq - s.irq));
    const id = Math.max(0, e.idle - s.idle);
    userDelta += u;
    sysDelta += sy;
    totalDelta += u + sy + id;
  }

  let cpuUserPercent = totalDelta > 0 ? Math.round((userDelta / totalDelta) * 100) : 15;
  let cpuSysPercent = totalDelta > 0 ? Math.round((sysDelta / totalDelta) * 100) : 10;
  let cpuUsagePercent = Math.min(100, cpuUserPercent + cpuSysPercent);

  if (topRes.status === 'fulfilled') {
    const cpuMatch = topRes.value.stdout.match(
      /CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys,\s*([\d.]+)%\s*idle/i
    );
    if (cpuMatch) {
      const u = parseFloat(cpuMatch[1]);
      const s = parseFloat(cpuMatch[2]);
      cpuUserPercent = Math.round(u);
      cpuSysPercent = Math.round(s);
      cpuUsagePercent = Math.max(0, Math.min(100, Math.round(u + s)));
    }
  }

  // 2. Real macOS Memory from `vm_stat` (App Memory + Wired + Compressor)
  let usedGb = parseFloat(((totalBytes - os.freemem()) / (1024 ** 3)).toFixed(1));
  let compressedGb = 0;
  let memUsedPercent = Math.round((usedGb / totalGb) * 100);

  if (vmRes.status === 'fulfilled') {
    const out = vmRes.value.stdout;
    const pageSizeMatch = out.match(/page size of (\d+) bytes/i);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

    const getPages = (label: string): number => {
      const m = out.match(new RegExp(`${label}:\\s+(\\d+)`, 'i'));
      return m ? parseInt(m[1], 10) : 0;
    };

    const anonymousPages = getPages('Anonymous pages');
    const purgeablePages = getPages('Pages purgeable');
    const wiredPages = getPages('Pages wired down');
    const compressedPages = getPages('Pages occupied by compressor');
    const activePages = getPages('Pages active');

    const appPages = anonymousPages > 0 ? Math.max(0, anonymousPages - purgeablePages) : activePages;
    const realUsedBytes = (appPages + wiredPages + compressedPages) * pageSize;

    if (realUsedBytes > 0 && realUsedBytes <= totalBytes) {
      usedGb = parseFloat((realUsedBytes / (1024 ** 3)).toFixed(1));
      compressedGb = parseFloat(((compressedPages * pageSize) / (1024 ** 3)).toFixed(1));
      memUsedPercent = Math.min(100, Math.round((realUsedBytes / totalBytes) * 100));
    }
  }
  const freeGb = parseFloat(Math.max(0, totalGb - usedGb).toFixed(1));

  // 3. Apple Silicon GPU Telemetry from `ioreg -r -d 1 -c IOAccelerator`
  let gpu = {
    usagePercent: 0,
    rendererPercent: 0,
    tilerPercent: 0,
    memoryUsedMb: 0,
    allocGb: 0,
    cores: 14,
  };
  if (gpuRes.status === 'fulfilled') {
    const gOut = gpuRes.value.stdout;
    const devMatch = gOut.match(/"Device Utilization %"\s*=\s*(\d+)/);
    const renMatch = gOut.match(/"Renderer Utilization %"\s*=\s*(\d+)/);
    const tilMatch = gOut.match(/"Tiler Utilization %"\s*=\s*(\d+)/);
    const memMatch = gOut.match(/"In use system memory"\s*=\s*(\d+)/);
    const allocMatch = gOut.match(/"Alloc system memory"\s*=\s*(\d+)/);
    const coreMatch = gOut.match(/"gpu-core-count"\s*=\s*(\d+)/);

    const devPct = devMatch ? parseInt(devMatch[1], 10) : 0;
    const renPct = renMatch ? parseInt(renMatch[1], 10) : 0;
    const tilPct = tilMatch ? parseInt(tilMatch[1], 10) : 0;
    const memBytes = memMatch ? parseInt(memMatch[1], 10) : 0;
    const allocBytes = allocMatch ? parseInt(allocMatch[1], 10) : 0;
    const cores = coreMatch ? parseInt(coreMatch[1], 10) : 14;

    gpu = {
      usagePercent: Math.max(devPct, renPct),
      rendererPercent: renPct,
      tilerPercent: tilPct,
      memoryUsedMb: Math.round(memBytes / (1024 * 1024)),
      allocGb: parseFloat((allocBytes / (1024 ** 3)).toFixed(1)),
      cores,
    };
  }

  // 4. Disk Space
  let disk = { totalGb: 500, usedGb: 200, freeGb: 300, usedPercent: 40 };
  if (dfRes.status === 'fulfilled') {
    const lines = dfRes.value.stdout.trim().split('\n');
    if (lines.length > 1) {
      const parts = lines[lines.length - 1].split(/\s+/);
      const totalKb = parseInt(parts[1], 10);
      const freeKb = parseInt(parts[3], 10);
      const usedKb = Math.max(0, totalKb - freeKb);
      const diskTotalGb = parseFloat((totalKb / (1024 * 1024)).toFixed(0));
      const diskFreeGb = parseFloat((freeKb / (1024 * 1024)).toFixed(0));
      const diskUsedGb = parseFloat((usedKb / (1024 * 1024)).toFixed(0));
      const diskUsedPercent = Math.min(100, Math.round((usedKb / totalKb) * 100));

      disk = {
        totalGb: diskTotalGb,
        usedGb: diskUsedGb,
        freeGb: diskFreeGb,
        usedPercent: diskUsedPercent,
      };
    }
  }

  // 5. Host Mac Battery
  let battery = {
    percent: 100,
    isCharging: false,
    timeRemaining: 'Full',
    powerSource: 'AC Power' as 'Battery' | 'AC Power',
  };

  if (battRes.status === 'fulfilled') {
    const stdout = battRes.value.stdout;
    const isAc = stdout.includes('AC Power');
    const isCharging = stdout.includes('charging') && !stdout.includes('discharging');
    const match = stdout.match(/(\d+)%/);
    const percent = match ? parseInt(match[1], 10) : 100;

    let timeRemaining = '';
    const timeMatch = stdout.match(/(\d+:\d+)\s+remaining/);
    if (timeMatch) {
      timeRemaining = timeMatch[1];
    } else if (isCharging) {
      timeRemaining = 'Charging';
    } else {
      timeRemaining = isAc ? 'AC Power' : 'Battery';
    }

    battery = {
      percent,
      isCharging,
      timeRemaining,
      powerSource: isAc ? 'AC Power' : 'Battery',
    };
  }

  // 6. Top Resource-Consuming Apps (CPU & Memory)
  let topCpuApps: TopAppUsage[] = [];
  let topMemApps: TopAppUsage[] = [];

  if (psRes.status === 'fulfilled') {
    const lines = psRes.value.stdout.trim().split('\n').slice(1);
    const appMap = new Map<string, TopAppUsage>();

    for (const line of lines) {
      const m = line.trim().match(/^([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const cpu = parseFloat(m[1]) || 0;
      const rssMb = (parseInt(m[2], 10) || 0) / 1024;
      const comm = m[3].trim();

      if (cpu === 0 && rssMb < 5) continue;

      const appMatch = comm.match(/\/([^/]+?)\.app\//);
      let name = appMatch
        ? appMatch[1].replace(/\s+Helper.*$/i, '')
        : (comm.split('/').pop() || comm);

      // Normalize common system / CLI names
      if (name === 'ps' || name === 'top') continue;

      const existing = appMap.get(name) || {
        name,
        cpuPercent: 0,
        memoryMb: 0,
        processCount: 0,
      };
      existing.cpuPercent = parseFloat((existing.cpuPercent + cpu).toFixed(1));
      existing.memoryMb = Math.round(existing.memoryMb + rssMb);
      existing.processCount += 1;
      appMap.set(name, existing);
    }

    const allApps = Array.from(appMap.values());
    topCpuApps = [...allApps]
      .sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryMb - a.memoryMb)
      .slice(0, 5);
    topMemApps = [...allApps]
      .sort((a, b) => b.memoryMb - a.memoryMb || b.cpuPercent - a.cpuPercent)
      .slice(0, 5);
  }

  return {
    cpuUsagePercent,
    cpuUserPercent,
    cpuSysPercent,
    cpuCores,
    gpu,
    memory: {
      totalGb,
      usedGb,
      freeGb,
      compressedGb,
      usedPercent: memUsedPercent,
    },
    disk,
    loadAvg,
    battery,
    uptimeHours: parseFloat((os.uptime() / 3600).toFixed(1)),
    topCpuApps,
    topMemApps,
  };
}
