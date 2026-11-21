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
