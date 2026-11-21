// Checks tool arguments against the tool's declared input schema before it runs, so a wrong call
// (an agent sending {source} instead of {isf}) gets a plain message and never half-runs.
//
// Deliberately small: the subset of JSON Schema the tools use (type, required, properties, items,
// enum). Unknown keys are allowed (tools and mods take extras), and unknown schema features are
// ignored rather than rejected.

type Schema = { type?: string | string[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema; enum?: unknown[] };

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matches(v: unknown, type: string): boolean {
  const t = typeOf(v);
  if (type === 'number') return t === 'number' || t === 'integer';
  return t === type;
}

function check(v: unknown, s: Schema | undefined, at: string, out: string[]): void {
  if (!s || typeof s !== 'object') return;
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => matches(v, t))) { out.push(`${at} should be ${types.join(' or ')}, got ${typeOf(v)}`); return; }
  }
  if (s.enum && !s.enum.includes(v)) out.push(`${at} should be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeOf(v) === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (o[k] === undefined) out.push(`${at === 'args' ? '' : at + '.'}${k} is required`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (o[k] !== undefined) check(o[k], sub, at === 'args' ? k : `${at}.${k}`, out);
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => check(x, s.items, `${at}[${i}]`, out));
}

/** Problems with `args` for a tool, or [] if it fits. Unknown argument names are fine. */
export function argProblems(args: unknown, schema: unknown): string[] {
  const out: string[] = [];
  if (!schema) return out;
  check(args ?? {}, schema as Schema, 'args', out);
  return out;
}

/** The names a tool accepts, for the error message. */
export function argNames(schema: unknown): string[] {
  const p = (schema as Schema | undefined)?.properties;
  return p ? Object.keys(p) : [];
}
