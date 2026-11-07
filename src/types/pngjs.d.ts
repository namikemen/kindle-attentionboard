declare module 'pngjs' {
  export interface PNGImage {
    width: number;
    height: number;
    data: Buffer;
  }

  export interface PNGOptions {
    width?: number;
    height?: number;
    colorType?: number;
    deflateLevel?: number;
  }

  export class PNG implements PNGImage {
    width: number;
    height: number;
    data: Buffer;
    constructor(options?: PNGOptions);
    static sync: {
      read(buffer: Buffer, options?: { skipRescale?: boolean }): PNG;
      write(png: PNGImage, options?: PNGOptions): Buffer;
    };
  }
}
