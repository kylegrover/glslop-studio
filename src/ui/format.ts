export function fmtMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return '?';
  if (ms >= 10000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
export function speedClass(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return 'unk';
  return ms > 10000 ? 'heavy' : ms > 1000 ? 'slow' : ms > 500 ? 'mid' : 'fast';
}
