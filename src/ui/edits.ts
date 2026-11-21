// Small pure helpers for the editor, kept out of the components so they can be unit-tested.

/** True when the editor text differs from what is compiled and showing (line endings aside). */
export function unappliedEdits(source: string, applied: string): boolean {
  return source !== applied && source.replace(/\r\n/g, '\n') !== applied.replace(/\r\n/g, '\n');
}

/**
 * True when the editor holds text a human typed and hasn't applied. `lastOutside` is what the last
 * outside update (an agent's setSource) put there: if that failed to compile it is still "unapplied",
 * but it isn't the human's, and the agent must be able to replace it with a fix.
 */
export function humanEdits(source: string, applied: string, lastOutside: string | null): boolean {
  return unappliedEdits(source, applied) && (lastOutside === null || unappliedEdits(source, lastOutside));
}

/** File name for a shader title: "my shader (fork)" -> "my_shader_fork_.fs". Never empty, never a path. */
export function shaderFileName(title: string): string {
  const base = title.replace(/\.fs$/i, '').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  return `${base || 'shader'}.fs`;
}

/**
 * What to do with an autosaved copy when a shader is opened:
 *  'none'    nothing was autosaved, or it matches what is being opened
 *  'offer'   it differs: the human may want it back
 */
export function autosaveAction(opened: string, autosaved: string | null): 'none' | 'offer' {
  if (autosaved === null || !autosaved.trim()) return 'none';
  return unappliedEdits(autosaved, opened) ? 'offer' : 'none';
}
