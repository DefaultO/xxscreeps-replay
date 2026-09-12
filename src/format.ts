// The .xrr chunk codec: a self-contained run of ticks for one room, encoded
// as a keyframe followed by predictive deltas.
//
// A frame is the room as the official client sees it: every object rendered
// to the JSON the room socket sends (`_id`, `type`, `x`, `y`, `hits`,
// `store`, `body`, ...). Each object is flattened to `path -> leaf`
// (`store.energy`, `body` as one array leaf). Per field the codec keeps the
// last value and the last two deltas; when the two deltas agree the field
// is predicted to keep moving (`ticksToLive` counting down, a source's
// energy under a constant harvest, a creep walking a straight line), else to
// stay put. Only non-zero residuals are written, as `key<<2|kind` codes and
// zigzag varints, so a room where nothing surprising happens costs a few
// bytes per tick before compression.
//
// Pure: no Node or xxscreeps imports, so the CLI and a browser viewer can
// share it.

export type Leaf = null | boolean | number | string | unknown[] | Record<string, unknown>;
export type Flat = Map<string, Leaf>;
export type Objects = Map<string, Record<string, unknown>>;

export const FORMAT_VERSION = 1;

const KIND_RES = 0;
const KIND_ABS = 1;
const KIND_DEL = 2;

const T_NULL = 0;
const T_FALSE = 1;
const T_TRUE = 2;
const T_INT = 3;
const T_FLOAT = 4;
const T_STR = 5;
const T_EMPTY = 6;
const T_ARR = 7;
const T_OBJ = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Ints beyond this are stored as floats; residual arithmetic stays exact.
const INT_LIMIT = 2 ** 48;

function isInt(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= INT_LIMIT;
}

// --- byte streams -----------------------------------------------------------

export class Writer {
	private buffer = new Uint8Array(4096);
	length = 0;

	private reserve(count: number) {
		if (this.length + count > this.buffer.length) {
			let size = this.buffer.length * 2;
			while (size < this.length + count) {
				size *= 2;
			}
			const next = new Uint8Array(size);
			next.set(this.buffer.subarray(0, this.length));
			this.buffer = next;
		}
	}

	u8(value: number) {
		this.reserve(1);
		this.buffer[this.length++] = value & 0xff;
	}

	varint(value: number) {
		if (value < 0 || !Number.isFinite(value)) {
			throw new Error(`Bad varint: ${value}`);
		}
		this.reserve(8);
		while (value >= 0x80) {
			this.buffer[this.length++] = (value % 0x80) | 0x80;
			value = Math.floor(value / 0x80);
		}
		this.buffer[this.length++] = value;
	}

	zigzag(value: number) {
		this.varint(value >= 0 ? value * 2 : -value * 2 - 1);
	}

	float(value: number) {
		this.reserve(8);
		new DataView(this.buffer.buffer, this.buffer.byteOffset + this.length, 8).setFloat64(0, value, true);
		this.length += 8;
	}

	bytes(value: Uint8Array) {
		this.varint(value.length);
		this.reserve(value.length);
		this.buffer.set(value, this.length);
		this.length += value.length;
	}

	string(value: string) {
		this.bytes(encoder.encode(value));
	}

	append(value: Uint8Array) {
		this.reserve(value.length);
		this.buffer.set(value, this.length);
		this.length += value.length;
	}

	finish(): Uint8Array {
		return this.buffer.slice(0, this.length);
	}
}

export class Reader {
	offset: number;
	constructor(private readonly buffer: Uint8Array, offset = 0) {
		this.offset = offset;
	}

	get done() {
		return this.offset >= this.buffer.length;
	}

	u8() {
		if (this.offset >= this.buffer.length) {
			throw new Error('Read past end');
		}
		return this.buffer[this.offset++]!;
	}

	varint() {
		let value = 0;
		let scale = 1;
		for (;;) {
			const byte = this.u8();
			value += (byte & 0x7f) * scale;
			if (byte < 0x80) {
				return value;
			}
			scale *= 0x80;
		}
	}

	zigzag() {
		const value = this.varint();
		return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
	}

	float() {
		const value = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.offset, 8).getFloat64(0, true);
		this.offset += 8;
		return value;
	}

	bytes() {
		const length = this.varint();
		const value = this.buffer.subarray(this.offset, this.offset + length);
		this.offset += length;
		return value;
	}

	string() {
		return decoder.decode(this.bytes());
	}
}

// --- flattening -------------------------------------------------------------

// Marker leaf for `{}`: an empty nested object has no paths of its own.
export const EMPTY: Record<string, never> = Object.freeze({});

export function flatten(value: Record<string, unknown>, into: Flat = new Map(), prefix = ''): Flat {
	for (const key in value) {
		const child = value[key];
		if (child === undefined) {
			continue;
		}
		const path = prefix === '' ? key : `${prefix}.${key}`;
		if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
			const before = into.size;
			flatten(child as Record<string, unknown>, into, path);
			if (into.size === before) {
				into.set(path, EMPTY);
			}
		} else {
			into.set(path, child as Leaf);
		}
	}
	return into;
}

export function unflatten(flat: Flat): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [ path, leaf ] of flat) {
		const parts = path.split('.');
		let node = out;
		for (let ii = 0; ii < parts.length - 1; ++ii) {
			const part = parts[ii]!;
			let next = node[part];
			if (next === undefined || next === null || typeof next !== 'object') {
				next = node[part] = {};
			}
			node = next as Record<string, unknown>;
		}
		node[parts[parts.length - 1]!] = leaf === EMPTY ? {} : leaf;
	}
	return out;
}

// --- field state ------------------------------------------------------------

interface Field {
	value: Leaf;
	// JSON of array / object leaves, for change detection.
	json: string | null;
	// Last two deltas of an int field; NaN when there is no history.
	d1: number;
	d2: number;
}

interface Obj {
	index: number;
	fields: Map<number, Field>;
}

function leafJson(leaf: Leaf): string | null {
	return leaf !== null && typeof leaf === 'object' ? JSON.stringify(leaf) : null;
}

function freshField(leaf: Leaf): Field {
	return { value: leaf, json: leafJson(leaf), d1: NaN, d2: NaN };
}

function sameLeaf(field: Field, leaf: Leaf, json: string | null) {
	return json === null ? field.value === leaf && field.json === null : field.json === json;
}

// --- values -----------------------------------------------------------------

class Tables {
	readonly keys = new Map<string, number>();
	readonly keyList: string[] = [];
	readonly strings = new Map<string, number>();
	readonly stringList: string[] = [];

	key(path: string) {
		let index = this.keys.get(path);
		if (index === undefined) {
			index = this.keyList.length;
			this.keys.set(path, index);
			this.keyList.push(path);
		}
		return index;
	}

	string(value: string) {
		let index = this.strings.get(value);
		if (index === undefined) {
			index = this.stringList.length;
			this.strings.set(value, index);
			this.stringList.push(value);
		}
		return index;
	}

	write(writer: Writer, list: string[]) {
		writer.varint(list.length);
		for (const value of list) {
			writer.string(value);
		}
	}

	static read(reader: Reader): string[] {
		const count = reader.varint();
		const list: string[] = [];
		for (let ii = 0; ii < count; ++ii) {
			list.push(reader.string());
		}
		return list;
	}
}

function writeValue(writer: Writer, tables: Tables, value: unknown) {
	if (value === null || value === undefined) {
		writer.u8(T_NULL);
	} else if (value === false) {
		writer.u8(T_FALSE);
	} else if (value === true) {
		writer.u8(T_TRUE);
	} else if (typeof value === 'number') {
		if (isInt(value)) {
			writer.u8(T_INT);
			writer.zigzag(value);
		} else {
			writer.u8(T_FLOAT);
			writer.float(value);
		}
	} else if (typeof value === 'string') {
		writer.u8(T_STR);
		writer.varint(tables.string(value));
	} else if (Array.isArray(value)) {
		writer.u8(T_ARR);
		writer.varint(value.length);
		for (const element of value) {
			writeValue(writer, tables, element);
		}
	} else if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).filter(entry => entry[1] !== undefined);
		if (entries.length === 0) {
			writer.u8(T_EMPTY);
		} else {
			writer.u8(T_OBJ);
			writer.varint(entries.length);
			for (const [ key, child ] of entries) {
				writer.varint(tables.string(key));
				writeValue(writer, tables, child);
			}
		}
	} else {
		throw new Error(`Cannot encode ${typeof value}`);
	}
}

function readValue(reader: Reader, strings: string[]): Leaf {
	const tag = reader.u8();
	switch (tag) {
		case T_NULL: return null;
		case T_FALSE: return false;
		case T_TRUE: return true;
		case T_INT: return reader.zigzag();
		case T_FLOAT: return reader.float();
		case T_STR: return strings[reader.varint()]!;
		case T_EMPTY: return EMPTY;
		case T_ARR: {
			const length = reader.varint();
			const value: unknown[] = [];
			for (let ii = 0; ii < length; ++ii) {
				const element = readValue(reader, strings);
				value.push(element === EMPTY ? {} : element);
			}
			return value;
		}
		case T_OBJ: {
			const count = reader.varint();
			const value: Record<string, unknown> = {};
			for (let ii = 0; ii < count; ++ii) {
				const key = strings[reader.varint()]!;
				const element = readValue(reader, strings);
				value[key] = element === EMPTY ? {} : element;
			}
			return value;
		}
		default: throw new Error(`Bad value tag ${tag}`);
	}
}

// --- encoder ----------------------------------------------------------------

export class ChunkEncoder {
	firstTick = -1;
	lastTick = -1;
	frameCount = 0;
	private readonly tables = new Tables();
	private readonly objects = new Map<string, Obj>();
	private nextIndex = 0;
	private readonly frames = new Writer();

	get empty() {
		return this.frameCount === 0;
	}

	/** Raw (uncompressed) size so far, for flush heuristics. */
	get size() {
		return this.frames.length;
	}

	addFrame(tick: number, objects: Objects) {
		if (this.frameCount === 0) {
			this.firstTick = tick;
		} else if (tick <= this.lastTick) {
			throw new Error(`Frame ${tick} is not after ${this.lastTick}`);
		}
		const { frames, tables } = this;
		frames.varint(this.frameCount === 0 ? 0 : tick - this.lastTick);

		// Objects gone since the last frame
		const removed: number[] = [];
		for (const [ id, obj ] of this.objects) {
			if (!objects.has(id)) {
				removed.push(obj.index);
				this.objects.delete(id);
			}
		}
		removed.sort((left, right) => left - right);
		frames.varint(removed.length);
		let previous = 0;
		for (const index of removed) {
			frames.varint(index - previous);
			previous = index;
		}

		// Split the rest into new and known objects
		const added: [ string, Flat ][] = [];
		const changed: [ Obj, Flat ][] = [];
		for (const [ id, nested ] of objects) {
			const flat = flatten(nested);
			flat.delete('_id');
			const obj = this.objects.get(id);
			if (obj) {
				changed.push([ obj, flat ]);
			} else {
				added.push([ id, flat ]);
			}
		}

		frames.varint(added.length);
		for (const [ id, flat ] of added) {
			const obj: Obj = { index: this.nextIndex++, fields: new Map() };
			this.objects.set(id, obj);
			frames.string(id);
			frames.varint(flat.size);
			for (const [ path, leaf ] of flat) {
				const key = tables.key(path);
				frames.varint(key * 4 + KIND_ABS);
				writeValue(frames, tables, leaf);
				obj.fields.set(key, freshField(leaf));
			}
		}

		// Known objects: only the surprises
		changed.sort((left, right) => left[0].index - right[0].index);
		const pending: [ Obj, Writer, number ][] = [];
		for (const [ obj, flat ] of changed) {
			const entries = new Writer();
			let count = 0;
			for (const key of obj.fields.keys()) {
				if (!flat.has(tables.keyList[key]!)) {
					entries.varint(key * 4 + KIND_DEL);
					++count;
					obj.fields.delete(key);
				}
			}
			for (const [ path, leaf ] of flat) {
				const key = tables.key(path);
				const field = obj.fields.get(key);
				if (field === undefined) {
					entries.varint(key * 4 + KIND_ABS);
					writeValue(entries, tables, leaf);
					++count;
					obj.fields.set(key, freshField(leaf));
				} else if (isInt(leaf) && isInt(field.value)) {
					const predicted = field.d1 === field.d2 ? field.value + field.d1 : field.value;
					const residual = leaf - predicted;
					if (residual !== 0) {
						entries.varint(key * 4 + KIND_RES);
						entries.zigzag(residual);
						++count;
					}
					const delta = leaf - field.value;
					field.d2 = field.d1;
					field.d1 = delta;
					field.value = leaf;
				} else {
					const json = leafJson(leaf);
					if (!sameLeaf(field, leaf, json)) {
						entries.varint(key * 4 + KIND_ABS);
						writeValue(entries, tables, leaf);
						++count;
					}
					field.value = leaf;
					field.json = json;
					field.d1 = field.d2 = NaN;
				}
			}
			if (count > 0) {
				pending.push([ obj, entries, count ]);
			}
		}
		frames.varint(pending.length);
		previous = 0;
		for (const [ obj, entries, count ] of pending) {
			frames.varint(obj.index - previous);
			previous = obj.index;
			frames.varint(count);
			frames.append(entries.finish());
		}

		this.lastTick = tick;
		++this.frameCount;
	}

	finish(): Uint8Array {
		const header = new Writer();
		header.varint(FORMAT_VERSION);
		header.varint(this.firstTick);
		header.varint(this.lastTick);
		header.varint(this.frameCount);
		this.tables.write(header, this.tables.keyList);
		this.tables.write(header, this.tables.stringList);
		header.append(this.frames.finish());
		return header.finish();
	}
}

// --- decoder ----------------------------------------------------------------

export interface Frame {
	tick: number;
	/** The room at that tick as nested client JSON, keyed by object id. */
	objects: Objects;
}

export class ChunkDecoder {
	readonly firstTick: number;
	readonly lastTick: number;
	readonly frameCount: number;
	private readonly keys: string[];
	private readonly strings: string[];
	private readonly reader: Reader;
	private readonly objects = new Map<string, Obj>();
	private readonly ids = new Map<number, string>();
	private nextIndex = 0;
	private decoded = 0;
	private tick = -1;
	/** Delta entries seen per field path, plus `+object` / `-object` counts. */
	readonly stats = new Map<string, number>();

	constructor(raw: Uint8Array) {
		const reader = this.reader = new Reader(raw);
		const version = reader.varint();
		if (version !== FORMAT_VERSION) {
			throw new Error(`Unsupported chunk version ${version}`);
		}
		this.firstTick = reader.varint();
		this.lastTick = reader.varint();
		this.frameCount = reader.varint();
		this.keys = Tables.read(reader);
		this.strings = Tables.read(reader);
	}

	get done() {
		return this.decoded >= this.frameCount;
	}

	/** Decodes the next frame, or returns null after the last one. */
	next(): Frame | null {
		if (this.done) {
			return null;
		}
		const { reader, strings } = this;
		const delta = reader.varint();
		this.tick = this.decoded === 0 ? this.firstTick : this.tick + delta;

		const removedCount = reader.varint();
		let previous = 0;
		for (let ii = 0; ii < removedCount; ++ii) {
			const index = previous + reader.varint();
			previous = index;
			const id = this.ids.get(index);
			if (id === undefined) {
				throw new Error(`Removed unknown object #${index}`);
			}
			this.ids.delete(index);
			this.objects.delete(id);
		}
		this.count('-object', removedCount);

		const touched = new Map<Obj, Set<number>>();
		const addedCount = reader.varint();
		this.count('+object', addedCount);
		for (let ii = 0; ii < addedCount; ++ii) {
			const id = reader.string();
			const obj: Obj = { index: this.nextIndex++, fields: new Map() };
			this.objects.set(id, obj);
			this.ids.set(obj.index, id);
			const fieldCount = reader.varint();
			const fields = new Set<number>();
			for (let jj = 0; jj < fieldCount; ++jj) {
				const code = reader.varint();
				const key = Math.floor(code / 4);
				const leaf = readValue(reader, strings);
				obj.fields.set(key, freshField(leaf));
				fields.add(key);
			}
			touched.set(obj, fields);
		}

		const changedCount = reader.varint();
		previous = 0;
		for (let ii = 0; ii < changedCount; ++ii) {
			const index = previous + reader.varint();
			previous = index;
			const id = this.ids.get(index);
			const obj = id === undefined ? undefined : this.objects.get(id);
			if (obj === undefined) {
				throw new Error(`Changed unknown object #${index}`);
			}
			const fields = new Set<number>();
			touched.set(obj, fields);
			const entryCount = reader.varint();
			for (let jj = 0; jj < entryCount; ++jj) {
				const code = reader.varint();
				const key = Math.floor(code / 4);
				const kind = code % 4;
				fields.add(key);
				this.count(this.keys[key]!, 1);
				if (kind === KIND_DEL) {
					obj.fields.delete(key);
				} else if (kind === KIND_ABS) {
					obj.fields.set(key, freshField(readValue(reader, strings)));
				} else if (kind === KIND_RES) {
					const field = obj.fields.get(key);
					if (field === undefined || !isInt(field.value)) {
						throw new Error(`Residual for non-int field ${this.keys[key]}`);
					}
					const predicted = field.d1 === field.d2 ? field.value + field.d1 : field.value;
					const value = predicted + reader.zigzag();
					field.d2 = field.d1;
					field.d1 = value - field.value;
					field.value = value;
				} else {
					throw new Error(`Bad entry kind ${kind}`);
				}
			}
		}

		// Everything not mentioned follows its prediction
		for (const obj of this.objects.values()) {
			const fields = touched.get(obj);
			for (const [ key, field ] of obj.fields) {
				if (fields?.has(key) || !isInt(field.value)) {
					continue;
				}
				const delta = field.d1 === field.d2 ? field.d1 : 0;
				field.value += delta;
				field.d2 = field.d1;
				field.d1 = delta;
			}
		}

		++this.decoded;
		return { tick: this.tick, objects: this.snapshot() };
	}

	private count(key: string, by: number) {
		if (by > 0) {
			this.stats.set(key, (this.stats.get(key) ?? 0) + by);
		}
	}

	/** The room as nested client JSON, keyed by object id. */
	snapshot(): Objects {
		const objects: Objects = new Map();
		for (const [ id, obj ] of this.objects) {
			const flat: Flat = new Map();
			for (const [ key, field ] of obj.fields) {
				flat.set(this.keys[key]!, field.value);
			}
			const nested = unflatten(flat);
			nested._id = id;
			objects.set(id, nested);
		}
		return objects;
	}

	/** Decodes every frame. */
	static all(raw: Uint8Array): Frame[] {
		const decoder = new ChunkDecoder(raw);
		const frames: Frame[] = [];
		for (let frame = decoder.next(); frame; frame = decoder.next()) {
			frames.push(frame);
		}
		return frames;
	}
}

// --- client history ---------------------------------------------------------

/**
 * The diff the room socket sends: changed fields only, `null` for a removed
 * field or object, arrays as index-keyed objects.
 */
export function diff(previous: unknown, next: unknown): unknown {
	if (previous === next) {
		return undefined;
	}
	if (previous == null || next == null || typeof previous !== typeof next) {
		return next == null ? null : next;
	}
	if (typeof previous === 'object') {
		const result: Record<string, unknown> = {};
		let didAdd = false;
		const left = previous as Record<string, unknown>;
		const right = next as Record<string, unknown>;
		for (const key of new Set([ ...Object.keys(left), ...Object.keys(right) ])) {
			const value = diff(left[key], right[key]);
			if (value !== undefined) {
				result[key] = value;
				didAdd = true;
			}
		}
		return didAdd ? result : undefined;
	}
	return next;
}

export type HistoryTicks = Record<string, Record<string, unknown> | null>;

/**
 * Builds the `ticks` block of a room-history chunk: the first recorded tick
 * in [base, base + size) in full, later recorded ticks as diffs against the
 * previous recorded tick, unrecorded ticks as `null`.
 */
export function historyTicks(frames: Iterable<Frame>, base: number, size: number): HistoryTicks {
	const ticks: HistoryTicks = {};
	for (let tick = base; tick < base + size; ++tick) {
		ticks[tick] = null;
	}
	// The client rebuilds a tick from an empty room by applying the window's
	// entries in order, so the first recorded tick is sent whole whatever
	// came before the window.
	let previous: Record<string, unknown> | undefined;
	for (const frame of frames) {
		if (frame.tick >= base + size) {
			break;
		}
		if (frame.tick < base) {
			continue;
		}
		const nested = Object.fromEntries(frame.objects);
		ticks[frame.tick] = previous === undefined
			? nested
			: (diff(previous, nested) as Record<string, unknown> | undefined) ?? {};
		previous = nested;
	}
	return ticks;
}
