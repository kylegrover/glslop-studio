// KNOWN LIMITATION: the time recorded stops at link and the nonce is only a comment, so on Vulkan the
// numbers are a warm lower bound, not the cost to first frame. See docs/COMPILE-COST.md.
//
// Core mod: corpus compile bench. Compiles every shader on the current backend and records
// shader.local[backend] = { compile_ms, ok }. Run it once per backend (switch in Settings, relaunch)
// and compare against the reference D3D11/FXC times from glslop.com's measurement batch.
import type { Studio, StudioMod } from '../studio/api';
import type { CorpusShader } from './corpus';
import { compileOnce } from './gl';
import { joinPath } from '../studio/host';

const mod: StudioMod = {
  description: 'Compile-time bench across the corpus, per backend.',
  activate(studio: Studio) {
    let controller: AbortController | null = null;

    studio.tools.add({
      name: 'bench.corpus',
      description: 'Compile every corpus shader (or `ids`) on the current backend, record compile_ms (time to link; on Vulkan a lower bound, see docs/COMPILE-COST.md), return a summary. Slow on D3D11.',
      input: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          force: { type: 'boolean', description: 're-measure shaders already measured on this backend' },
          limit: { type: 'number' },
        },
      },
      async run(args: { ids?: string[]; force?: boolean; limit?: number }, ctx) {
        const corpus = studio.state.corpus;
        if (!corpus) throw new Error('no corpus loaded; run corpus.fetch');
        const backend = studio.host.boot.angleBackend;
        let todo: CorpusShader[] = corpus.shaders.filter((s: CorpusShader) => (!args.ids || args.ids.includes(s.id)) && (args.force || !s.local?.[backend]));
        if (args.limit) todo = todo.slice(0, args.limit);
        controller = new AbortController();
        const signal = ctx.signal ?? controller.signal;
        studio.state.benchRunning = true;
        studio.events.emit('bench:start', { backend, total: todo.length });
        let done = 0;
        try {
          for (const s of todo) {
            if (signal.aborted) break;
            ctx.progress(`${backend}: ${s.title}`, done / todo.length);
            // Let the UI paint between compiles: on Vulkan there is no KHR_parallel_shader_compile, so a
            // compile blocks this thread for its whole duration.
            await new Promise((r) => setTimeout(r, 0));
            const { outcome } = await compileOnce(studio, s.isf);
            s.local = { ...(s.local ?? {}), [backend]: { compile_ms: outcome.compileMs, ok: outcome.ok, at: new Date().toISOString(), ...(outcome.ok ? {} : { error: outcome.errors.join(' | ').slice(0, 400) }) } };
            done++;
            studio.events.emit('bench:result', { id: s.id, backend, ...s.local[backend] });
            if (done % 10 === 0) await studio.state.saveCorpus();
          }
        } finally {
          studio.state.benchRunning = false;
          await studio.state.saveCorpus();
          studio.events.emit('bench:end', { backend, done });
        }
        return studio.call('bench.summary', { backend });
      },
    });

    studio.tools.add({
      name: 'bench.stop',
      description: 'Stop a running bench.corpus after the current shader.',
      run() { controller?.abort(); return { stopped: !!controller }; },
    });

    studio.tools.add({
      name: 'bench.summary',
      description: 'Compare measured compile times on a backend with the reference D3D11/FXC times. Also writes a CSV to the workspace.',
      input: { type: 'object', properties: { backend: { type: 'string' } } },
      async run(args: { backend?: string }) {
        const backend = args.backend ?? studio.host.boot.angleBackend;
        const shaders: CorpusShader[] = studio.state.corpus?.shaders ?? [];
        const rows = shaders.filter((s) => s.local?.[backend]);
        const ok = rows.filter((s) => s.local![backend].ok);
        const ms = ok.map((s) => s.local![backend].compile_ms).sort((a, b) => a - b);
        const pct = (xs: number[], p: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null;
        const paired = ok.filter((s) => s.ref_compile_ms !== undefined);
        const ref = paired.map((s) => s.ref_compile_ms!).sort((a, b) => a - b);
        const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
        const slowRef = paired.filter((s) => s.ref_compile_ms! > 1000);
        const top = paired
          .map((s) => ({ id: s.id, title: s.title, ref_ms: s.ref_compile_ms!, local_ms: s.local![backend].compile_ms }))
          .sort((a, b) => b.ref_ms - a.ref_ms).slice(0, 15);
        const csv = ['id,title,ref_d3d11_ms,' + backend + '_ms,ok']
          .concat(rows.map((s) => [s.id, JSON.stringify(s.title), s.ref_compile_ms ?? '', s.local![backend].compile_ms, s.local![backend].ok].join(',')))
          .join('\n');
        const csvPath = joinPath(studio.host.paths.workspace, `bench-${backend}.csv`);
        await studio.host.writeText(csvPath, csv);
        return {
          backend, measured: rows.length, failed: rows.length - ok.length, of: shaders.length,
          local: { p50: pct(ms, 0.5), p90: pct(ms, 0.9), max: ms.at(-1) ?? null, total_s: +(sum(ms) / 1000).toFixed(1) },
          reference_d3d11_same_shaders: { p50: pct(ref, 0.5), p90: pct(ref, 0.9), max: ref.at(-1) ?? null, total_s: +(sum(ref) / 1000).toFixed(1) },
          speedup_total: paired.length ? +(sum(paired.map((s) => s.ref_compile_ms!)) / Math.max(1, sum(paired.map((s) => s.local![backend].compile_ms)))).toFixed(1) : null,
          over_1s: { reference: slowRef.length, local: ok.filter((s) => s.local![backend].compile_ms > 1000).length },
          slowest_reference: top,
          failures: rows.filter((s) => !s.local![backend].ok).map((s) => ({ id: s.id, title: s.title, error: s.local![backend].error })),
          csv: csvPath,
        };
      },
    });
  },
};
export default mod;
