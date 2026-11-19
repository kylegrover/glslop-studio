// Content for the /glsl technique pages.
//
// Prose lives in the repo, not the database, on purpose: these are permanent landing pages that
// carry an educational claim, so they should move through review like code. An automated pass may
// PROPOSE edits here, but a human merges them.
//
// Each page pairs an explainer with a MINIMAL RUNNABLE EXAMPLE — that is the part no blog post can
// match, and the reason these pages belong on glslop rather than anywhere else. Every `example`
// below is compile-checked against the render harness by `npm run glsl:verify`.

export interface Excerpt {
  /** shader id in the corpus — the excerpt must actually appear in it */
  shaderId: string;
  label: string;
  code: string;
  note: string;
}

export interface GlslPage {
  slug: string;
  /** canonical vocab technique this page is about — drives gallery membership */
  technique: string;
  title: string;
  /** one line, used as the meta description and the index-card blurb */
  summary: string;
  /** the explainer, one string per paragraph */
  explainer: string[];
  example: { isf: string; caption: string };
  excerpts?: Excerpt[];
}

const RAYMARCH_EXAMPLE = `/*{
  "DESCRIPTION": "Minimal raymarcher: one sphere, one floor, one loop.",
  "CREDIT": "glslop",
  "CATEGORIES": ["education"],
  "INPUTS": [
    { "NAME": "steps", "TYPE": "float", "DEFAULT": 48.0, "MIN": 4.0, "MAX": 128.0 }
  ]
}*/

// The signed distance function IS the scene. No meshes, no vertices --
// just "how far is the nearest surface from this point in space?"
float map(vec3 p) {
  float sphere = length(p - vec3(0.0, 0.2, 4.0)) - 1.0;
  float ground = p.y + 1.0;
  return min(sphere, ground);   // min() = union of the two shapes
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / RENDERSIZE.y;

  vec3 ro = vec3(sin(TIME * 0.5) * 2.0, 0.6, 0.0);  // camera position
  vec3 rd = normalize(vec3(uv, 1.2));               // one ray per pixel

  // ---- the march ----
  float t = 0.0;                       // how far along the ray we are
  float d = 1.0;
  for (int i = 0; i < 128; i++) {
    if (float(i) >= steps) break;
    d = map(ro + rd * t);              // distance to the nearest surface
    if (d < 0.002 || t > 30.0) break;  // hit it, or escaped the scene
    t += d;                            // a jump of d is always safe
  }

  // shade by distance travelled: near is bright, far fades out. The range is tight
  // on purpose -- across the face of the sphere t varies by about a unit, so a short
  // range is what makes it read as round instead of as a flat white disc.
  float fog = 1.0 - clamp((t - 2.0) / 5.0, 0.0, 1.0);
  vec3 col = d < 0.002 ? vec3(fog) : vec3(0.02, 0.02, 0.04);
  gl_FragColor = vec4(col, 1.0);
}
`;

const THIN_FILM_EXAMPLE = `/*{
  "DESCRIPTION": "Thin-film interference on a sphere: one phase, three wavelengths.",
  "CREDIT": "glslop",
  "CATEGORIES": ["education"],
  "INPUTS": [
    { "NAME": "thickness", "TYPE": "float", "DEFAULT": 1.6, "MIN": 0.3, "MAX": 4.0 }
  ]
}*/

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / RENDERSIZE.y;
  float r = length(uv) / 0.72;
  if (r > 1.0) { gl_FragColor = vec4(0.01, 0.01, 0.02, 1.0); return; }

  // fake a sphere so there is a surface normal to work with
  vec3 n = vec3(uv / 0.72, sqrt(max(0.0, 1.0 - r * r)));
  float cosTheta = n.z;                      // angle between normal and viewer

  // Optical path difference: light entering at a glancing angle travels further
  // through the film, so the phase grows toward the rim. That is why the bands
  // bunch up at the edge of a real bubble. Bounded below -- unclamped, the bands
  // near the silhouette get finer than a pixel and alias into rainbow confetti.
  float opd = thickness * (1.6 + 0.4 * sin(TIME * 0.4)) / max(cosTheta, 0.30);

  // THE TRICK: one phase, three wavelengths. Red is the longest, so it cycles
  // slowest; blue the shortest, so it cycles fastest. Their disagreement is colour.
  vec3 phase = opd * 6.2831 * vec3(1.0, 0.85, 0.72);
  vec3 film = 0.5 + 0.5 * cos(phase);

  // more of the film reflection survives at glancing angles (Fresnel)
  float fresnel = pow(1.0 - cosTheta, 3.0);
  float edge = smoothstep(1.0, 0.96, r);     // soft silhouette, no jaggy circle
  gl_FragColor = vec4(film * (0.45 + 0.55 * fresnel) * edge, 1.0);
}
`;

const FEEDBACK_EXAMPLE = `/*{
  "DESCRIPTION": "Feedback trail: the frame reads its own past, zoomed a fraction.",
  "CREDIT": "glslop",
  "CATEGORIES": ["education"],
  "INPUTS": [
    { "NAME": "decay", "TYPE": "float", "DEFAULT": 0.965, "MIN": 0.80, "MAX": 0.998 },
    { "NAME": "zoom", "TYPE": "float", "DEFAULT": 0.996, "MIN": 0.980, "MAX": 1.010 }
  ],
  "PASSES": [
    { "TARGET": "trail", "PERSISTENT": true },
    { }
  ]
}*/

void main() {
  vec2 uv = isf_FragNormCoord;

  if (PASSINDEX == 0) {
    // ---- the feedback pass ----
    // Read the PREVIOUS contents of this same buffer, sampled slightly zoomed.
    // Sampling "wrong" on purpose is what turns a static smear into motion:
    // every frame drags the whole history outward a little.
    vec2 warped = (uv - 0.5) * zoom + 0.5;
    vec3 prev = IMG_NORM_PIXEL(trail, warped).rgb * decay;

    // one small orbiting dot, drawn on top
    float aspect = RENDERSIZE.x / RENDERSIZE.y;
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    vec2 head = 0.30 * vec2(cos(TIME * 1.3), sin(TIME * 0.9));
    float ink = smoothstep(0.030, 0.0, length(p - head));

    gl_FragColor = vec4(max(prev, ink * vec3(0.55, 1.0, 0.35)), 1.0);
  } else {
    // ---- the display pass ---- just show the buffer
    gl_FragColor = IMG_NORM_PIXEL(trail, uv);
  }
}
`;

export const GLSL_PAGES: GlslPage[] = [
  {
    slug: 'raymarching',
    technique: 'raymarch',
    title: 'Raymarching',
    summary:
      'How a fragment shader draws 3D without any geometry: march a ray forward in steps that are guaranteed safe, using a function that measures distance to the nearest surface.',
    explainer: [
      'A fragment shader gets one job per pixel: return a colour. It is not handed triangles, vertices, or a depth buffer. So to draw a 3D scene it has to answer, for this one pixel, the question "what would I see looking in this direction?" — and answer it from scratch, in a few hundred instructions.',
      'Raymarching answers it by walking. Fire a ray from the camera through the pixel and step along it until you bump into something. The trick is knowing how big a step is safe. That comes from a signed distance function: a function that takes a point in space and returns the distance to the nearest surface, negative if you are inside it. A sphere of radius 1 at the origin is just length(p) - 1.0.',
      'If the nearest surface is 3 units away, you can safely jump 3 units in any direction without passing through anything. So you jump, ask again, and jump again. Far from the scene the steps are huge; as you approach a surface they shrink, and the ray glides in and stops. That is the whole algorithm, and it is why the loop below is six lines long.',
      'What you get for that is unusual. The scene is a mathematical function rather than a mesh, so it has infinite resolution — zoom forever and the sphere stays a perfect sphere. Objects combine with min (union) and max (intersection). Repeat space with mod and you get infinite copies for the price of one. Blend two shapes with a soft minimum and they melt together, which is a nightmare with polygons and one line here.',
      'The cost is that every pixel pays for the whole scene on every frame, and the step count trades directly against speed. Pull the iteration slider down on the example and you can watch the surface come apart — the ray runs out of steps before it arrives, and the shape dissolves into fog.',
    ],
    example: {
      caption:
        'A sphere and a floor, marched. The whole algorithm is the six lines after "the march" — everything else is camera setup and shading.',
      isf: RAYMARCH_EXAMPLE,
    },
    excerpts: [
      {
        shaderId: 'gstbkfmm',
        label: "the march loop",
        code: `const float TMAX = 48.0;
float t = 0.0;
float d = 0.0;
for (int i = 0; i < 150; i++){
    d = map(ro + rd * t);
    if (d < 0.0013 * (1.0 + t * 1.2) || t > TMAX) break;
    t += d * 0.8;
}`,
        note:
          "Sphere tracing, entire. map() returns a lower bound on the distance to the nearest surface, so stepping exactly that far can never overshoot — that guarantee is the whole algorithm. The * 0.8 is a safety factor for when a domain warp makes the estimate lie a little; this shader calls that out further up as keeping the field Lipschitz-safe. The hit epsilon grows with t because a pixel covers more world space the further away it is, so a fixed epsilon both wastes steps in the distance and shimmers.",
      },
      {
        shaderId: 'gstbkfmm',
        label: "the normal, for free",
        code: `vec3 calcNormal(vec3 p){
    vec2 e = vec2(0.0015, -0.0015);
    return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) +
                     e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}`,
        note:
          "There is no mesh, so there is no normal to look up — you take the gradient of the distance field instead. This is the tetrahedron trick: four offsets arranged so the swizzles e.xyy / e.yyx / e.yxy / e.xxx both move the sample point AND weight the result, which gets a normal in four map() calls rather than the six a naive central difference needs.",
      },
    ],
  },
  {
    slug: 'thin-film',
    technique: 'thin_film',
    title: 'Thin-film interference',
    summary:
      'Why soap bubbles and oil slicks have colour when neither the soap nor the oil is coloured — and how to get the same effect from three cosines and a viewing angle.',
    explainer: [
      'Hold a soap bubble up to the light and it is not soap-coloured. It is magenta at one angle, gold at another, and the bands slide as you tilt it. Nothing in the film is pigmented. The colour is made by the geometry of the film itself.',
      'Light hitting a thin transparent layer partly reflects off the front surface and partly off the back. The second reflection has travelled further — twice the film thickness, adjusted for the angle it entered at. When the two recombine they interfere: if the extra distance happens to be a whole number of wavelengths they reinforce each other, and if it is half a wavelength they cancel.',
      'Here is the part that makes it colourful. That extra distance is a fixed length, but a wavelength is not — red light is roughly twice the wavelength of violet. So a thickness that perfectly reinforces red will do something else entirely to blue. Every thickness produces a different mix of surviving wavelengths, and that mix is the colour you see.',
      'In a shader this collapses to something remarkably small. Work out the extra path length from thickness and viewing angle, then evaluate a cosine at three different rates — one per channel, standing in for three wavelengths. The per-channel offset is not a stylistic choice; it is the physics.',
      'It is worth separating this from the cosine palette it resembles. A cosine palette maps some arbitrary scalar to a pretty gradient, and about 62% of the shaders in this corpus use one. Thin film is the same machinery pointed at something specific: the phase has to come from a thickness and a view angle. That is why the colour tracks the geometry and sweeps around the rim as the surface curves away from you, instead of just being a nice gradient.',
    ],
    example: {
      caption:
        'A bubble. Push the thickness slider and the bands sweep through the spectrum, because each channel peaks at a different path length.',
      isf: THIN_FILM_EXAMPLE,
    },
    excerpts: [
      {
        shaderId: '1vw9jiim',
        label: "angle in, spectrum out",
        code: `// thin-film iridescence keyed to the viewing angle and the slope
float film = pow(1.0 - max(dot(N, V), 0.0), 2.2) + N.x * 0.5 + N.z * 0.5;
vec3 irid = 0.5 + 0.5 * cos(TAU * (vec3(0.0, 0.33, 0.67) + film * 2.6 + t * 0.06 + hu));`,
        note:
          "The whole effect is two ideas on one line. pow(1.0 - dot(N, V), 2.2) is a Fresnel-ish grazing term: near zero where the surface faces you, near one at the silhouette. Feed that into a cosine and offset each channel by a third of a cycle — vec3(0.0, 0.33, 0.67) — and red, green and blue peak at different angles. That is what a soap film physically does as the light path through it lengthens.",
      },
      {
        shaderId: 'l8ofptgk',
        label: "the same three lines, elsewhere",
        code: `float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.4);
vec3 sheenHue = 0.5 + 0.5*cos(TAU*(vec3(0.00, 0.33, 0.67) + fres*1.35 + arc*0.9));
vec3 sheen = mix(mix(base, vec3(0.55, 0.72, 1.00), fres*0.45), sheenHue, 0.33*gloss);`,
        note:
          "Worth seeing twice. Same structure, different animal: fres here uses -rd rather than a separate view vector, because in a raymarcher the ray direction IS the view direction. Once you recognise 0.5 + 0.5*cos(TAU*(vec3(0.0, 0.33, 0.67) + x)) you will start finding it in most of the iridescent shaders here — a cosine palette with its phase driven by viewing angle instead of by position.",
      },
    ],
  },
  {
    slug: 'feedback',
    technique: 'feedback',
    title: 'Feedback',
    summary:
      'Give a shader a memory of its own last frame and it stops drawing pictures and starts growing them — trails, smoke, reaction-diffusion, and most things that look alive.',
    explainer: [
      'Every shader on this site is, by default, amnesiac. It is handed a time value and a pixel coordinate and must produce a colour with no knowledge of what it drew a sixtieth of a second ago. That is a real constraint: the image has to be a pure function of time, so anything that should accumulate — a trail, a burn-in, a slowly spreading stain — cannot be expressed at all.',
      'Feedback removes the constraint. You render into an offscreen buffer, mark it persistent so it survives into the next frame, and on that next frame you read it back as a texture. The shader can now see its own past.',
      'The simplest thing to do with that is a decaying trail: read the previous frame, multiply it by something slightly under one, draw a bright dot on top, write the result back. The dot leaves a tail that fades over a few dozen frames. Multiply by 0.90 and it is a short smear; by 0.99 and it hangs in the air for seconds.',
      'The move that turns this from a smear into a world is sampling the previous frame at slightly the wrong coordinate. Read it a fraction zoomed in and everything you drew drifts outward, so a stationary dot becomes a tunnel. Read it rotated and the whole history spirals. Displace it by a noise field and you get smoke. The buffer is not just storage — it is a substrate you can push around, and the shape of that push is the entire look.',
      'One practical consequence, because it bites: a feedback shader advances its state once per draw, not per unit of time. It has no idea how many seconds passed. So the same shader recorded at 30fps evolves at exactly half the speed it does at 60fps, even though every other shader here is a continuous function of TIME and does not care what frame rate you render it at.',
    ],
    example: {
      caption:
        'One dot, and a buffer that remembers it. The second pass only displays the buffer — all the work is pass 0 reading its own previous output, very slightly zoomed.',
      isf: FEEDBACK_EXAMPLE,
    },
    excerpts: [
      {
        shaderId: 'mpl4an6o',
        label: "declaring a buffer that survives the frame",
        code: `"PASSES": [
  { "TARGET": "ink", "PERSISTENT": true, "FLOAT": true },
  { "TARGET": "echoes", "PERSISTENT": true, "FLOAT": true },`,
        note:
          "PERSISTENT is the feature: the target keeps its contents between frames instead of being cleared, so pass 0 can read what pass 0 wrote last frame. FLOAT matters more than it looks — an 8-bit target quantises on every write, and a value multiplied by 0.974 a few hundred times needs the headroom or the trail stair-steps and dies early.",
      },
      {
        shaderId: 'mpl4an6o',
        label: "reading the past at an offset",
        code: `vec2 previous = IMG_NORM_PIXEL(ink, uv - flow * (0.00135 + energy * 0.00075)).rg;`,
        note:
          "Reading the previous frame at a SHIFTED uv is what turns a memory buffer into motion. Each frame the field is resampled a fraction of a pixel along flow, so a single injected dot smears into a streak that follows the field. Sample at the same uv instead and you get decay with no movement at all.",
      },
      {
        shaderId: 'mpl4an6o',
        label: "the one line it all reduces to",
        code: `vec2 state = previous * decay + injection * energy * vec2(0.145, 0.13);`,
        note:
          "Keep most of what was there, add a little of what is new. decay is exposed as a slider bounded at 0.9 to 0.999, and that range is the interesting part: the useful values live very close to 1.0. At the 0.974 default a trail is at half brightness after about 26 frames; at 0.999 it takes roughly 700. The gap between those two numbers is the difference between a smear and a permanent scar.",
      },
    ],
  },
];

export const pageForSlug = (slug: string): GlslPage | undefined => GLSL_PAGES.find((p) => p.slug === slug);

/** The technique -> page lookup behind the "we have a page about this" banner on tag results. */
export const pageForTechnique = (technique: string): GlslPage | undefined =>
  GLSL_PAGES.find((p) => p.technique === technique);
