/*
 * Defragmentation of fragmented ISO Base Media files.
 *
 * Turns a file made of a 'moov' box containing an 'mvex' box and a series of
 * 'moof'/'mdat' boxes into a regular (progressive) file: a 'ftyp' box, the
 * other original top-level boxes, a single 'moov' box (without 'mvex') with
 * complete sample tables, and a single 'mdat' box.
 *
 * The output is produced as a sequence of chunks (async generator) so that
 * neither the whole input nor the whole output has to be held in memory.
 * License: BSD-3-Clause (see LICENSE file)
 */

import { Box } from '#/box';
import { co64Box } from '#/boxes/co64';
import { cttsBox } from '#/boxes/ctts';
import { moovBox, trakBox } from '#/boxes/defaults';
import { stcoBox } from '#/boxes/stco';
import { stscBox } from '#/boxes/stsc';
import { stssBox } from '#/boxes/stss';
import { stszBox } from '#/boxes/stsz';
import { sttsBox } from '#/boxes/stts';
import { DataStream } from '#/DataStream';
import type { ISOFile } from '#/isofile';
import { Log } from '#/log';
import { MAX_UINT32 } from '#/constants';
import type { Sample } from '@types';

/**
 * Reader used to fetch byte ranges of the fragmented file on demand, when the
 * media data is not kept in memory (see {@link DefragmentOptions.reader}).
 * Implementations typically wrap HTTP range requests (browser) or file reads.
 */
export interface DefragmentRangeReader {
  /**
   * Returns the bytes of the file in the range [start, end[.
   * The returned buffer must contain exactly `end - start` bytes.
   */
  readRange: (start: number, end: number) => Promise<ArrayBuffer | Uint8Array>;
}

export interface DefragmentOptions {
  /**
   * Maximum size in bytes of the chunks yielded by the generator.
   * Defaults to 1 MiB.
   */
  chunkSize?: number;
  /**
   * Optional range reader. When provided, the media data does not need to be
   * buffered by the ISOFile parser: sample bytes are fetched on demand and
   * memory usage stays bounded by chunkSize and the sample tables.
   * When absent, sample data is taken from the parsed ISOFile, which requires
   * `keepMdatData` to have been enabled when parsing.
   */
  reader?: DefragmentRangeReader;
  /**
   * Extra number of zero bytes reserved between the 'moov' box and the
   * single output 'mdat' box. No byte is copied for the gap: it is reported
   * as a single padding chunk (empty data, non-zero logical length) so the
   * cost stays constant even for multi-gigabyte gaps. Sample offsets in the
   * output become larger than this value. Mainly useful for exercising 64-bit
   * ('co64') offsets without creating multi-gigabyte fixtures.
   */
  gapSize?: number;
}

/**
 * A piece of the output file. Chunks are yielded in file order. Callers
 * reconstruct the file by placing each chunk at its `offset`.
 */
export interface DefragmentChunk {
  data: Uint8Array;
  /** Position of the first byte of this chunk in the output file. */
  offset: number;
  /**
   * Number of logical bytes occupied by this chunk in the output file.
   * Equal to `data.byteLength` for regular chunks; larger for a padding
   * chunk, whose gap has to be reserved (e.g. seeked over) by the caller.
   */
  length: number;
  /**
   * True when the chunk only reserves space (the `gapSize` option) instead
   * of carrying actual content: `data` is then empty and the gap bytes are
   * not produced, so callers writing to a real file must seek past them.
   */
  padding?: boolean;
}

/**
 * Accumulates arbitrary byte arrays into fixed-size output chunks.
 * Backing buffers are only as large as `chunkSize`, keeping the output
 * memory footprint bounded regardless of the file size.
 */
class ChunkSink {
  private buffer: Uint8Array<ArrayBuffer>;
  private length = 0;
  /** Total number of bytes pushed, including bytes not flushed yet. */
  private total = 0;

  constructor(
    private readonly chunkSize: number,
    private readonly emit: (chunk: DefragmentChunk) => void,
  ) {
    this.buffer = new Uint8Array(new ArrayBuffer(chunkSize));
  }

  get absolutePosition() {
    return this.total;
  }

  push(data: ArrayLike<number>) {
    let offsetInData = 0;
    let remaining = data.length;
    while (remaining > 0) {
      const copyLength = Math.min(remaining, this.chunkSize - this.length);
      this.buffer.set(
        Array.prototype.slice.call(data, offsetInData, offsetInData + copyLength),
        this.length,
      );
      this.length += copyLength;
      this.total += copyLength;
      offsetInData += copyLength;
      remaining -= copyLength;
      if (this.length === this.chunkSize) {
        this.flush();
      }
    }
  }

  /**
   * Reserves a logical gap without copying any byte: pending data is flushed
   * first and a single padding chunk (empty data) is emitted.
   */
  reserveGap(size: number) {
    this.flush();
    if (size === 0) return;
    this.emit({
      data: new Uint8Array(new ArrayBuffer(0)),
      offset: this.total,
      length: size,
      padding: true,
    });
    this.total += size;
  }

  flush() {
    if (this.length === 0) return;
    const data = this.buffer.slice(0, this.length);
    this.emit({
      data,
      offset: this.total - this.length,
      length: this.length,
    });
    this.length = 0;
  }
}

/** Run-length encodes the values returned by `getValue` for each sample. */
function runLengthEncode(
  samples: Array<Sample>,
  getValue: (sample: Sample) => number,
): { counts: Array<number>; values: Array<number> } {
  const counts: Array<number> = [];
  const values: Array<number> = [];
  for (const sample of samples) {
    const value = getValue(sample);
    const lastIndex = values.length - 1;
    if (lastIndex >= 0 && values[lastIndex] === value) {
      counts[lastIndex]++;
    } else {
      counts.push(1);
      values.push(value);
    }
  }
  return { counts, values };
}

/**
 * Rebuilds the sample tables ('stts', optional 'ctts', 'stsc', 'stsz',
 * 'stco'/'co64' and optional 'stss') of a single track from its flat sample
 * list. All other boxes of the sample table (sample descriptions, codec
 * configuration, sample groups, ...) are preserved as is.
 *
 * @param trak the track whose sample table has to be rebuilt
 * @param mdatPayloadStart position of the first byte of this track's first
 *        sample in the output 'mdat' payload. Tracks are laid out back to
 *        back, so each track starts after the previous one's samples.
 * @returns true if at least one sample offset does not fit in 32 bits,
 *          meaning a 'co64' box is required
 */
function rebuildSampleTables(trak: trakBox, mdatPayloadStart: number): boolean {
  const stbl = trak.mdia.minf.stbl;
  const samples = trak.samples;

  /* Time to sample: run-length encoded sample durations */
  const stts = new sttsBox();
  const durations = runLengthEncode(samples, sample => sample.duration);
  stts.sample_counts = durations.counts;
  stts.sample_deltas = durations.values;

  /* Composition time offsets: only kept if at least one sample has cts != dts */
  let ctts: cttsBox | undefined;
  if (samples.some(sample => sample.cts !== sample.dts)) {
    ctts = new cttsBox();
    const offsets = runLengthEncode(samples, sample => sample.cts - sample.dts);
    ctts.sample_counts = offsets.counts;
    ctts.sample_offsets = offsets.values;
  }

  /*
   * One sample per chunk. Chunks are grouped into runs that share the same
   * sample description index: every run records the first chunk (1-based) it
   * applies to, 1 sample per chunk and the description index (1-based).
   */
  const stsc = new stscBox();
  stsc.first_chunk = [];
  stsc.samples_per_chunk = [];
  stsc.sample_description_index = [];
  for (let i = 0; i < samples.length; i++) {
    const descriptionIndex = samples[i].description_index + 1;
    const previousIndex = stsc.sample_description_index.length - 1;
    if (previousIndex < 0 || stsc.sample_description_index[previousIndex] !== descriptionIndex) {
      stsc.first_chunk.push(i + 1); // chunk numbers are 1-based
      stsc.samples_per_chunk.push(1);
      stsc.sample_description_index.push(descriptionIndex);
    }
  }

  /* Sample sizes */
  const stsz = new stszBox();
  stsz.sample_size = 0;
  stsz.sample_count = samples.length;
  stsz.sample_sizes = samples.map(sample => sample.size);

  /* Sample offsets: one chunk per sample, offsets are file offsets in the output */
  const chunkOffsets: Array<number> = [];
  let offset = mdatPayloadStart;
  let hasLargeOffset = mdatPayloadStart > MAX_UINT32;
  for (const sample of samples) {
    chunkOffsets.push(offset);
    if (offset > MAX_UINT32) hasLargeOffset = true;
    offset += sample.size;
  }
  const offsetBox = hasLargeOffset ? new co64Box() : new stcoBox();
  offsetBox.chunk_offsets = chunkOffsets;

  /* Sync samples: only write an 'stss' box when some samples are not sync */
  let stss: stssBox | undefined;
  if (samples.some(sample => !sample.is_sync)) {
    stss = new stssBox();
    stss.sample_numbers = [];
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].is_sync) {
        stss.sample_numbers.push(i + 1); // sample numbers are 1-based
      }
    }
  }

  /*
   * Rebuild the sample table in place: only the tables derivable from the
   * flat sample list are replaced, every other box (sample descriptions,
   * codec configuration, sample groups, ...) is preserved. Mutating the
   * existing stbl keeps the parent 'minf' box tree consistent, which is
   * required since boxes are serialized through their parent's box list.
   */
  const reservedTypes = new Set([
    'stts',
    'ctts',
    'stsc',
    'stsz',
    'stz2',
    'stco',
    'co64',
    'stss',
    'sdtp',
  ]);
  const rebuiltTables: Array<Box> = [stts];
  if (ctts) rebuiltTables.push(ctts);
  rebuiltTables.push(stsc, stsz, offsetBox);
  if (stss) rebuiltTables.push(stss);

  stbl.boxes = (stbl.boxes ?? []).filter(box => !box || !reservedTypes.has(box.type));
  /* drop the property shortcuts of the removed tables */
  stbl.stts = undefined;
  stbl.ctts = undefined;
  stbl.stsc = undefined;
  stbl.stsz = undefined;
  stbl.stz2 = undefined;
  stbl.stco = undefined;
  stbl.co64 = undefined;
  stbl.stss = undefined;
  stbl.sdtp = undefined;
  for (const table of rebuiltTables) {
    stbl.addBox(table);
  }
  /* the parsed size is stale now, it is recomputed when the box is written */
  stbl.size = 0;

  return hasLargeOffset;
}

/** Updates the track and movie header durations to match the actual samples. */
function updateDurations(moov: moovBox) {
  const movieTimescale = moov.mvhd.timescale;
  let movieDuration = 0;
  for (const trak of moov.traks) {
    const mediaDuration = trak.samples.reduce((total, sample) => total + sample.duration, 0);
    trak.samples_duration = mediaDuration;
    trak.samples_size = trak.samples.reduce((total, sample) => total + sample.size, 0);
    trak.mdia.mdhd.duration = mediaDuration;
    const trackDuration = Math.round((mediaDuration * movieTimescale) / trak.mdia.mdhd.timescale);
    trak.tkhd.duration = trackDuration;
    if (trackDuration > movieDuration) movieDuration = trackDuration;
  }
  moov.mvhd.duration = movieDuration;
}

/** Removes the 'mvex' box (and any other fragment-only boxes) from the moov. */
function removeMovieExtensions(moov: moovBox) {
  moov.boxes = (moov.boxes ?? []).filter(box => box.type !== 'mvex');
  moov.mvex = undefined;
  moov.mvexs = [];
}

/**
 * Copies the bytes of a sample into the sink, either from the already parsed
 * and buffered file data or from a user-provided range reader.
 */
async function emitSampleData(
  isofile: ISOFile,
  sample: Sample,
  reader: DefragmentRangeReader | undefined,
  sink: ChunkSink,
) {
  if (reader) {
    const data = await reader.readRange(sample.offset, sample.offset + sample.size);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength !== sample.size) {
      throw new Error(
        `Defragment: reader returned ${bytes.byteLength} bytes for sample at offset ${sample.offset}, expected ${sample.size}`,
      );
    }
    sink.push(bytes);
    return;
  }
  const trak = isofile.getTrackById(sample.track_id);
  const fetched = isofile.getSample(trak, sample.number);
  if (!fetched || fetched.alreadyRead !== fetched.size || !fetched.data) {
    throw new Error(
      `Defragment: sample #${sample.number} of track #${sample.track_id} data is not available; ` +
        'parse the file with keepMdatData enabled or provide a range reader',
    );
  }
  sink.push(fetched.data);
}

/** Writes the header of an mdat box, using 64-bit sizes when needed. */
function writeMdatHeader(sink: ChunkSink, payloadSize: number) {
  const stream = new DataStream();
  if (payloadSize <= MAX_UINT32) {
    stream.writeUint32(payloadSize + 8);
    stream.writeString('mdat', undefined, 4);
  } else {
    stream.writeUint32(1);
    stream.writeString('mdat', undefined, 4);
    stream.writeUint64(payloadSize + 16);
  }
  sink.push(new Uint8Array(stream.buffer));
}

function* drainQueue(queue: Array<DefragmentChunk>): Generator<DefragmentChunk> {
  while (queue.length > 0) {
    const chunk = queue.shift();
    if (chunk) yield chunk;
  }
}

/** Serializes a moov in a throwaway stream to measure its size. */
function measureMoovSize(moov: moovBox): number {
  const stream = new DataStream();
  moov.write(stream);
  return stream.byteLength;
}

/**
 * Defragments a fragmented ISO Base Media file.
 *
 * The ISOFile must have been fully parsed (all 'moof' boxes received and
 * `flush()` called). The generator yields the output file as fixed-size
 * chunks; see {@link DefragmentChunk} for the chunk contract.
 */
export async function* defragment(
  isofile: ISOFile,
  options: DefragmentOptions = {},
): AsyncGenerator<DefragmentChunk> {
  if (!isofile.moov) {
    throw new Error('Defragment: no moov box found, cannot defragment');
  }
  if (!isofile.getBox('mvex')) {
    throw new Error('Defragment: file is not fragmented (no mvex box)');
  }
  const chunkSize = options.chunkSize ?? 1024 * 1024;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('Defragment: chunkSize must be a positive integer');
  }
  const gapSize = options.gapSize ?? 0;
  if (!Number.isSafeInteger(gapSize) || gapSize < 0) {
    throw new Error('Defragment: gapSize must be a non-negative safe integer');
  }

  /* Queue of chunks waiting to be yielded to the caller */
  const queue: Array<DefragmentChunk> = [];
  const sink = new ChunkSink(chunkSize, chunk => queue.push(chunk));

  const moov = isofile.moov;
  const totalSampleSize = moov.traks.reduce(
    (total, trak) => total + trak.samples.reduce((size, sample) => size + sample.size, 0),
    0,
  );
  const mdatHeaderSize = totalSampleSize > MAX_UINT32 ? 16 : 8;

  /* 1. Write the ftyp box and the other non-fragment top-level boxes as is */
  const excludedTopLevelTypes = new Set(['moov', 'mdat', 'moof', 'styp', 'sidx', 'mfra', 'emsg']);
  for (const box of isofile.boxes) {
    if (box.type === 'ftyp' || !excludedTopLevelTypes.has(box.type)) {
      const stream = new DataStream();
      box.write(stream);
      sink.push(new Uint8Array(stream.buffer));
    }
  }
  const boxesEndPosition = sink.absolutePosition;

  /* 2. Remove mvex and fix durations; sample tables are rebuilt below */
  removeMovieExtensions(moov);
  updateDurations(moov);

  /*
   * 3. Rebuild the moov sample tables. The choice between 'stco' (32-bit
   *    offsets) and 'co64' (64-bit offsets) depends on the moov size, which
   *    itself depends on that choice: resolve by iteration. Starting from an
   *    stco-based estimate, at most one stco -> co64 transition can happen,
   *    so two passes always suffice.
   */
  let moovSize = 0;
  for (let pass = 0; pass < 3; pass++) {
    let nextSampleOffset = boxesEndPosition + moovSize + gapSize + mdatHeaderSize;
    for (const trak of moov.traks) {
      rebuildSampleTables(trak, nextSampleOffset);
      nextSampleOffset += trak.samples.reduce((size, sample) => size + sample.size, 0);
    }
    const measuredMoovSize = measureMoovSize(moov);
    if (measuredMoovSize === moovSize) {
      break;
    }
    moovSize = measuredMoovSize;
  }

  /* 4. Serialize the final moov (its tables hold the converged offsets) */
  const moovStream = new DataStream();
  moov.write(moovStream);
  sink.push(new Uint8Array(moovStream.buffer));
  yield* drainQueue(queue);

  /* 5. Optional gap: reserved as a single padding chunk, no byte is copied */
  if (gapSize > 0) {
    sink.reserveGap(gapSize);
    yield* drainQueue(queue);
  }

  /* 6. Single mdat box containing every sample of every track */
  writeMdatHeader(sink, totalSampleSize);
  yield* drainQueue(queue);
  for (const trak of moov.traks) {
    for (const sample of trak.samples) {
      await emitSampleData(isofile, sample, options.reader, sink);
      if (queue.length > 0) yield* drainQueue(queue);
    }
  }
  sink.flush();
  yield* drainQueue(queue);

  Log.debug('Defragment', `Defragmentation complete, output size: ${sink.absolutePosition}`);
}
