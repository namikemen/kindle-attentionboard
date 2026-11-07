import fs from 'fs';
import path from 'path';

// Minimal .env loader so the documented configuration file actually works.
// Existing environment variables always win over values in the file.
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

export interface AppConfig {
  port: number;
  refreshSeconds: number;
  kindleWidth: number;
  kindleHeight: number;
  weatherUnits: 'celsius' | 'fahrenheit';
  focusWorkMinutes: number;
  focusBreakMinutes: number;
  chromePath: string;
  mediaHelperPath: string;
}

function resolveBinPath(binaryName: string): string {
  const fromDirname = path.resolve(__dirname, '../bin', binaryName);
  if (fs.existsSync(fromDirname)) return fromDirname;
  const fromParentDirname = path.resolve(__dirname, '../../bin', binaryName);
  if (fs.existsSync(fromParentDirname)) return fromParentDirname;
  return path.resolve(process.cwd(), 'bin', binaryName);
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '8787', 10),
  refreshSeconds: parseInt(process.env.REFRESH_SECONDS || '60', 10),
  kindleWidth: parseInt(process.env.KINDLE_WIDTH || '1236', 10),
  kindleHeight: parseInt(process.env.KINDLE_HEIGHT || '1648', 10),
  weatherUnits: (process.env.WEATHER_UNITS === 'fahrenheit' ? 'fahrenheit' : 'celsius'),
  focusWorkMinutes: parseInt(process.env.FOCUS_WORK_MINUTES || '25', 10),
  focusBreakMinutes: parseInt(process.env.FOCUS_BREAK_MINUTES || '5', 10),
  chromePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  mediaHelperPath: resolveBinPath('media-helper'),
};
