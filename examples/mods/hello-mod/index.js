// Example user mod. Copy this folder to ~/.glslop-studio/mods/hello-mod/ and reload mods.
// It shows every extension point once: a tool, a wrapped core tool, an advisor rule, a view, a command,
// and an event listener. Delete what you don't need.

export const description = 'Example: one of every extension point.';

export function activate(studio) {
  // 1. A new tool. Callable from the UI, other mods, and agents (HTTP bridge / MCP) immediately.
  studio.tools.add({
    name: 'hello.grayscale',
    description: 'Return a grayscale variant of a corpus shader (wraps gl_FragColor). Does not save anything.',
    input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run({ id }) {
      const { isf } = await studio.call('corpus.get', { id });
      const out = isf.replace(/void\s+main\s*\(\s*\)/, 'void hello_main()') +
        '\nvoid main(){ hello_main(); float g = dot(gl_FragColor.rgb, vec3(0.299,0.587,0.114)); gl_FragColor = vec4(vec3(g), gl_FragColor.a); }\n';
      return { isf: out };
    },
  });

  // 2. Wrap a core tool: every render now also logs to the console. Disabling this mod restores it.
  studio.tools.wrap('render', (old) => ({
    ...old,
    async run(args, ctx) {
      const r = await old.run(args, ctx);
      console.log('[hello-mod] rendered', r.path, r.compileMs, 'ms');
      return r;
    },
  }));

  // 3. An advisor rule: shows up in the viewer's compile-advisor panel and in the `advise` tool.
  const rule = {
    id: 'hello-pow',
    description: 'pow() with a constant 2.0 exponent',
    check: ({ isf }) => [...isf.matchAll(/pow\s*\(([^,]+),\s*2\.0\s*\)/g)].slice(0, 3).map((m) => ({
      rule: 'hello-pow', severity: 'info', message: `pow(${m[1].trim()}, 2.0)`, fix: 'x*x is cheaper and exact.',
    })),
  };
  studio.state.advisorRules.push(rule);

  // 4. A view (framework-agnostic: render into `el`, return a cleanup).
  studio.views.add({
    id: 'hello',
    title: 'hello',
    order: 80,
    mount(el) {
      el.innerHTML = `<div style="padding:16px"><h2>hello from a mod</h2>
        <p>${studio.tools.list().length} tools registered. Edit <code>${studio.host.paths.mods}</code> and run <code>mods.reload</code>.</p>
        <button id="g">grayscale the newest shader</button></div>`;
      el.querySelector('#g').onclick = async () => {
        const [first] = await studio.call('corpus.search', { limit: 1 });
        const { isf } = await studio.call('hello.grayscale', { id: first.id });
        studio.views.open('viewer', { isf, title: first.title + ' (gray)' });
      };
    },
  });

  // 5. A keyboard command.
  studio.commands.add({ id: 'hello.open', title: 'Hello view', key: 'Ctrl+H', run: (s) => s.views.open('hello') });

  // 6. Events.
  const off = studio.events.on('viewer:compiled', (e) => console.log('[hello-mod] compiled', e));

  // Cleanup for things the registries don't track (array pushes, listeners).
  return () => {
    off();
    studio.state.advisorRules = studio.state.advisorRules.filter((r) => r !== rule);
  };
}
