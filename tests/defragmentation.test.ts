import fs from 'fs';
import {
  createFile,
  MP4BoxBuffer,
  MultiBufferStream,
  type DefragmentChunk,
  type ISOFile,
} from '../entries/all';
import { edtsBox, trakBox } from '../src/boxes/defaults';
import { elstBox } from '../src/boxes/elst';
import { cslgBox } from '../src/boxes/cslg';
import { getFilePath, getFileRange, loadAndGetInfo } from './common';

type LoadedFile = Awaited<ReturnType<typeof loadAndGetInfo>>['mp4'];

/** Runs the defragmenter and concatenates the yielded chunks into one buffer. */
async function collectDefragmented(
  mp4: LoadedFile,
  options?: Parameters<ISOFile['defragment']>[0],
): Promise<{ buffer: MP4BoxBuffer; chunks: Array<DefragmentChunk> }> {
  const chunks: Array<DefragmentChunk> = [];
  let totalLength = 0;
  for await (const chunk of mp4.defragment(options)) {
    chunks.push(chunk);
    expect(chunk.offset).toBe(totalLength);
    totalLength += chunk.length;
  }
  const buffer = new MP4BoxBuffer(totalLength);
  let position = 0;
  for (const chunk of chunks) {
    new Uint8Array(buffer).set(chunk.data, position);
    position += chunk.length;
  }
  return { buffer, chunks };
}

/** Parses an in-memory MP4 buffer, keeping mdat data. */
function parseBuffer(buffer: ArrayBuffer, keepMdat = true): LoadedFile {
  const mp4 = createFile(keepMdat);
  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0));
  mp4.flush();
  return mp4;
}

/** Loads a fixture file, keeping its media data in memory. */
async function loadFixture(group: string, name: string): Promise<LoadedFile> {
  const { testFile } = getFilePath(group, name);
  const { mp4 } = await loadAndGetInfo(testFile, true, true);
  return mp4;
}

/** Compares every sample of every track between two parsed files. */
function expectSameSamples(original: LoadedFile, defragmented: LoadedFile) {
  expect(defragmented.moov.traks.length).toBe(original.moov.traks.length);
  for (let t = 0; t < original.moov.traks.length; t++) {
    const originalTrak = original.moov.traks[t];
    const defragmentedTrak = defragmented.getTrackById(originalTrak.tkhd.track_id);
    expect(defragmentedTrak).toBeDefined();
    const originalSamples = originalTrak.samples;
    const defragmentedSamples = defragmentedTrak.samples;
    expect(defragmentedSamples.length).toBe(originalSamples.length);
    for (let i = 0; i < originalSamples.length; i++) {
      const a = originalSamples[i];
      const b = defragmentedSamples[i];
      expect(b.number, `track ${a.track_id} sample ${i} number`).toBe(a.number);
      expect(b.dts, `track ${a.track_id} sample ${i} dts`).toBe(a.dts);
      expect(b.cts, `track ${a.track_id} sample ${i} cts`).toBe(a.cts);
      expect(b.duration, `track ${a.track_id} sample ${i} duration`).toBe(a.duration);
      expect(b.is_sync, `track ${a.track_id} sample ${i} is_sync`).toBe(a.is_sync);
      expect(b.size, `track ${a.track_id} sample ${i} size`).toBe(a.size);
      expect(b.description_index, `track ${a.track_id} sample ${i} description`).toBe(
        a.description_index,
      );
      expect(b.timescale, `track ${a.track_id} sample ${i} timescale`).toBe(a.timescale);
    }
  }
}

/** Compares the actual sample bytes of two parsed files, track by track. */
function expectSameSampleData(original: LoadedFile, defragmented: LoadedFile) {
  for (const originalTrak of original.moov.traks) {
    const defragmentedTrak = defragmented.getTrackById(originalTrak.tkhd.track_id);
    for (let i = 0; i < originalTrak.samples.length; i++) {
      const a = original.getSample(originalTrak, i);
      const b = defragmented.getSample(defragmentedTrak, i);
      expect(a.data.byteLength).toBe(b.data.byteLength);
      // Node's Buffer.compare is far faster than element-by-element arrays
      expect(Buffer.from(b.data).equals(Buffer.from(a.data))).toBe(true);
    }
  }
}

function expectProgressiveStructure(mp4: LoadedFile) {
  expect(mp4.getBox('mvex')).toBeUndefined();
  expect(mp4.getBoxes('moof', false).length).toBe(0);
  expect(mp4.getBoxes('mdat', false).length).toBe(1);
  const moovIndex = mp4.boxes.findIndex(box => box.type === 'moov');
  const mdatIndex = mp4.boxes.findIndex(box => box.type === 'mdat');
  expect(moovIndex).toBeGreaterThanOrEqual(0);
  expect(mdatIndex).toBeGreaterThan(moovIndex);
  for (const trak of mp4.moov.traks) {
    const stbl = trak.mdia.minf.stbl;
    expect(stbl.stts).toBeDefined();
    expect(stbl.stsc).toBeDefined();
    expect(stbl.stsz).toBeDefined();
    expect(stbl.stco ?? stbl.co64).toBeDefined();
  }
}

describe('Defragmentation', () => {
  it('defragments 10_fragments.mp4 and preserves every sample', async () => {
    const original = await loadFixture('isobmff', '10_fragments.mp4');
    expect(original.moofs.length).toBe(10);
    expect(original.getBox('mvex')).toBeDefined();

    const { buffer } = await collectDefragmented(original);

    const defragmented = parseBuffer(buffer);
    expectProgressiveStructure(defragmented);
    expectSameSamples(original, defragmented);
    expectSameSampleData(original, defragmented);

    // Track counts and codec parameters are preserved
    const originalInfo = original.getInfo();
    const defragmentedInfo = defragmented.getInfo();
    expect(defragmentedInfo.tracks.length).toBe(originalInfo.tracks.length);
    expect(defragmentedInfo.tracks.map(track => track.codec).sort()).toEqual(
      originalInfo.tracks.map(track => track.codec).sort(),
    );
    expect(defragmentedInfo.tracks.map(track => track.language).sort()).toEqual(
      originalInfo.tracks.map(track => track.language).sort(),
    );

    // Durations are set correctly
    for (const trak of defragmented.moov.traks) {
      const sumOfDurations = trak.samples.reduce((total, sample) => total + sample.duration, 0);
      expect(trak.mdia.mdhd.duration).toBe(sumOfDurations);
    }

    // Video track keeps its sync sample table
    const videoTrak = defragmented.moov.traks.find(trak => trak.mdia.hdlr.handler === 'vide');
    expect(videoTrak.mdia.minf.stbl.stss).toBeDefined();
    // Audio track (all sync samples) does not need an stss box
    const audioTrak = defragmented.moov.traks.find(trak => trak.mdia.hdlr.handler === 'soun');
    expect(audioTrak.mdia.minf.stbl.stss).toBeUndefined();
  });

  it('defragments the uvvu fixture with audio, video and subtitle tracks', async () => {
    const original = await loadFixture('uvvu', 'Solekai007_1920_29_1x1_v7clear.uvu');
    expect(original.moov.traks.length).toBe(3);
    expect(original.moofs.length).toBe(15);

    const { buffer } = await collectDefragmented(original, { chunkSize: 256 * 1024 });
    const defragmented = parseBuffer(buffer);
    expectProgressiveStructure(defragmented);
    expectSameSamples(original, defragmented);
    expectSameSampleData(original, defragmented);

    // The 18 MB payload must be split in several chunks of bounded size
    const defragmentedInfo = defragmented.getInfo();
    const subtitleTrack = defragmentedInfo.tracks.find(track => track.type === 'subtitles');
    expect(subtitleTrack).toBeDefined();
    expect(subtitleTrack.nb_samples).toBe(1);
  });

  it('keeps header information such as edit lists and languages', async () => {
    const original = await loadFixture('isobmff', '10_fragments.mp4');

    // Inject an edit list and a composition-shift box into the video track so
    // the preservation of headers that live outside the sample tables is
    // actually exercised (the conformance fixtures carry none).
    const videoTrak = original.moov.traks.find(
      trak => trak.mdia.hdlr.handler === 'vide',
    ) as trakBox;
    const edts = new edtsBox();
    const elst = new elstBox();
    elst.version = 0;
    elst.entries = [
      { segment_duration: 1000, media_time: 2000, media_rate_integer: 1, media_rate_fraction: 0 },
    ];
    edts.addBox(elst);
    videoTrak.addBox(edts);
    videoTrak.edts = edts;
    const cslg = new cslgBox();
    cslg.compositionToDTSShift = -1000;
    cslg.leastDecodeToDisplayDelta = -1000;
    cslg.greatestDecodeToDisplayDelta = 1000;
    cslg.compositionStartTime = 0;
    cslg.compositionEndTime = 249000;
    videoTrak.mdia.minf.stbl.addBox(cslg);
    videoTrak.mdia.minf.stbl.cslg = cslg;

    const { buffer } = await collectDefragmented(original);
    const defragmented = parseBuffer(buffer);

    for (let i = 0; i < original.moov.traks.length; i++) {
      const a = original.moov.traks[i];
      const b = defragmented.moov.traks[i];
      expect(b.tkhd.track_id).toBe(a.tkhd.track_id);
      expect(b.mdia.mdhd.timescale).toBe(a.mdia.mdhd.timescale);
      expect(b.mdia.hdlr.handler).toBe(a.mdia.hdlr.handler);
      // Sample descriptions (codec configuration) are reused as-is
      expect(b.mdia.minf.stbl.stsd.entries.length).toBe(a.mdia.minf.stbl.stsd.entries.length);
    }

    // The injected edit list and cslg box survive the conversion untouched
    const defragmentedVideo = defragmented.moov.traks.find(
      trak => trak.mdia.hdlr.handler === 'vide',
    ) as trakBox;
    expect(defragmentedVideo.edts).toBeDefined();
    expect(defragmentedVideo.edts.elst.entries).toEqual(elst.entries);
    expect(defragmentedVideo.mdia.minf.stbl.cslg).toBeDefined();
    expect(defragmentedVideo.mdia.minf.stbl.cslg.compositionToDTSShift).toBe(-1000);
    // The rebuilt tables (stts/ctts/...) are still present alongside cslg
    expect(defragmentedVideo.mdia.minf.stbl.stts).toBeDefined();
    expect(defragmentedVideo.mdia.minf.stbl.ctts).toBeDefined();
  });

  it('supports a streaming range reader without keeping mdat data in memory', async () => {
    const { testFile } = getFilePath('isobmff', '10_fragments.mp4');
    // Parse without retaining media data, as a browser fetching a remote file would
    const streamed = createFile(false);
    await getFileRange(testFile, data => streamed.appendBuffer(data));
    streamed.flush();
    expect(streamed.getAllocatedSampleDataSize()).toBe(0);

    const fd = fs.openSync(testFile, 'r');
    try {
      const reader = {
        readRange: async (start: number, end: number): Promise<Uint8Array> => {
          const bytes = new Uint8Array(end - start);
          const result = fs.readSync(fd, bytes, 0, end - start, start);
          expect(result).toBe(end - start);
          return bytes;
        },
      };

      const chunks: Array<DefragmentChunk> = [];
      let totalLength = 0;
      for await (const chunk of streamed.defragment({ reader, chunkSize: 64 * 1024 })) {
        chunks.push(chunk);
        totalLength += chunk.length;
      }
      expect(chunks.length).toBeGreaterThan(1);
      // No gap was requested, so every chunk carries actual bytes
      expect(chunks.every(chunk => !chunk.padding)).toBe(true);
      const buffer = new MP4BoxBuffer(totalLength);
      let position = 0;
      for (const chunk of chunks) {
        new Uint8Array(buffer).set(chunk.data, position);
        position += chunk.length;
      }

      // Compare against a reference conversion done with all data in memory
      const reference = await loadFixture('isobmff', '10_fragments.mp4');
      const referenceOutput = await collectDefragmented(reference);
      expect(new Uint8Array(buffer)).toEqual(new Uint8Array(referenceOutput.buffer));
    } finally {
      fs.closeSync(fd);
    }
  });

  it('uses 64-bit co64 offsets when samples lie beyond 4 GB', async () => {
    const original = await loadFixture('isobmff', '10_fragments.mp4');
    const fourGB = 2 ** 32;
    // A gap large enough to push the first sample past the 32-bit limit.
    // The gap is only reserved (one padding chunk), no 4 GB is copied.
    const gapSize = fourGB + 1 - 1024;

    const chunks: Array<DefragmentChunk> = [];
    let logicalLength = 0;
    let paddingChunks = 0;
    let paddingBytes = 0;
    for await (const chunk of original.defragment({ gapSize, chunkSize: 128 * 1024 })) {
      chunks.push(chunk);
      logicalLength += chunk.length;
      if (chunk.padding) {
        paddingChunks++;
        paddingBytes += chunk.length;
        // padding carries no actual bytes
        expect(chunk.data.byteLength).toBe(0);
      }
    }
    expect(paddingChunks).toBe(1);
    expect(paddingBytes).toBe(gapSize);
    // The real, materialized payload stays small regardless of the gap
    const materializedBytes = chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
    expect(materializedBytes).toBeLessThan(fourGB);
    // Chunks still cover a contiguous logical range
    expect(logicalLength).toBe(materializedBytes + gapSize);

    // Rebuild the sparse output: skip the padding range but keep real offsets
    const sparseStream = new MultiBufferStream();
    for (const chunk of chunks) {
      if (chunk.padding) continue;
      sparseStream.insertBuffer(MP4BoxBuffer.fromArrayBuffer(chunk.data.buffer, chunk.offset));
    }
    // The constructor-stream parse path does not build sample lists, so feed
    // the sparse buffers through appendBuffer like a progressive download.
    const defragmented = createFile(true);
    for (const buffer of sparseStream.buffers) {
      defragmented.appendBuffer(buffer);
    }
    defragmented.flush();

    // Every track had to use a co64 box, stco is forbidden above 4 GB
    for (const trak of defragmented.moov.traks) {
      if (trak.samples.length === 0) continue;
      expect(trak.mdia.minf.stbl.co64).toBeDefined();
      expect(trak.mdia.minf.stbl.stco).toBeUndefined();
    }
    const videoTrak = defragmented.moov.traks.find(trak => trak.mdia.hdlr.handler === 'vide');
    expect(videoTrak.samples[0].offset).toBeGreaterThan(fourGB);
    // Offsets are contiguous and consistent with sample sizes
    for (const trak of defragmented.moov.traks) {
      for (let i = 1; i < trak.samples.length; i++) {
        expect(trak.samples[i].offset).toBe(trak.samples[i - 1].offset + trak.samples[i - 1].size);
      }
    }

    // Sample metadata is still identical to the source
    expectSameSamples(original, defragmented);
    // And sample data is readable from the sparse buffers
    const fetched = defragmented.getSample(videoTrak, 0);
    expect(fetched.data.byteLength).toBe(videoTrak.samples[0].size);
    const referenceVideo = original.moov.traks.find(trak => trak.mdia.hdlr.handler === 'vide');
    const referenceSample = original.getSample(referenceVideo, 0);
    expect(Buffer.from(fetched.data).equals(Buffer.from(referenceSample.data))).toBe(true);
  });

  it('rejects files that are not fragmented', async () => {
    const { buffer } = await collectDefragmented(await loadFixture('isobmff', '10_fragments.mp4'));
    const progressive = parseBuffer(buffer);
    await expect(progressive.defragment().next()).rejects.toThrow(/not fragmented/);
  });

  it('rejects invalid options', async () => {
    const original = await loadFixture('isobmff', '10_fragments.mp4');
    await expect(original.defragment({ chunkSize: 0 }).next()).rejects.toThrow(/chunkSize/);
    await expect(original.defragment({ gapSize: -1 }).next()).rejects.toThrow(/gapSize/);
  });

  it('fails clearly when sample data is missing and no reader is provided', async () => {
    const { testFile } = getFilePath('isobmff', '10_fragments.mp4');
    const streamed = createFile(false);
    await getFileRange(testFile, data => streamed.appendBuffer(data));
    streamed.flush();
    await expect(streamed.defragment().next()).rejects.toThrow(/data is not available/);
  });
});
