// A recording on disk: `<dir>/meta.json` plus one append-only `<room>.xrr`
// per room. An .xrr file is a sequence of records, each a compressed chunk
// (see format.ts) behind a fixed 28-byte header, so a reader can index a
// file by seeking over headers and a writer that dies mid-run loses at most
// the chunk it had not flushed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { ChunkDecoder, historyTicks } from './format.js';
export const CODECS = { none: 0, zstd: 1, brotli: 2 };
const codecNames = Object.keys(CODECS);
const MAGIC = [0x58, 0x52, 0x52, 0x43]; // XRRC
const RECORD_VERSION = 1;
export const RECORD_HEADER = 28;
export function compress(raw, codec, level) {
    switch (codec) {
        case 'none': return raw;
        case 'zstd': return zlib.zstdCompressSync(raw, {
            params: { [zlib.constants.ZSTD_c_compressionLevel]: level ?? 19 },
        });
        case 'brotli': return zlib.brotliCompressSync(raw, {
            params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: level ?? 11,
                [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
        });
        default: throw new Error(`Unknown codec ${codec}`);
    }
}
export function decompress(data, codec) {
    switch (codecNames[codec]) {
        case 'none': return data;
        case 'zstd': return zlib.zstdDecompressSync(data);
        case 'brotli': return zlib.brotliDecompressSync(data);
        default: throw new Error(`Unknown codec id ${codec}`);
    }
}
export function encodeRecord(raw, codec, firstTick, lastTick, frames, level) {
    const payload = compress(raw, codec, level);
    const record = new Uint8Array(RECORD_HEADER + payload.length);
    const view = new DataView(record.buffer);
    record.set(MAGIC, 0);
    record[4] = RECORD_VERSION;
    record[5] = CODECS[codec];
    view.setUint16(6, 0, true);
    view.setUint32(8, firstTick, true);
    view.setUint32(12, lastTick, true);
    view.setUint32(16, frames, true);
    view.setUint32(20, raw.length, true);
    view.setUint32(24, payload.length, true);
    record.set(payload, RECORD_HEADER);
    return record;
}
function parseHeader(header, offset) {
    if (MAGIC.some((byte, ii) => header[ii] !== byte)) {
        throw new Error(`Bad record magic at ${offset}`);
    }
    if (header[4] !== RECORD_VERSION) {
        throw new Error(`Unsupported record version ${header[4]}`);
    }
    const view = new DataView(header.buffer, header.byteOffset);
    return {
        offset,
        codec: header[5],
        firstTick: view.getUint32(8, true),
        lastTick: view.getUint32(12, true),
        frames: view.getUint32(16, true),
        rawLength: view.getUint32(20, true),
        length: view.getUint32(24, true),
    };
}
/** Lists the records in an .xrr file by seeking over their headers. */
export function indexRecords(file) {
    const records = [];
    let fd;
    try {
        fd = fs.openSync(file, 'r');
    }
    catch {
        return records;
    }
    try {
        const size = fs.fstatSync(fd).size;
        const header = new Uint8Array(RECORD_HEADER);
        let offset = 0;
        while (offset + RECORD_HEADER <= size) {
            fs.readSync(fd, header, 0, RECORD_HEADER, offset);
            const record = parseHeader(header, offset);
            if (offset + RECORD_HEADER + record.length > size) {
                // Truncated tail: the writer died mid-record
                break;
            }
            records.push(record);
            offset += RECORD_HEADER + record.length;
        }
    }
    finally {
        fs.closeSync(fd);
    }
    return records;
}
/** Reads and decompresses one record's chunk. */
export function readRecord(file, record) {
    const fd = fs.openSync(file, 'r');
    try {
        const data = new Uint8Array(record.length);
        fs.readSync(fd, data, 0, record.length, record.offset + RECORD_HEADER);
        return decompress(data, record.codec);
    }
    finally {
        fs.closeSync(fd);
    }
}
export class Recording {
    dir;
    meta;
    indexes = new Map();
    frames = new Map();
    constructor(dir, meta) {
        this.dir = dir;
        this.meta = meta;
    }
    static metaFile(dir) {
        return path.join(dir, 'meta.json');
    }
    static open(dir) {
        try {
            const meta = JSON.parse(fs.readFileSync(Recording.metaFile(dir), 'utf8'));
            if (meta.version !== 1) {
                return undefined;
            }
            return new Recording(dir, meta);
        }
        catch {
            return undefined;
        }
    }
    /** Every recording under `root`, newest first. */
    static list(root) {
        let names;
        try {
            names = fs.readdirSync(root);
        }
        catch {
            return [];
        }
        const recordings = [];
        for (const name of names) {
            const recording = Recording.open(path.join(root, name));
            if (recording) {
                recordings.push(recording);
            }
        }
        return recordings.sort((left, right) => right.meta.created - left.meta.created);
    }
    saveMeta() {
        fs.mkdirSync(this.dir, { recursive: true });
        this.meta.updated = Date.now();
        const file = Recording.metaFile(this.dir);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.meta, null, '\t'));
        fs.renameSync(`${file}.tmp`, file);
    }
    roomFile(room) {
        return path.join(this.dir, `${room}.xrr`);
    }
    rooms() {
        return Object.keys(this.meta.rooms);
    }
    index(room) {
        let index = this.indexes.get(room);
        if (index === undefined) {
            index = indexRecords(this.roomFile(room));
            this.indexes.set(room, index);
        }
        return index;
    }
    /** Forget cached state for a room after new records were appended. */
    invalidate(room) {
        this.indexes.delete(room);
        for (const key of this.frames.keys()) {
            if (key.startsWith(`${room}:`)) {
                this.frames.delete(key);
            }
        }
    }
    chunkIndexOf(tick) {
        return Math.floor(tick / this.meta.chunkTicks);
    }
    /**
     * Every frame stored for one aligned chunk of `chunkTicks` ticks, in
     * order. A chunk closed early (a flush) and reopened yields two records
     * in the same range; both start with a keyframe so they concatenate.
     */
    chunkFrames(room, chunkIndex) {
        const key = `${room}:${chunkIndex}`;
        let frames = this.frames.get(key);
        if (frames === undefined) {
            frames = [];
            const file = this.roomFile(room);
            for (const record of this.index(room)) {
                if (this.chunkIndexOf(record.firstTick) === chunkIndex) {
                    frames.push(...ChunkDecoder.all(readRecord(file, record)));
                }
            }
            this.frames.set(key, frames);
            // A handful of decoded chunks is plenty for a scrubbing client
            while (this.frames.size > 8) {
                this.frames.delete(this.frames.keys().next().value);
            }
        }
        return frames;
    }
    /** The room at one tick, if it was recorded. */
    frameAt(room, tick) {
        return this.chunkFrames(room, this.chunkIndexOf(tick)).find(frame => frame.tick === tick);
    }
    /**
     * A room-history chunk in the official client's shape for ticks
     * [base, base + size). `live` supplies frames the recorder still holds
     * in memory for the chunk being written.
     */
    history(room, base, size, live) {
        if (!this.meta.rooms[room]) {
            return undefined;
        }
        const first = this.chunkIndexOf(base);
        const last = this.chunkIndexOf(base + size - 1);
        const frames = [];
        for (let chunkIndex = first; chunkIndex <= last; ++chunkIndex) {
            frames.push(...this.chunkFrames(room, chunkIndex));
            if (live) {
                const held = live(chunkIndex);
                const after = frames.length === 0 ? -1 : frames[frames.length - 1].tick;
                frames.push(...held.filter(frame => frame.tick > after));
            }
        }
        return {
            timestamp: this.meta.created,
            room,
            base,
            ticks: historyTicks(frames, base, size),
        };
    }
}
//# sourceMappingURL=recording.js.map