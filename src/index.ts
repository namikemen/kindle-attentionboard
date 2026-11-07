import express from 'express';
import os from 'os';
import { config } from './config';
import { apiRouter } from './routes/api';
import { webRouter } from './routes/web';
import { generateKindleSnapshot } from './render/snapshot';

const app = express();
app.use(express.json());

// Mount routers
app.use('/api', apiRouter);
app.use('/', webRouter);

function getLocalIpAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const ifaceList = interfaces[name];
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }

  return ips;
}

const server = app.listen(config.port, async () => {
  const localIps = getLocalIpAddresses();
  const primaryIp = localIps[0] || 'localhost';

  // Prewarm initial snapshot in the background
  setTimeout(async () => {
    try {
      await generateKindleSnapshot(true);
    } catch {
      // Ignored during startup
    }
  }, 1000);

  // Periodically refresh snapshot every refreshSeconds
  setInterval(async () => {
    try {
      await generateKindleSnapshot(false);
    } catch {
      // Background tick error caught
    }
  }, config.refreshSeconds * 1000);
});

export default app;
