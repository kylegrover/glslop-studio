// Minimal ISF type model — float/bool/long/color/point2D inputs + multipass/feedback
// (PASSES). Image INPUTS are still deferred (no upload pipeline yet).

export type ISFInputType =
  | 'float'
  | 'bool'
  | 'event'
  | 'long'
  | 'color'
  | 'point2D'
  | 'image';

export interface ISFInput {
  NAME: string;
  TYPE: ISFInputType;
  LABEL?: string;
  DEFAULT?: number | boolean | number[];
  MIN?: number;
  MAX?: number;
  VALUES?: number[]; // long
  LABELS?: string[]; // long
  SOURCE?: string; // image: the glslop shader id whose poster is sampled as this texture
}

// One render pass. No TARGET => draws to the screen (must be the final pass). A TARGET
// names an offscreen buffer other passes can sample by that name. PERSISTENT keeps the
// buffer across frames (feedback — a pass reads last frame's content). FLOAT = HDR/precision
// buffer (RGBA16F) for sims like reaction-diffusion. WIDTH/HEIGHT are accepted but ignored
// for now (all buffers render at RENDERSIZE).
export interface ISFPass {
  TARGET?: string;
  PERSISTENT?: boolean | number | string;
  FLOAT?: boolean | number | string;
  // glslop extension. RGBA8 and RGBA16F default to LINEAR; simulations can request NEAREST.
  FILTER?: 'LINEAR' | 'NEAREST';
  WIDTH?: string | number;
  HEIGHT?: string | number;
}

export interface ISFHeader {
  DESCRIPTION?: string;
  CREDIT?: string;
  CATEGORIES?: string[];
  ISFVSN?: string;
  INPUTS?: ISFInput[];
  PASSES?: ISFPass[];
}

export interface ParsedISF {
  header: ISFHeader;
  body: string;
  raw: string;
  inputs: ISFInput[];
  passes: ISFPass[];
}
