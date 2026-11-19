declare module 'gifenc' {
  export interface GifEncoder {
    writeFrame(index: Uint8Array, width: number, height: number, options?: Record<string, unknown>): void;
    finish(): void;
    bytes(): Uint8Array<ArrayBuffer>;
  }

  export function GIFEncoder(): GifEncoder;
  export function quantize(rgba: Uint8ClampedArray, maxColors: number): number[][];
  export function applyPalette(rgba: Uint8ClampedArray, palette: number[][]): Uint8Array;
}
