// A recording is either a directory - `meta.json`, `terrain.bin`, one
// append-only `<room>.xrr` per room - or the same entries packed into one
// `.xrr` bundle file for sharing. The recorder writes directories (appending
// to a room's file is cheap and a crash loses at most the open chunk);
// `pack` turns one into a bundle and `unpack` the reverse. Readers take
// either.
//
// A room file is a sequence of records, each a compressed chunk (format.ts)
// behind a fixed 28-byte header, so a reader indexes a file by seeking over
// headers. A bundle is a header followed by named entries; the room entries
// are the room files byte for byte, so nothing is compressed twice.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { ChunkDecoder, historyTicks } from './format.js';
import type { Frame, HistoryTicks } from './format.js';
import { roomFromTerrainBin, terrainBinFromStrings } from './terrain.js';

export const CODECS = { none: 0, zstd: 1, brotli: 2 } as const;
export type Codec = keyof typeof CODECS;
const codecNames = Object.keys(CODECS) as Codec[];

export interface UserInfo {
	username: string;
	badge?: unknown;
}

export interface RoomMeta {
	/** Only in recordings made before terrain moved to terrain.bin. */
	terrain?: string;
	firstTick: number;
	lastTick: number;
	chunks: number;
	frames: number;
	bytes: number;
	/** The controller as last seen. */
	controller?: { user: string | null; level: number };
}

/** What the world view's timeline marks: ownership, levels, invader raids. */
export type RecordingEvent =
	{ kind: 'owner'; tick: number; room: string; user: string | null } |
	{ kind: 'level'; tick: number; room: string; level: number; user: string } |
	{ kind: 'raid'; room: string; from: number; to: number; users: string[] };

export interface RecordingMeta {
	version: 1;
	name: string;
	shard: string;
	created: number;
	/** Wall clock of the last save. */
	updated?: number;
	chunkTicks: number;
	codec: Codec;
	firstTick: number;
	lastTick: number;
	users: Record<string, UserInfo>;
	rooms: Record<string, RoomMeta>;
	/** Absent in recordings made before events were tracked (scanned on demand). */
	events?: RecordingEvent[];
}

export interface ChunkRecord {
	/** Absolute offset of the record header in its file. */
	offset: number;
	codec: number;
	firstTick: number;
	lastTick: number;
	frames: number;
	rawLength: number;
	length: number;
}

/** Where an entry's bytes live: a whole file, or a span of a bundle. */
export interface Entry {
	file: string;
	offset: number;
	length: number;
}

const MAGIC = [ 0x58, 0x52, 0x52, 0x43 ]; // XRRC
const RECORD_VERSION = 1;
export const RECORD_HEADER = 28;

const BUNDLE_MAGIC = [ 0x58, 0x52, 0x52, 0x42 ]; // XRRB
const BUNDLE_VERSION = 1;

// --- codecs -----------------------------------------------------------------

// zstd arrived in Node 22.15 / 23.8; older runtimes get brotli instead.
export const hasZstd = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function';
let warnedZstd = false;

/** The codec actually used for `codec` on this runtime. */
export function effectiveCodec(codec: Codec): Codec {
	if (codec === 'zstd' && !hasZstd) {
		if (!warnedZstd) {
			warnedZstd = true;
			console.warn(`replay: this Node (${process.version}) has no zstd; recording with brotli instead`);
		}
		return 'brotli';
	}
	return codec;
}

export function compress(raw: Uint8Array, codec: Codec, level?: number): Uint8Array {
	switch (effectiveCodec(codec)) {
		case 'none': return raw;
		case 'zstd': return zlib.zstdCompressSync(raw, {
			params: { [zlib.constants.ZSTD_c_compressionLevel]: level ?? 19 },
		});
		// Measured on a 19k-tick run: brotli 5 lands within 2% of zstd 19 and
		// brotli 11, encodes in a millisecond per chunk, and every Node has it.
		case 'brotli': return zlib.brotliCompressSync(raw, {
			params: {
				[zlib.constants.BROTLI_PARAM_QUALITY]: level ?? 5,
				[zlib.constants.BROTLI_PARAM_LGWIN]: 24,
				[zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
			},
		});
		default: throw new Error(`Unknown codec ${codec}`);
	}
}

export function decompress(data: Uint8Array, codec: number): Uint8Array {
	switch (codecNames[codec]) {
		case 'none': return data;
		case 'zstd':
			if (!hasZstd) {
				throw new Error(`This recording is zstd-compressed and Node ${process.version} cannot read it; use Node 22.15 or newer`);
			}
			return zlib.zstdDecompressSync(data);
		case 'brotli': return zlib.brotliDecompressSync(data);
		default: throw new Error(`Unknown codec id ${codec}`);
	}
}

// --- records ----------------------------------------------------------------

export function encodeRecord(raw: Uint8Array, codec: Codec, firstTick: number, lastTick: number, frames: number, level?: number): Uint8Array {
	const used = effectiveCodec(codec);
	const payload = compress(raw, used, level);
	const record = new Uint8Array(RECORD_HEADER + payload.length);
	const view = new DataView(record.buffer);
	record.set(MAGIC, 0);
	record[4] = RECORD_VERSION;
	record[5] = CODECS[used];
	view.setUint16(6, 0, true);
	view.setUint32(8, firstTick, true);
	view.setUint32(12, lastTick, true);
	view.setUint32(16, frames, true);
	view.setUint32(20, raw.length, true);
	view.setUint32(24, payload.length, true);
	record.set(payload, RECORD_HEADER);
	return record;
}

function parseHeader(header: Uint8Array, offset: number): ChunkRecord {
	if (MAGIC.some((byte, ii) => header[ii] !== byte)) {
		throw new Error(`Bad record magic at ${offset}`);
	}
	if (header[4] !== RECORD_VERSION) {
		throw new Error(`Unsupported record version ${header[4]}`);
	}
	const view = new DataView(header.buffer, header.byteOffset);
	return {
		offset,
		codec: header[5]!,
		firstTick: view.getUint32(8, true),
		lastTick: view.getUint32(12, true),
		frames: view.getUint32(16, true),
		rawLength: view.getUint32(20, true),
		length: view.getUint32(24, true),
	};
}

function fileEntry(file: string): Entry | undefined {
	try {
		return { file, offset: 0, length: fs.statSync(file).size };
	} catch {
		return undefined;
	}
}

/** Lists the records of a room entry by seeking over their headers. */
export function indexRecords(entry: Entry | string): ChunkRecord[] {
	const records: ChunkRecord[] = [];
	const span = typeof entry === 'string' ? fileEntry(entry) : entry;
	if (!span) {
		return records;
	}
	const fd = fs.openSync(span.file, 'r');
	try {
		const end = span.offset + span.length;
		const header = new Uint8Array(RECORD_HEADER);
		let offset = span.offset;
		while (offset + RECORD_HEADER <= end) {
			fs.readSync(fd, header, 0, RECORD_HEADER, offset);
			const record = parseHeader(header, offset);
			if (offset + RECORD_HEADER + record.length > end) {
				// Truncated tail: the writer died mid-record
				break;
			}
			records.push(record);
			offset += RECORD_HEADER + record.length;
		}
	} finally {
		fs.closeSync(fd);
	}
	return records;
}

/** Reads and decompresses one record's chunk. */
export function readRecord(file: string, record: ChunkRecord): Uint8Array {
	const fd = fs.openSync(file, 'r');
	try {
		const data = new Uint8Array(record.length);
		fs.readSync(fd, data, 0, record.length, record.offset + RECORD_HEADER);
		return decompress(data, record.codec);
	} finally {
		fs.closeSync(fd);
	}
}

function readEntry(entry: Entry): Buffer {
	const fd = fs.openSync(entry.file, 'r');
	try {
		const data = Buffer.alloc(entry.length);
		fs.readSync(fd, data, 0, entry.length, entry.offset);
		return data;
	} finally {
		fs.closeSync(fd);
	}
}

// --- bundles ----------------------------------------------------------------

/** The entries of a bundle file, by name, or undefined if it is not one. */
export function readBundleIndex(file: string): Map<string, Entry> | undefined {
	let fd: number;
	try {
		fd = fs.openSync(file, 'r');
	} catch {
		return undefined;
	}
	try {
		const size = fs.fstatSync(fd).size;
		const head = new Uint8Array(5);
		if (size < 5 || fs.readSync(fd, head, 0, 5, 0) < 5 || BUNDLE_MAGIC.some((byte, ii) => head[ii] !== byte)) {
			return undefined;
		}
		if (head[4] !== BUNDLE_VERSION) {
			throw new Error(`Unsupported bundle version ${head[4]}`);
		}
		const entries = new Map<string, Entry>();
		const fixed = new Uint8Array(9);
		let offset = 5;
		while (offset + 1 <= size) {
			fs.readSync(fd, fixed, 0, 1, offset);
			const nameLength = fixed[0]!;
			const nameBytes = new Uint8Array(nameLength);
			fs.readSync(fd, nameBytes, 0, nameLength, offset + 1);
			fs.readSync(fd, fixed, 0, 8, offset + 1 + nameLength);
			const view = new DataView(fixed.buffer);
			const length = view.getUint32(0, true) + view.getUint32(4, true) * 2 ** 32;
			const start = offset + 1 + nameLength + 8;
			if (start + length > size) {
				break;
			}
			entries.set(new TextDecoder().decode(nameBytes), { file, offset: start, length });
			offset = start + length;
		}
		return entries;
	} finally {
		fs.closeSync(fd);
	}
}

/** Packs a recording directory into one bundle file. Returns bytes written. */
export function packRecording(dir: string, file: string): number {
	const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RecordingMeta;
	const names = [ 'meta.json', 'terrain.bin', ...Object.keys(meta.rooms).map(room => `${room}.xrr`) ]
		.filter(name => fs.existsSync(path.join(dir, name)));
	const out = fs.openSync(file, 'w');
	let written = 0;
	const write = (bytes: Uint8Array) => {
		fs.writeSync(out, bytes);
		written += bytes.length;
	};
	try {
		write(new Uint8Array([ ...BUNDLE_MAGIC, BUNDLE_VERSION ]));
		for (const name of names) {
			const nameBytes = new TextEncoder().encode(name);
			const size = fs.statSync(path.join(dir, name)).size;
			const header = new Uint8Array(1 + nameBytes.length + 8);
			header[0] = nameBytes.length;
			header.set(nameBytes, 1);
			const view = new DataView(header.buffer, 1 + nameBytes.length);
			view.setUint32(0, size % 2 ** 32, true);
			view.setUint32(4, Math.floor(size / 2 ** 32), true);
			write(header);
			// Copy in slices: a room file can be larger than one wants in memory
			const src = fs.openSync(path.join(dir, name), 'r');
			try {
				const buffer = Buffer.alloc(1 << 20);
				let position = 0;
				while (position < size) {
					const count = fs.readSync(src, buffer, 0, Math.min(buffer.length, size - position), position);
					if (count <= 0) {
						break;
					}
					write(buffer.subarray(0, count));
					position += count;
				}
			} finally {
				fs.closeSync(src);
			}
		}
	} finally {
		fs.closeSync(out);
	}
	return written;
}

/** Unpacks a bundle into a recording directory. */
export function unpackRecording(file: string, dir: string) {
	const entries = readBundleIndex(file);
	if (!entries) {
		throw new Error(`${file} is not a recording bundle`);
	}
	fs.mkdirSync(dir, { recursive: true });
	for (const [ name, entry ] of entries) {
		if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
			continue;
		}
		fs.writeFileSync(path.join(dir, name), readEntry(entry));
	}
}

export interface HistoryChunk {
	timestamp: number;
	room: string;
	base: number;
	ticks: HistoryTicks;
}

// --- the recording ----------------------------------------------------------

export class Recording {
	private readonly indexes = new Map<string, ChunkRecord[]>();
	private readonly frames = new Map<string, Frame[]>();
	private terrainCache: Buffer | null | undefined;

	/** What the recording is called in URLs: its directory or file name. */
	readonly name: string;

	/**
	 * @param location the directory, or the bundle file
	 * @param entries the bundle's entries; undefined for a directory
	 */
	constructor(readonly location: string, public meta: RecordingMeta, private readonly entries?: Map<string, Entry>) {
		this.name = path.basename(location).replace(/\.xrr$/i, '');
	}

	/** A bundle is read-only. */
	get bundle() {
		return this.entries !== undefined;
	}

	/** The directory, for writers. */
	get dir() {
		if (this.entries) {
			throw new Error(`${this.location} is a bundle; unpack it to write`);
		}
		return this.location;
	}

	static metaFile(dir: string) {
		return path.join(dir, 'meta.json');
	}

	/** Opens a recording directory or a bundle file. */
	static open(location: string): Recording | undefined {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(location);
		} catch {
			return undefined;
		}
		return stat.isDirectory() ? Recording.openDir(location) : Recording.openBundle(location);
	}

	static openDir(dir: string): Recording | undefined {
		try {
			const meta = JSON.parse(fs.readFileSync(Recording.metaFile(dir), 'utf8')) as RecordingMeta;
			return meta.version === 1 ? new Recording(dir, meta) : undefined;
		} catch {
			return undefined;
		}
	}

	static openBundle(file: string): Recording | undefined {
		try {
			const entries = readBundleIndex(file);
			const metaEntry = entries?.get('meta.json');
			if (!entries || !metaEntry) {
				return undefined;
			}
			const meta = JSON.parse(readEntry(metaEntry).toString('utf8')) as RecordingMeta;
			return meta.version === 1 ? new Recording(file, meta, entries) : undefined;
		} catch {
			return undefined;
		}
	}

	/** Every recording under `root` - directories and bundles - newest first. */
	static list(root: string): Recording[] {
		let names: string[];
		try {
			names = fs.readdirSync(root);
		} catch {
			return [];
		}
		const recordings: Recording[] = [];
		for (const name of names) {
			const recording = Recording.open(path.join(root, name));
			if (recording) {
				recordings.push(recording);
			}
		}
		return recordings.sort((left, right) => right.meta.created - left.meta.created);
	}

	saveMeta() {
		const dir = this.dir;
		fs.mkdirSync(dir, { recursive: true });
		this.meta.updated = Date.now();
		const file = Recording.metaFile(dir);
		fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.meta, null, '\t'));
		fs.renameSync(`${file}.tmp`, file);
	}

	/** Where a named entry lives, if it exists. */
	entry(name: string): Entry | undefined {
		return this.entries ? this.entries.get(name) : fileEntry(path.join(this.location, name));
	}

	/** The room file, for the recorder (directories only). */
	roomFile(room: string) {
		return path.join(this.dir, `${room}.xrr`);
	}

	rooms(): string[] {
		return Object.keys(this.meta.rooms);
	}

	index(room: string): ChunkRecord[] {
		let index = this.indexes.get(room);
		if (index === undefined) {
			const entry = this.entry(`${room}.xrr`);
			index = entry ? indexRecords(entry) : [];
			this.indexes.set(room, index);
		}
		return index;
	}

	/** One record's chunk, decompressed. */
	readChunk(room: string, record: ChunkRecord): Uint8Array {
		const entry = this.entry(`${room}.xrr`);
		if (!entry) {
			throw new Error(`No recording for ${room}`);
		}
		return readRecord(entry.file, record);
	}

	/** Bytes the recording takes, all entries together. */
	size(): number {
		if (this.entries) {
			return fs.statSync(this.location).size;
		}
		let total = 0;
		for (const name of [ 'meta.json', 'terrain.bin', ...this.rooms().map(room => `${room}.xrr`) ]) {
			total += this.entry(name)?.length ?? 0;
		}
		return total;
	}

	/** Forget cached state for a room after new records were appended. */
	invalidate(room: string) {
		this.indexes.delete(room);
		for (const key of this.frames.keys()) {
			if (key.startsWith(`${room}:`)) {
				this.frames.delete(key);
			}
		}
	}

	/** The world's terrain.bin; built from the rooms' own strings for old recordings. */
	terrainBin(): Buffer | undefined {
		if (this.terrainCache === undefined) {
			const entry = this.entry('terrain.bin');
			this.terrainCache = entry
				? readEntry(entry)
				: terrainBinFromStrings(Object.entries(this.meta.rooms).flatMap(([ name, info ]) => info.terrain ? [ { name, terrain: info.terrain } ] : [])) ?? null;
		}
		return this.terrainCache ?? undefined;
	}

	/** A room's terrain as the 2500-character string the client uses. */
	terrain(room: string): string | undefined {
		const stored = this.meta.rooms[room]?.terrain;
		if (stored) {
			return stored;
		}
		const bin = this.terrainBin();
		return bin ? roomFromTerrainBin(bin, room) : undefined;
	}

	chunkIndexOf(tick: number) {
		return Math.floor(tick / this.meta.chunkTicks);
	}

	/**
	 * Every frame stored for one aligned chunk of `chunkTicks` ticks, in
	 * order. A chunk closed early (a flush) and reopened yields two records
	 * in the same range; both start with a keyframe so they concatenate.
	 */
	chunkFrames(room: string, chunkIndex: number): Frame[] {
		const key = `${room}:${chunkIndex}`;
		let frames = this.frames.get(key);
		if (frames === undefined) {
			frames = [];
			for (const record of this.index(room)) {
				if (this.chunkIndexOf(record.firstTick) === chunkIndex) {
					frames.push(...ChunkDecoder.all(this.readChunk(room, record)));
				}
			}
			this.frames.set(key, frames);
			// A handful of decoded chunks is plenty for a scrubbing client
			while (this.frames.size > 8) {
				this.frames.delete(this.frames.keys().next().value!);
			}
		}
		return frames;
	}

	/** The room at one tick, if it was recorded. */
	frameAt(room: string, tick: number): Frame | undefined {
		return this.chunkFrames(room, this.chunkIndexOf(tick)).find(frame => frame.tick === tick);
	}

	/**
	 * A room-history chunk in the official client's shape for ticks
	 * [base, base + size). `live` supplies frames the recorder still holds
	 * in memory for the chunk being written.
	 */
	history(room: string, base: number, size: number, live?: (chunkIndex: number) => Frame[]): HistoryChunk | undefined {
		if (!this.meta.rooms[room]) {
			return undefined;
		}
		const first = this.chunkIndexOf(base);
		const last = this.chunkIndexOf(base + size - 1);
		const frames: Frame[] = [];
		for (let chunkIndex = first; chunkIndex <= last; ++chunkIndex) {
			frames.push(...this.chunkFrames(room, chunkIndex));
			if (live) {
				const held = live(chunkIndex);
				const after = frames.length === 0 ? -1 : frames[frames.length - 1]!.tick;
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
