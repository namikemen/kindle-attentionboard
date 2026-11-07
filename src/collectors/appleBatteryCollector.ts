import { exec } from 'child_process';
import { promisify } from 'util';
import { getSystemHealth } from './systemCollector';

const execAsync = promisify(exec);

export interface AppleDeviceBattery {
  id: string;
  name: string;
  percent: number | null;
  statusText: string;
  detail: string;
  isCharging?: boolean;
  isConnected: boolean;
  type: 'macbook' | 'iphone' | 'ipad' | 'watch' | 'mouse' | 'keyboard' | 'trackpad' | 'headphones' | 'other';
}

function normalizeMac(mac: string): string {
  return mac.trim().toLowerCase().replace(/-/g, ':');
}

function classifyDeviceType(name: string, minorType?: string): AppleDeviceBattery['type'] {
  const lower = `${name} ${minorType || ''}`.toLowerCase();
  if (lower.includes('macbook') || lower.includes('internal')) return 'macbook';
  if (lower.includes('iphone') || lower.includes('ikephone')) return 'iphone';
  if (lower.includes('ipad')) return 'ipad';
  if (lower.includes('watch') || lower.includes('ikewatch')) return 'watch';
  if (lower.includes('mouse') || lower.includes('ikemouse')) return 'mouse';
  if (lower.includes('keyboard')) return 'keyboard';
  if (lower.includes('trackpad')) return 'trackpad';
  if (lower.includes('airpods') || lower.includes('beats') || lower.includes('headphone')) return 'headphones';
  return 'other';
}

function parsePct(str?: string): number | null {
  if (!str) return null;
  const m = str.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export async function getAppleDevicesBattery(): Promise<AppleDeviceBattery[]> {
  const devices: AppleDeviceBattery[] = [];

  // 1. Host MacBook battery
  try {
    const sys = await getSystemHealth();
    devices.push({
      id: 'host-macbook',
      name: 'MacBook Pro',
      percent: sys.battery.percent,
      statusText: `${sys.battery.percent}%${sys.battery.isCharging ? ' ⚡' : ''}`,
      detail: sys.battery.powerSource,
      isCharging: sys.battery.isCharging,
      isConnected: true,
      type: 'macbook',
    });
  } catch {
    // Continue
  }

  // 2. Query ioreg HID & system_profiler Bluetooth in parallel
  const [ioregRes, btRes] = await Promise.allSettled([
    execAsync('ioreg -r -c AppleDeviceManagementHIDEventService -d 1', { timeout: 2500 }),
    execAsync('system_profiler SPBluetoothDataType -json', { timeout: 3500 }),
  ]);

  // Parse HID battery entries by MAC address & Product name
  const hidByMac = new Map<string, { product: string; percent: number }>();
  const hidByName = new Map<string, number>();

  if (ioregRes.status === 'fulfilled') {
    const blocks = ioregRes.value.stdout.split(/\+\-o\s+AppleDeviceManagementHIDEventService/);
    for (const block of blocks) {
      const pctMatch = block.match(/"BatteryPercent"\s*=\s*(\d+)/);
      if (!pctMatch) continue;
      const pct = parseInt(pctMatch[1], 10);
      const prodMatch = block.match(/"Product"\s*=\s*"([^"]*)"/);
      const addrMatch = block.match(/"DeviceAddress"\s*=\s*"([^"]+)"/);

      const product = prodMatch ? prodMatch[1].trim() : '';
      const mac = addrMatch ? normalizeMac(addrMatch[1]) : '';

      if (product.includes('Internal')) continue;
      if (mac) {
        hidByMac.set(mac, { product, percent: pct });
      }
      if (product) {
        hidByName.set(product, pct);
      }
    }
  }

  const seenMacs = new Set<string>();

  // Parse Bluetooth connected & nearby Apple ecosystem devices
  if (btRes.status === 'fulfilled') {
    try {
      const data = JSON.parse(btRes.value.stdout);
      const btRoot = data.SPBluetoothDataType?.[0] || {};
      const connectedList: Array<Record<string, Record<string, string>>> = btRoot.device_connected || [];
      const notConnectedList: Array<Record<string, Record<string, string>>> = btRoot.device_not_connected || [];

      const processDeviceEntry = (
        rawName: string,
        info: Record<string, string>,
        isConnected: boolean
      ) => {
        const cleanName = rawName.replace(/\s*📱\s*/g, '').trim();
        const mac = info.device_address ? normalizeMac(info.device_address) : '';
        if (mac) seenMacs.add(mac);

        const devType = classifyDeviceType(cleanName, info.device_minorType);

        // Skip unrelated un-connected third-party/other people's AirPods unless it has live RSSI (nearby) or is user's iPad/Watch/iPhone
        if (!isConnected) {
          const isPersonalEcosystem =
            devType === 'iphone' ||
            devType === 'ipad' ||
            devType === 'watch' ||
            cleanName.toLowerCase().startsWith('nam') ||
            cleanName.toLowerCase().startsWith('ike');
          if (!isPersonalEcosystem || !info.device_rssi) {
            return;
          }
        }

        const hidEntry = mac ? hidByMac.get(mac) : undefined;
        const mainPct = parsePct(info.device_batteryLevelMain) ?? hidEntry?.percent ?? hidByName.get(cleanName) ?? null;
        const leftPct = parsePct(info.device_batteryLevelLeft);
        const rightPct = parsePct(info.device_batteryLevelRight);
        const casePct = parsePct(info.device_batteryLevelCase);

        if (leftPct !== null || rightPct !== null || casePct !== null) {
          // AirPods / Buds with L/R/Case battery levels
          const earPcts = [leftPct, rightPct].filter((x): x is number => x !== null);
          const avgEar = earPcts.length > 0 ? Math.min(...earPcts) : (casePct ?? 100);
          const parts: string[] = [];
          if (leftPct !== null) parts.push(`L:${leftPct}%`);
          if (rightPct !== null) parts.push(`R:${rightPct}%`);
          if (casePct !== null) parts.push(`Case:${casePct}%`);

          devices.push({
            id: `bt-${cleanName.toLowerCase().replace(/\s+/g, '-')}`,
            name: cleanName,
            percent: avgEar,
            statusText: `${avgEar}%`,
            detail: parts.join(' '),
            isConnected,
            type: 'headphones',
          });
          return;
        }

        if (mainPct !== null) {
          devices.push({
            id: `bt-${cleanName.toLowerCase().replace(/\s+/g, '-')}`,
            name: cleanName,
            percent: mainPct,
            statusText: `${mainPct}%`,
            detail: info.device_minorType || (isConnected ? 'Bluetooth' : 'Nearby'),
            isConnected,
            type: devType,
          });
          return;
        }

        // Apple Ecosystem Continuity devices (iPhone, iPad, Apple Watch) in Bluetooth range
        if (devType === 'iphone' || devType === 'ipad' || devType === 'watch') {
          const rssi = info.device_rssi ? `${info.device_rssi} dBm` : '';
          devices.push({
            id: `eco-${cleanName.toLowerCase().replace(/\s+/g, '-')}`,
            name: cleanName,
            percent: null,
            statusText: isConnected ? 'LINKED' : 'NEARBY',
            detail: rssi ? `BLE ${rssi}` : (isConnected ? 'Continuity' : 'Standby'),
            isConnected,
            type: devType,
          });
        }
      };

      for (const entry of connectedList) {
        for (const [name, info] of Object.entries(entry)) {
          processDeviceEntry(name, info, true);
        }
      }

      for (const entry of notConnectedList) {
        for (const [name, info] of Object.entries(entry)) {
          processDeviceEntry(name, info, false);
        }
      }
    } catch {
      // Ignore Bluetooth JSON parse errors
    }
  }

  // 3. Add any remaining HID battery devices that weren't in SPBluetoothDataType
  for (const [mac, entry] of hidByMac.entries()) {
    if (!seenMacs.has(mac)) {
      const name = entry.product || `Apple HID (${mac.slice(-5)})`;
      if (!devices.some((d) => d.name === name)) {
        devices.push({
          id: `hid-${mac}`,
          name,
          percent: entry.percent,
          statusText: `${entry.percent}%`,
          detail: 'Bluetooth HID',
          isConnected: true,
          type: classifyDeviceType(name),
        });
      }
    }
  }

  return devices;
}
