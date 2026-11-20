// The publish confirmation window. Deliberately standalone: no mods, no bridge, no app state, no
// shared components. It asks Rust what will be sent (publish_view), shows ALL of it as plain text,
// and reports the human's click (publish_decide). Rust only answers the window it opened for this
// request, and sends exactly the payload it is holding, so nothing here can change what goes out.
import { invoke } from '@tauri-apps/api/core';
import './publish.css';

interface View {
  title: string | null; handle: string; server: string; license: string;
  tags: unknown; parents: unknown; supersedes: string | null; made_with: string | null;
  generator: { model?: unknown; provider?: unknown; prompt?: unknown; [k: string]: unknown } | null;
  poster: string | null; source: string; source_bytes: number; source_lines: number;
  note: string | null; by_agent: boolean; other_fields: string[] | null;
}

// Plain-text DOM only: nothing from the request is ever parsed as HTML.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string | null)[]) {
  const e = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  for (const k of kids) if (k !== null && k !== undefined) e.append(k);
  return e;
}
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function row(label: string, value: Node | string | null, hint?: string) {
  return el('div', { cls: 'row' },
    el('div', { cls: 'k' }, label),
    el('div', { cls: 'v' }, value ?? el('span', { cls: 'none' }, 'none'), hint ? el('div', { cls: 'hint' }, hint) : null));
}
function chips(items: string[], prefix = '') {
  return items.length ? el('span', { cls: 'chips' }, ...items.map((t) => el('span', { cls: 'chip' }, prefix + t))) : null;
}

async function main() {
  const root = document.getElementById('root')!;
  let view: View;
  try {
    view = (await invoke('publish_view')) as View;
  } catch (e) {
    root.replaceChildren(el('p', { cls: 'err' }, `Nothing to confirm here (${String(e)}). You can close this window.`));
    return;
  }

  const gen = view.generator && typeof view.generator === 'object' ? view.generator : null;
  const aiBits = gen ? [str(gen.model), str(gen.provider)].filter(Boolean).join(' · ') : '';
  const prompt = gen ? str(gen.prompt) : null;

  const source = el('details', { cls: 'source' },
    el('summary', {}, `shader source: ${view.source_lines} lines, ${kb(view.source_bytes)} (click to read it all)`),
    el('pre', {}, view.source));

  const fields = el('div', { cls: 'fields' }, // rows that don't apply are null and skipped by el()
    row('title', view.title),
    row('posted as', `@${view.handle}`, `on ${view.server}`),
    row('license', view.license),
    row('tags', chips(list(view.tags))),
    row('made with', str(view.made_with)),
    row('AI credit', gen ? el('span', {}, aiBits || 'declared (no model named)') : null,
      gen ? 'shown on the shader page as AI-assisted' : 'none: posted as hand-made'),
    prompt ? row('prompt', el('div', { cls: 'prompt' }, prompt), 'published with the shader') : null,
    row('forked from', chips(list(view.parents), '#')),
    view.supersedes ? row('replaces', `your shader #${view.supersedes}`, 'the old one stays reachable but leaves browse') : null,
    view.other_fields?.length ? row('also sent', view.other_fields.join(', ')) : null,
  );

  const cancel = el('button', { cls: 'btn', type: 'button', textContent: 'not yet' });
  const approve = el('button', { cls: 'btn go', type: 'button', textContent: 'publish', disabled: true });
  // A click or keypress already in flight when the window opened must not land on "publish".
  setTimeout(() => (approve.disabled = false), 700);
  const decide = async (yes: boolean) => {
    cancel.disabled = approve.disabled = true;
    approve.textContent = yes ? 'publishing…' : 'publish';
    try { await invoke('publish_decide', { approve: yes }); } catch { /* window is closing */ }
  };
  cancel.onclick = () => decide(false);
  approve.onclick = () => decide(true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') decide(false); });

  root.replaceChildren(...[
    el('header', {},
      el('span', { cls: 'kicker' }, 'publish to glslop'),
      el('h1', {}, view.title ?? 'untitled'),
      view.by_agent ? el('div', { cls: 'agent' }, 'Your agent prepared this. Nothing goes out unless you click publish.') : null),
    el('div', { cls: 'scroll' }, ...[el('div', { cls: 'body' },
      el('div', { cls: 'poster' }, view.poster ? el('img', { src: view.poster, alt: 'poster' }) : el('div', { cls: 'noposter' }, 'no poster')),
      fields),
    view.note ? el('div', { cls: 'note' }, el('b', {}, 'from the app: '), view.note) : null,
    source as HTMLElement].filter((n): n is HTMLElement => n !== null)),
    el('footer', {},
      el('span', { cls: 'muted' }, 'Everything above is exactly what will be sent. CC0 means no take-backs.'),
      el('span', { cls: 'buttons' }, cancel, approve)),
  ].filter((n): n is HTMLElement => n !== null));
  cancel.focus();
}

main();
