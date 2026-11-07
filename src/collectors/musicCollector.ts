import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { config } from '../config';

const execAsync = promisify(exec);

export interface NowPlayingTrack {
  isPlaying: boolean;
  hasMedia: boolean;
  title: string;
  artist: string;
  album: string;
  duration: number;
  elapsed: number;
  progressPercent: number;
  source: string;
  imageSrc?: string;
}

const emptyTrack: NowPlayingTrack = {
  isPlaying: false,
  hasMedia: false,
  title: 'No media playing',
  artist: 'Idle',
  album: '',
  duration: 0,
  elapsed: 0,
  progressPercent: 0,
  source: 'None',
};

function getYouTubeMusicApiPort(): number {
  try {
    const cfgPath = path.join(os.homedir(), 'Library/Application Support/YouTube Music/config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const port = cfg?.plugins?.['api-server']?.port;
      if (typeof port === 'number' && port > 0) {
        return port;
      }
    }
  } catch {
    // Fallback to default port
  }
  return 26538;
}

export async function getNowPlaying(): Promise<NowPlayingTrack> {
  // Strategy 1: YouTube Music Desktop App built-in API server (port 26538)
  const ytmPort = getYouTubeMusicApiPort();
  try {
    const res = await fetch(`http://127.0.0.1:${ytmPort}/api/v1/song`, {
      signal: AbortSignal.timeout(1200),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        title?: string;
        artist?: string;
        album?: string;
        isPaused?: boolean;
        songDuration?: number;
        elapsedSeconds?: number;
        imageSrc?: string;
      };
      if (data && (data.title || data.artist)) {
        const duration = typeof data.songDuration === 'number' ? data.songDuration : 0;
        const elapsed = typeof data.elapsedSeconds === 'number' ? data.elapsedSeconds : 0;
        const progressPercent = duration > 0 ? Math.min(100, Math.round((elapsed / duration) * 100)) : 0;
        return {
          isPlaying: !data.isPaused,
          hasMedia: true,
          title: data.title || 'Unknown Title',
          artist: data.artist || 'Unknown Artist',
          album: data.album || '',
          duration,
          elapsed,
          progressPercent,
          source: 'YouTube Music',
          imageSrc: data.imageSrc || undefined,
        };
      }
    }
  } catch {
    // Fall through
  }

  // Strategy 1b: YouTube Music Amuse companion query server (port 9863)
  try {
    const res = await fetch('http://127.0.0.1:9863/query', {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        player?: { hasSong?: boolean; isPaused?: boolean; seekbarCurrentPosition?: number };
        track?: { title?: string; author?: string; album?: string; duration?: number };
      };
      if (data?.player?.hasSong && data.track?.title) {
        const duration = typeof data.track.duration === 'number' ? data.track.duration : 0;
        const elapsed = typeof data.player.seekbarCurrentPosition === 'number' ? data.player.seekbarCurrentPosition : 0;
        const progressPercent = duration > 0 ? Math.min(100, Math.round((elapsed / duration) * 100)) : 0;
        return {
          isPlaying: !data.player.isPaused,
          hasMedia: true,
          title: data.track.title,
          artist: data.track.author || 'Unknown Artist',
          album: data.track.album || '',
          duration,
          elapsed,
          progressPercent,
          source: 'YouTube Music',
        };
      }
    }
  } catch {
    // Fall through
  }

  // Strategy 2: Native macOS MediaRemote framework helper
  if (fs.existsSync(config.mediaHelperPath)) {
    try {
      const { stdout } = await execAsync(`"${config.mediaHelperPath}"`, { timeout: 2000 });
      const raw = JSON.parse(stdout.trim());
      if (raw && (raw.title || raw.artist)) {
        const duration = typeof raw.duration === 'number' ? raw.duration : 0;
        const elapsed = typeof raw.elapsed === 'number' ? raw.elapsed : 0;
        const progressPercent = duration > 0 ? Math.min(100, Math.round((elapsed / duration) * 100)) : 0;

        return {
          isPlaying: Boolean(raw.isPlaying),
          hasMedia: true,
          title: raw.title || 'Unknown Title',
          artist: raw.artist || 'Unknown Artist',
          album: raw.album || '',
          duration,
          elapsed,
          progressPercent,
          source: 'System Media',
        };
      }
    } catch {
      // Fall through to AppleScript fallback
    }
  }

  // Strategy 3: Apple Music / Spotify AppleScript fallback
  const script = `
    set out to ""
    try
      if application "Spotify" is running then
        tell application "Spotify"
          if player state is playing then
            return "Spotify|||" & (name of current track) & "|||" & (artist of current track) & "|||" & (album of current track) & "|||" & (player position) & "|||" & (duration of current track / 1000) & "|||playing"
          end if
        end tell
      end if
    end try

    try
      if application "Music" is running then
        tell application "Music"
          if player state is playing then
            return "Apple Music|||" & (name of current track) & "|||" & (artist of current track) & "|||" & (album of current track) & "|||" & (player position) & "|||" & (duration of current track) & "|||playing"
          end if
        end tell
      end if
    end try
    return ""
  `;

  try {
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 2500 });
    const trimmed = stdout.trim();
    if (trimmed) {
      const [source, title, artist, album, elapsedStr, durationStr] = trimmed.split('|||');
      const elapsed = parseFloat(elapsedStr) || 0;
      const duration = parseFloat(durationStr) || 0;
      const progressPercent = duration > 0 ? Math.min(100, Math.round((elapsed / duration) * 100)) : 0;

      return {
        isPlaying: true,
        hasMedia: true,
        title: title || 'Unknown Title',
        artist: artist || 'Unknown Artist',
        album: album || '',
        duration,
        elapsed,
        progressPercent,
        source: source || 'macOS Media',
      };
    }
  } catch {
    // Ignore AppleScript timeouts
  }

  return emptyTrack;
}
