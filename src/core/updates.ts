// Pure helpers for app updates, kept apart from the Tauri calls so they can be unit-tested.

export type UpdateChannel = 'stable' | 'beta';

/**
 * Which releases this copy follows. An explicit `betaUpdates` setting wins either way; without one,
 * a copy that is itself a prerelease (0.2.0-beta.1) keeps getting betas, so beta testers aren't
 * stranded when the server starts offering only stable builds by default.
 */
export function updateChannel(settings: { betaUpdates?: unknown }, version: string): UpdateChannel {
  if (settings.betaUpdates === true) return 'beta';
  if (settings.betaUpdates === false) return 'stable';
  return version.includes('-') ? 'beta' : 'stable';
}

/** How often a running app looks for an update, from the `updateCheckHours` setting (default 6, 1 to 168). */
export function updateIntervalMs(settings: { updateCheckHours?: unknown }): number {
  const h = Number(settings.updateCheckHours);
  return (Number.isFinite(h) && h > 0 ? Math.min(168, Math.max(1, h)) : 6) * 3_600_000;
}

/**
 * The daily usage count: the first update check of each UTC day adds one to glslop.com's
 * (day, version, os) counter, and nothing else is sent. No install id: the app remembers only the
 * last day it counted itself. Off when the `dailyCount` setting is false.
 * Returns the headers to add to this check, and the day to remember if the check gets through.
 */
export function dailyCountHeaders(
  settings: { dailyCount?: unknown },
  lastDay: string | null | undefined,
  version: string,
  platform: string,
  now = new Date(),
): { headers: Record<string, string>; day: string | null } {
  const day = now.toISOString().slice(0, 10);
  const os = platform === 'windows' || platform === 'macos' || platform === 'linux' ? platform : null;
  if (settings.dailyCount === false || lastDay === day || !os) return { headers: {}, day: null };
  return { headers: { 'x-glslop-daily': '1', 'x-glslop-version': version, 'x-glslop-os': os }, day };
}
