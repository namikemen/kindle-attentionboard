import crypto from 'crypto';
import { PNG } from 'pngjs';
import { generateKindleSnapshot, pinSnapshot, TabId } from './snapshot';

/**
 * Tile-diff transport for the Kindle client.
 *
 * The full dashboard is still rendered exactly once per refresh by headless
 * Chrome. Instead of shipping that whole 1236x1648 PNG to the device every
 * cycle, the server slices it into horizontal bands, hashes each band's
 * pixels, and exposes:
 *
 *   GET /dash/manifest   -> one line per band: index x y w h hash
 *   GET /dash/tile?i=N   -> only that band, as PNG
 *
 * The Kindle compares the manifest hashes against the hashes it remembers
 * from the previous cycle, downloads only the bands that actually changed,
 * and repaints only those rectangles.
 */

export interface TileRect {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileInfo extends TileRect {
  hash: string;
}

interface FrameCache {
  /** Identity of the source buffer. Same object => same rendered frame. */
  buffer: Buffer;
  png: PNG;
  tiles: TileInfo[];
  /** Lazily encoded tile PNGs, indexed by tile index. */
  encoded: Map<number, Buffer>;
}

const DEFAULT_TILE_HEIGHT = 190;
/** Keep a rendered frame alive while the Kindle fetches its tiles. */
const MANIFEST_PIN_MS = 30_000;

let frame: FrameCache | null = null;

function tileHeight(): number {
  const raw = parseInt(process.env.TILE_HEIGHT || '', 10);
  return Number.isFinite(raw) && raw >= 64 ? raw : DEFAULT_TILE_HEIGHT;
}

function hashRegion(png: PNG, x: number, y: number, w: number, h: number): string {
  const hash = crypto.createHash('sha1');
  for (let row = y; row < y + h; row++) {
    const start = (row * png.width + x) * 4;
    hash.update(png.data.subarray(start, start + w * 4));
  }
  return hash.digest('hex').slice(0, 16);
}

function buildTiles(png: PNG): TileInfo[] {
  const bands: TileInfo[] = [];
  const height = tileHeight();
  for (let y = 0, index = 0; y < png.height; y += height, index++) {
    const h = Math.min(height, png.height - y);
    bands.push({ index, x: 0, y, w: png.width, h, hash: hashRegion(png, 0, y, png.width, h) });
  }
  return bands;
}

/**
 * Decode the current snapshot for a tab. The decode is cached as long as the
 * underlying PNG Buffer is the same object, so repeated manifest/tile
 * requests within one Kindle cycle do no repeated work.
 */
async function ensureFrame(tab: TabId): Promise<FrameCache> {
  const buffer = await generateKindleSnapshot(false, tab);
  if (frame && frame.buffer === buffer) {
    return frame;
  }
  const png = PNG.sync.read(buffer);
  frame = {
    buffer,
    png,
    tiles: buildTiles(png),
    encoded: new Map(),
  };
  return frame;
}

function encodeTile(png: PNG, tile: TileRect): Buffer {
  const out = new PNG({ width: tile.w, height: tile.h });
  for (let row = 0; row < tile.h; row++) {
    const src = ((tile.y + row) * png.width + tile.x) * 4;
    png.data.copy(out.data, row * tile.w * 4, src, src + tile.w * 4);
  }
  return PNG.sync.write(out);
}

export async function getTileManifest(tab: TabId): Promise<string> {
  const current = await ensureFrame(tab);
  // A Kindle on WiFi can take a few seconds between the manifest and the last
  // tile. Hold this exact frame so every tile in a batch comes from one render.
  pinSnapshot(tab, MANIFEST_PIN_MS);

  const frameId = crypto.createHash('sha1').update(current.buffer).digest('hex').slice(0, 16);
  const lines = [`SIZE ${current.png.width} ${current.png.height}`, `FRAME ${frameId}`];
  for (const tile of current.tiles) {
    lines.push(`${tile.index} ${tile.x} ${tile.y} ${tile.w} ${tile.h} ${tile.hash}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function getTile(tab: TabId, index: number): Promise<Buffer | null> {
  const current = await ensureFrame(tab);
  const tile = current.tiles.find((candidate) => candidate.index === index);
  if (!tile) return null;

  const cached = current.encoded.get(index);
  if (cached) return cached;

  const encoded = encodeTile(current.png, tile);
  current.encoded.set(index, encoded);
  return encoded;
}
