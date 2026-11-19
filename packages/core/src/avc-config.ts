// Repair for Firefox's malformed AVCDecoderConfigurationRecord (ISO 14496-15 §5.3.3.1).
//
// Firefox's WebCodecs H.264 encoder hands back a `decoderConfig.description` that breaks the spec in
// two ways at once:
//   1. The mandatory reserved bits are zeroed — byte 4 is `0x03` where it must be `0xFF` (six 1-bits
//      + lengthSizeMinusOne) and byte 5 is `0x01` where it must be `0xE1` (three 1-bits + numSPS).
//   2. Every parameter set repeats its own NAL header byte: `67 67 64 00 28 …` for what should be
//      `67 64 00 28 …`, and `68 68 ce …` for `68 ce …`, with the length fields counting the extra byte.
//
// Mediabunny muxes the description into the avcC box verbatim (by design — for AVC the description
// *is* the record), so the bad bytes reach the file. ffmpeg then reports "too many reference frames"
// and "sps_id out of range" while parsing the parameter sets, and Apple's decoder — which is strict
// about those reserved bits — refuses the file, so exports don't play on iPhone. Chrome is unaffected.
//
// Detection is exact rather than heuristic: a well-formed SPS repeats the record's own
// profile/compat/level at its bytes 1..3, so a duplicated header byte shifts a known-value triple by
// exactly one. We only rewrite when that fingerprint matches.

/**
 * Returns a spec-conformant copy of an AVCDecoderConfigurationRecord, or the input **by reference**
 * when it is already well-formed (callers can identity-compare to detect a no-op).
 */
export function repairAvcDecoderConfig(input: Uint8Array): Uint8Array {
  // configurationVersion must be 1; anything else isn't a record we understand, so leave it be.
  if (input.length < 7 || input[0] !== 1) return input;

  const profile = input[1];
  const compat = input[2];
  const level = input[3];
  const lengthSizeMinusOne = input[4] & 0x03;

  let off = 5;
  const numSps = input[off++] & 0x1f;
  const sps: Uint8Array[] = [];
  for (let i = 0; i < numSps; i++) {
    if (off + 2 > input.length) return input; // truncated — not ours to fix
    const len = (input[off] << 8) | input[off + 1];
    off += 2;
    if (off + len > input.length) return input;
    sps.push(input.subarray(off, off + len));
    off += len;
  }
  if (off >= input.length) return input;
  const numPps = input[off++];
  const pps: Uint8Array[] = [];
  for (let i = 0; i < numPps; i++) {
    if (off + 2 > input.length) return input;
    const len = (input[off] << 8) | input[off + 1];
    off += 2;
    if (off + len > input.length) return input;
    pps.push(input.subarray(off, off + len));
    off += len;
  }
  // High-profile records carry trailing chroma_format/bit_depth extensions. Preserve them verbatim.
  const tail = input.subarray(off);

  const spsIsDuplicated = (s: Uint8Array) =>
    s.length > 4 && s[0] === s[1] && s[2] === profile && s[3] === compat && s[4] === level;

  const duplicated = sps.some(spsIsDuplicated);
  const reservedBitsSet = (input[4] & 0xfc) === 0xfc && (input[5] & 0xe0) === 0xe0;
  if (!duplicated && reservedBitsSet) return input;

  // PPS has no self-describing triple to check, so only strip it when the SPS proved the encoder is
  // emitting the duplicate — and only when the byte really is a repeated PPS NAL header.
  const fixedSps = sps.map((s) => (spsIsDuplicated(s) ? s.subarray(1) : s));
  const fixedPps = pps.map((p) =>
    duplicated && p.length > 1 && p[0] === p[1] && (p[0] & 0x1f) === 8 ? p.subarray(1) : p,
  );

  const out: number[] = [
    1,
    profile,
    compat,
    level,
    0xfc | lengthSizeMinusOne,
    0xe0 | (fixedSps.length & 0x1f),
  ];
  for (const s of fixedSps) out.push(s.length >> 8, s.length & 0xff, ...s);
  out.push(fixedPps.length);
  for (const p of fixedPps) out.push(p.length >> 8, p.length & 0xff, ...p);
  out.push(...tail);
  return new Uint8Array(out);
}

/**
 * Mediabunny passes this metadata object straight to the muxer once the hook returns, so repairing
 * `description` in place here is what actually lands in the avcC box.
 */
export function repairAvcMetadataInPlace(meta: { decoderConfig?: { description?: unknown } } | undefined): void {
  const desc = meta?.decoderConfig?.description;
  if (!desc) return;
  const bytes =
    desc instanceof ArrayBuffer
      ? new Uint8Array(desc)
      : ArrayBuffer.isView(desc)
        ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
        : null;
  if (!bytes) return;
  const fixed = repairAvcDecoderConfig(bytes);
  if (fixed !== bytes) meta!.decoderConfig!.description = fixed;
}
