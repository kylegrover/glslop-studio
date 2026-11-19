// Canonical technique vocabulary for the corpus feature index. Technique names are a JOIN KEY —
// they group shaders across the whole corpus — so the seed list, the alias map, and the enrich
// prompt must agree. The prompt in enrich.ts is GENERATED from this list; edit here, never there.
//
// Growing the vocabulary: coined (off-list) names are stored but tagged, and
// scripts/report-techniques.ts lists them by frequency — promote a coined name by moving it into
// SEED_VOCAB (and adding aliases for the variants the models actually emitted).

// Alphabetized. Keep entries lowercase_snake_case, singular, the shortest term a practitioner
// would search for.
export const SEED_VOCAB = [
  'bokeh_blur',
  'chromatic_aberration',
  'digital_rain',
  'dither',
  'domain_repeat',
  'domain_warp',
  'edge_detect',
  'fbm',
  'feedback',
  'flow_field',
  'glow_bloom',
  'hash_noise',
  'kaleidoscope',
  'palette_cosine',
  'parallax_layers',
  'particles',
  'plasma_sine_field',
  'polar',
  'posterize',
  'procedural_glyphs',
  'raster_text',
  'ray_tracing',
  'raymarch',
  'reaction_diffusion',
  'ridged_noise',
  'rotation2d',
  'scanlines',
  'sdf',
  'symmetry_fold',
  'thin_film',
  'tonemap',
  'truchet',
  'tunnel',
  'value_noise',
  'vignette',
  'volumetric',
  'voronoi',
] as const;

const SEED = new Set<string>(SEED_VOCAB);

// Synonyms/variants → canonical. Applied AFTER snake_casing, BEFORE anything reaches the DB, so
// model drift folds back into canon instead of fragmenting the join key. Grow this from what
// scripts/report-techniques.ts shows models actually emitting.
export const ALIASES: Record<string, string> = {
  bloom: 'glow_bloom',
  bokeh: 'bokeh_blur',
  cell_noise: 'voronoi',
  cellular_noise: 'voronoi',
  cosine_palette: 'palette_cosine',
  domain_repetition: 'domain_repeat',
  domain_warping: 'domain_warp',
  edge_detection: 'edge_detect',
  film_interference: 'thin_film',
  fractal_brownian_motion: 'fbm',
  fractal_noise: 'fbm',
  glow: 'glow_bloom',
  gradient_noise: 'value_noise',
  grid: 'domain_repeat',
  grid_cells: 'domain_repeat',
  grid_repeat: 'domain_repeat',
  iridescence: 'thin_film',
  iridescent: 'thin_film',
  matrix_rain: 'digital_rain',
  mirror_fold: 'symmetry_fold',
  nacre: 'thin_film',
  oil_slick: 'thin_film',
  perlin_noise: 'value_noise',
  polar_coordinates: 'polar',
  posterization: 'posterize',
  ray_march: 'raymarch',
  ray_marching: 'raymarch',
  raymarcher: 'raymarch',
  raymarching: 'raymarch',
  raytracing: 'ray_tracing',
  rotation: 'rotation2d',
  rotation_2d: 'rotation2d',
  scanline: 'scanlines',
  sdf_shapes: 'sdf',
  signed_distance_field: 'sdf',
  signed_distance_fields: 'sdf',
  soap_bubble: 'thin_film',
  soap_film: 'thin_film',
  thin_film_interference: 'thin_film',
  tiling: 'domain_repeat',
  tone_mapping: 'tonemap',
  tonemapping: 'tonemap',
  truchet_tiles: 'truchet',
  truchet_tiling: 'truchet',
  volumetrics: 'volumetric',
  voronoi_noise: 'voronoi',
};

/**
 * Fold a raw model-emitted technique name into canon. Lowercases/snake_cases, applies the alias
 * map, and reports whether the result is on the seed list (`canonical`) or a coined name that the
 * corpus should track for possible promotion. Returns null for empty input.
 */
export function normalizeTechniqueName(raw: string): { name: string; canonical: boolean } | null {
  let name = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!name) return null;
  name = ALIASES[name] || name;
  return { name, canonical: SEED.has(name) };
}
