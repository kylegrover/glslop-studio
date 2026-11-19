# Compile cost: the guide the `advise` tool cites

Distilled from glslop's craft.txt ("The compile budget") and `scripts/glslop.mjs` (`loopBudget`),
calibrated on 213 corpus shaders measured through ANGLE → D3D11 → FXC on an RTX 3090 (2026-09).

## Why it matters even though the studio is fast

The studio runs ANGLE on Vulkan by default. On an RTX 3090 (2026-11-18), the ten slowest corpus
shaders, timed from source to first drawn frame with the driver cache defeated:

| | fastest of the ten | slowest of the ten | total |
|---|---|---|---|
| d3d11 / FXC (Chrome's default on Windows) | 32 s | 351 s | 1369 s |
| vulkan (studio default), cold | 0.8 s | 12.4 s | 40 s |

So heavy shaders are roughly **10–200× faster** cold, shader by shader. Once the GPU driver has cached
a shader, the same first frame takes 20–100 ms. But **glslop.com visitors on Windows still pay the FXC
number.** A shader that starts instantly here can still freeze a visitor's tab. Use `advise`, or
relaunch on d3d11 (settings) to measure before publishing.

### Known limitation: the bench under-reports on Vulkan

`compile`, `bench.corpus` and the "ms compile" figures in the UI stop the clock when the program
links. On D3D11 that is nearly the whole cost. On Vulkan the driver defers most of the work to the
first draw, so those figures are far too low there (the whole corpus "compiles in 2.5 s" by that clock).
The "cold" option also only defeats ANGLE's cache, not the driver's, so a repeat run is warm.

To fix (not done yet): time through the first drawn frame plus a readback, and make cold runs change
the shader in a way the driver cannot cache around (a comment is not enough; a tiny random constant in
the output is). Until then, treat Vulkan numbers from these tools as a lower bound.

## The rules

FXC inlines every function call, and its time grows faster than linearly with the straight-line code it
ends up holding. **Count call sites, not loop trips.**

1. **Every call outside a loop is a full copy** of everything that call reaches. One shade() of about
   660 statements called from 7 places took 9.5 s. The same 7 evaluations as one call inside a 7-trip
   loop took 0.8 s. → `repeated-heavy-call`
2. **Normals with 4–6 hand-written map() taps** are 4–6 copies of map(). Loop over the tetrahedron taps
   with a single call site. → `normal-taps`
3. **A loop body compiles about once**, however many trips it makes. Moving repeated work *into* a loop
   is a fix. A lean 100-step march is fine.
4. **Big if/else chains cost their size.** Making them branchless doesn't help. One loop that derives
   each case's parameters from the index cut compile time 7.8×. → `big-if-chain`
5. **Conditional writes into mat2/3/4 arrays** compile about 7× slower than parallel vec4 arrays.
   → `mat-array-write`
6. **Deep nests of constant loops** can be fully unrolled by FXC. Every compile over 100 s in the corpus
   has more than 200k unrolled statements. Flatten nests and cut trip counts. → `nested-constant-loops`

The estimate's thresholds (inlined statements, each loop body counted once): ≥400 usually misses 500 ms
on FXC, ≥1,000 usually takes seconds, and every measured shader past 4,000 took over 10 s. Run-to-run
noise is about ±10%. Re-measure the baseline before trusting a change of less than about 1.3×. To find
the cost, stub one function at a time (return a constant) and measure again.

## Adding rules

`studio.state.advisorRules` is a plain array of `{ id, description, check({ isf, translated, compileMs,
backend, budget }) => [{ rule, severity, line?, message, fix? }] }`. Push your own from a mod. The
`translated` field is the backend-translated source (HLSL on d3d11, GLSL on vulkan/gl). It is useful
for rules that look at what the driver actually received.
