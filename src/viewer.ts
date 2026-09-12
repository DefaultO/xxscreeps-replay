// The world view: shardreplay's viewer (Desktop/shardreplay/web - a canvas
// world map with the full-width timeline, transport controls and keyboard
// scrubbing) served against a recording. The page is untouched; this file
// answers the archive API it speaks, from .xrr chunks instead of shardkeeper
// packs. Mounted at /replay/<name>/map/ by backend.ts.
//
// The contract (serve.mjs in the shardreplay checkout):
//   api/span                   firstTick, lastTick, chunks, rooms, bytes
//   archive/status             the same plus newestAt / msPerTick for the clock
//   archive/index.json         coverage: { room: [firstBase, lastBase] }
//   archive/<room>/index.json  bases a room has
//   archive/<room>/<base>.json a 100-tick chunk: first tick whole, then diffs
//   archive/batch              several rooms' chunks for one base
//   archive/snapshot           several rooms folded to one tick (sketch=1: fewer fields)
//   api/activity, api/world    which rooms hold anything at a base, busiest first
//   api/season                 names, owners, levels and the timeline's events
//   badge/<user>.svg           the player's badge
//   terrain.bin                2 bits a tile, 625 bytes a room, a dim x dim grid

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { World } from 'xxscreeps/game/map.js';
import { badgeSvgFromFile, customBadgeSvg, isCustomBadge } from './badge.js';
import type { Frame } from './format.js';
import { ChunkDecoder, historyTicks } from './format.js';
import type { Recording, RecordingEvent } from './recording.js';
import { BYTES_PER_ROOM, writeTerrainBin } from './terrain.js';

const WINDOW = 100;
const INVADER = '2';

const SKETCH_KEYS = [ 'type', 'x', 'y', 'user', 'store', 'storeCapacity', 'storeCapacityResource',
	'resourceType', 'mineralType', 'mineralAmount', 'density', 'energyCapacity', 'energy', 'spawning',
	'safeMode', 'progressTotal', 'progress', 'reservation', 'level', 'cooldown', 'amount', 'structureType', 'body' ];

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.ttf': 'font/ttf',
};

export interface ViewerContext {
	path: string;
	url: string;
	method: string;
	query: Record<string, string | string[] | undefined>;
	type: string;
	status: number;
	body: unknown;
	set(field: string, value: string): void;
	redirect(url: string): void;
}

// --- events: what the timeline shows ----------------------------------------

/**
 * Controller changes and invader raids seen in one room's frames, appended
 * to `events`. `state` carries what was last seen so a scan can continue
 * across frames.
 */
export interface EventScanState {
	owner?: string | null;
	level?: number;
	raidFrom?: number;
	raidUsers?: Set<string>;
	lastTick?: number;
}

export function scanFrameEvents(room: string, frame: Frame, state: EventScanState, events: RecordingEvent[]) {
	let controller: Record<string, unknown> | undefined;
	let invaders = false;
	const users = new Set<string>();
	for (const object of frame.objects.values()) {
		if (object.type === 'controller') {
			controller = object;
		} else if (object.type === 'creep' && typeof object.user === 'string') {
			if (object.user === INVADER) {
				invaders = true;
			} else {
				users.add(object.user);
			}
		}
	}
	if (controller) {
		const owner = typeof controller.user === 'string' ? controller.user : null;
		const level = typeof controller.level === 'number' ? controller.level : 0;
		if (state.owner !== undefined && owner !== state.owner) {
			events.push({ kind: 'owner', tick: frame.tick, room, user: owner });
		}
		if (state.level !== undefined && level !== state.level && owner) {
			events.push({ kind: 'level', tick: frame.tick, room, level, user: owner });
		}
		state.owner = owner;
		state.level = level;
	}
	if (invaders) {
		if (state.raidFrom === undefined) {
			state.raidFrom = frame.tick;
			state.raidUsers = new Set();
		}
		for (const user of users) {
			state.raidUsers!.add(user);
		}
	} else if (state.raidFrom !== undefined) {
		events.push({ kind: 'raid', room, from: state.raidFrom, to: state.lastTick ?? frame.tick, users: [ INVADER, ...state.raidUsers! ] });
		delete state.raidFrom;
	}
	state.lastTick = frame.tick;
}

/** Closes a raid still open when the frames end. */
export function finishEventScan(room: string, state: EventScanState, events: RecordingEvent[]) {
	if (state.raidFrom !== undefined && state.lastTick !== undefined) {
		events.push({ kind: 'raid', room, from: state.raidFrom, to: state.lastTick, users: [ INVADER, ...state.raidUsers! ] });
		delete state.raidFrom;
	}
}

const scans = new Map<Recording, Promise<void>>();

/**
 * Recordings made before events were tracked get them from a scan of every
 * chunk, one record per turn of the event loop so the server keeps ticking,
 * written back to meta.json when done.
 */
function ensureEvents(recording: Recording): Promise<void> | undefined {
	const { meta } = recording;
	if (meta.events) {
		return undefined;
	}
	let scan = scans.get(recording);
	if (!scan) {
		scan = (async () => {
			const events: RecordingEvent[] = [];
			for (const room of recording.rooms()) {
				const state: EventScanState = {};
				for (const record of recording.index(room)) {
					for (const frame of ChunkDecoder.all(recording.readChunk(room, record))) {
						scanFrameEvents(room, frame, state, events);
					}
					await new Promise(resolve => setImmediate(resolve));
				}
				finishEventScan(room, state, events);
				const controller = state.owner !== undefined ? { user: state.owner, level: state.level ?? 0 } : undefined;
				if (controller && meta.rooms[room]) {
					meta.rooms[room]!.controller = controller;
				}
			}
			meta.events = events;
			if (!recording.bundle) {
				recording.saveMeta();
			}
		})().finally(() => scans.delete(recording));
		scans.set(recording, scan);
	}
	return scan;
}

// --- the API ----------------------------------------------------------------

function windowsOf(recording: Recording, room: string): number[] {
	const bases = new Set<number>();
	for (const record of recording.index(room)) {
		for (let base = Math.floor(record.firstTick / WINDOW) * WINDOW; base <= record.lastTick; base += WINDOW) {
			bases.add(base);
		}
	}
	return [ ...bases ].sort((left, right) => left - right);
}

/** Bytes a room's recording spends on one window, as the viewer's activity proxy. */
function activityAt(recording: Recording, base: number): { room: string; len: number }[] {
	const rows: { room: string; len: number }[] = [];
	for (const room of recording.rooms()) {
		let len = 0;
		for (const record of recording.index(room)) {
			if (record.firstTick <= base + WINDOW - 1 && record.lastTick >= base) {
				const span = Math.max(1, record.lastTick - record.firstTick + 1);
				len += Math.round(record.length * Math.min(WINDOW, span) / span);
			}
		}
		if (len > 0) {
			rows.push({ room, len });
		}
	}
	return rows.sort((left, right) => right.len - left.len);
}

function sketch(object: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of SKETCH_KEYS) {
		if (object[key] != null) {
			out[key] = object[key];
		}
	}
	const resourceType = object.resourceType;
	if (typeof resourceType === 'string' && object[resourceType] != null) {
		out[resourceType] = object[resourceType];
	}
	const actionLog = object.actionLog;
	if (actionLog && typeof actionLog === 'object') {
		const kept: Record<string, unknown> = {};
		let any = false;
		for (const [ key, value ] of Object.entries(actionLog as Record<string, unknown>)) {
			if (value) {
				kept[key] = value;
				any = true;
			}
		}
		if (any) {
			out.actionLog = kept;
		}
	}
	return out;
}

function chunkFor(recording: Recording, room: string, base: number) {
	const chunk = recording.history(room, base, WINDOW);
	if (!chunk || Object.values(chunk.ticks).every(tick => tick === null)) {
		return undefined;
	}
	return chunk;
}

function roomList(query: string | string[] | undefined, limit: number): string[] {
	const raw = typeof query === 'string' ? query : '';
	return raw.split(',').filter(name => /^[EW]\d+[NS]\d+$/.test(name)).slice(0, limit);
}

function seasonPayload(recording: Recording) {
	const { meta } = recording;
	const names: Record<string, string> = {};
	for (const [ id, user ] of Object.entries(meta.users)) {
		names[id] = user.username;
	}
	names[INVADER] = 'Invader';
	const owners: Record<string, string> = {};
	const levels: Record<string, number> = {};
	for (const [ room, info ] of Object.entries(meta.rooms)) {
		if (info.controller?.user) {
			owners[room] = info.controller.user;
			levels[room] = info.controller.level;
		}
	}
	const ownerLog: object[] = [];
	const levelLog: object[] = [];
	const operations: Record<string, object[]> = {};
	for (const event of meta.events ?? []) {
		if (event.kind === 'owner') {
			ownerLog.push({ tick: event.tick, room: event.room, user: event.user });
		} else if (event.kind === 'level') {
			levelLog.push({ tick: event.tick, room: event.room, level: event.level, user: event.user });
		} else if (event.kind === 'raid') {
			(operations[event.room] ??= []).push({
				room: event.room, from: event.from, to: event.to, users: event.users,
				names: event.users.map(user => names[user] ?? null),
			});
		}
	}
	return {
		from: meta.firstTick,
		to: meta.lastTick,
		bucket: WINDOW,
		reactors: [],
		log: [],
		events: [],
		thorium: [],
		minerals: {},
		mineralMax: 0,
		owners,
		levels,
		ownerLog,
		levelLog,
		damageByRoom: {},
		deathsByRoom: {},
		names,
		dealtBy: {},
		pvpByRoom: {},
		pvpBy: {},
		operations,
		storedByRoom: {},
		storedPeakByRoom: {},
		healedBy: {},
		lostBy: {},
	};
}

export interface ViewerOptions {
	/** The shardreplay `web` directory. */
	dir: string | undefined;
	/** Directory of `<username>.svg` badge images. */
	badges?: string;
	/** The live world, for a recording that has no terrain.bin of its own. */
	world?: World;
	roomNames?: Iterable<string>;
}

/**
 * Answers one request under the viewer mount. Returns false when the path is
 * not part of the viewer (the caller keeps routing), true when answered.
 */
export async function serveViewer(context: ViewerContext, recording: Recording, rest: string, options: ViewerOptions): Promise<boolean> {
	const { meta } = recording;
	const totals = () => {
		let chunks = 0;
		let bytes = 0;
		for (const info of Object.values(meta.rooms)) {
			chunks += info.chunks;
			bytes += info.bytes;
		}
		return { chunks, bytes, rooms: Object.keys(meta.rooms).length };
	};
	const json = (body: unknown, status = 200) => {
		context.status = status;
		context.set('Cache-Control', 'no-cache');
		context.body = body;
		return true;
	};

	if (rest === '') {
		context.redirect(`${context.path}/`);
		return true;
	}
	if (rest === '/api/span') {
		if (meta.firstTick < 0) {
			return json({ empty: true, layout: 'xrr', chunks: 0, rooms: 0 });
		}
		return json({
			empty: false,
			layout: 'xrr',
			firstTick: meta.firstTick,
			lastTick: meta.lastTick,
			capturedTick: meta.lastTick,
			...totals(),
			contributors: [],
			hasTerrain: true,
		});
	}
	if (rest === '/archive/status') {
		const ticks = Math.max(1, meta.lastTick - meta.firstTick);
		const updated = meta.updated ?? meta.created;
		return json({
			shard: meta.shard,
			empty: meta.firstTick < 0,
			...totals(),
			firstTick: meta.firstTick,
			lastTick: meta.lastTick,
			newestAt: updated,
			msPerTick: Math.max(1, Math.round((updated - meta.created) / ticks)),
		});
	}
	if (rest === '/api/rooms') {
		return json(Object.entries(meta.rooms).map(([ room, info ]) => ({ room, chunks: info.chunks })));
	}
	if (rest === '/archive/index.json') {
		const coverage: Record<string, [ number, number ]> = {};
		for (const [ room, info ] of Object.entries(meta.rooms)) {
			coverage[room] = [ Math.floor(info.firstTick / WINDOW) * WINDOW, Math.floor(info.lastTick / WINDOW) * WINDOW ];
		}
		return json({ shard: meta.shard, ...totals(), coverage });
	}
	const roomIndex = /^\/archive\/([EW]\d+[NS]\d+)\/index\.json$/.exec(rest);
	if (roomIndex) {
		const room = roomIndex[1]!;
		if (!meta.rooms[room]) {
			return json({ room, count: 0, bases: [] });
		}
		const bases = windowsOf(recording, room);
		return json({ room, count: bases.length, bases });
	}
	const roomChunk = /^\/archive\/([EW]\d+[NS]\d+)\/(\d+)\.json$/.exec(rest);
	if (roomChunk) {
		const chunk = chunkFor(recording, roomChunk[1]!, Math.floor(Number(roomChunk[2]) / WINDOW) * WINDOW);
		return chunk ? json(chunk) : json({ error: 'no such chunk' }, 404);
	}
	if (rest === '/api/chunk') {
		const room = typeof context.query.room === 'string' ? context.query.room : '';
		const base = Number(context.query.base);
		if (!room || !Number.isFinite(base)) {
			return json({ error: 'room and base required' }, 400);
		}
		const chunk = chunkFor(recording, room, Math.floor(base / WINDOW) * WINDOW);
		return chunk ? json(chunk) : json({ error: 'no such chunk' }, 404);
	}
	if (rest === '/archive/batch') {
		const base = Math.floor(Number(context.query.base) / WINDOW) * WINDOW;
		const rooms = roomList(context.query.rooms, 64);
		if (!Number.isFinite(base) || rooms.length === 0) {
			return json({ error: 'base and rooms required' }, 400);
		}
		const out: Record<string, unknown> = {};
		for (const room of rooms) {
			const chunk = chunkFor(recording, room, base);
			if (chunk) {
				out[room] = chunk;
			}
		}
		return json({ base, rooms: out });
	}
	if (rest === '/archive/snapshot' || rest === '/api/state') {
		const tick = Number(context.query.tick);
		const lite = context.query.sketch === '1';
		const rooms = rest === '/api/state'
			? (typeof context.query.room === 'string' ? [ context.query.room ] : [])
			: roomList(context.query.rooms, 200);
		if (!Number.isFinite(tick) || rooms.length === 0) {
			return json({ error: 'tick and rooms required' }, 400);
		}
		const out: Record<string, unknown> = {};
		for (const room of rooms) {
			if (!meta.rooms[room]) {
				continue;
			}
			const frame = recording.frameAt(room, tick);
			if (!frame) {
				continue;
			}
			const objects: Record<string, unknown> = {};
			for (const [ id, object ] of frame.objects) {
				objects[id] = lite ? sketch(object) : object;
			}
			out[room] = objects;
		}
		if (rest === '/api/state') {
			const objects = out[rooms[0]!];
			return objects ? json({ room: rooms[0], tick, objects }) : json({ error: 'no capture for that room and tick' }, 404);
		}
		return json({ tick, rooms: out });
	}
	if (rest === '/api/activity' || rest === '/api/world') {
		const tick = Number(context.query.tick);
		if (!Number.isFinite(tick)) {
			return json({ error: 'tick required' }, 400);
		}
		const base = Math.floor(tick / WINDOW) * WINDOW;
		const rows = activityAt(recording, base);
		if (rest === '/api/world') {
			return json({ tick, base, max: rows[0]?.len ?? 0, rooms: rows });
		}
		const limit = Math.min(Number(context.query.limit) || 50, 5000);
		return json({ tick, rooms: rows.slice(0, limit) });
	}
	if (rest === '/api/bases') {
		const room = typeof context.query.room === 'string' ? context.query.room : '';
		return json({ room, bases: windowsOf(recording, room).map(base => ({ base, len: 0 })) });
	}
	if (rest === '/api/season') {
		const scan = ensureEvents(recording);
		if (scan) {
			// Answer now with what is known; the logs land once the scan is done
			void scan.catch(err => console.error('replay: event scan failed', err));
		}
		return json(seasonPayload(recording));
	}
	if (rest === '/api/metrics') {
		return json({ error: 'no standings in a recording' }, 503);
	}
	if (rest === '/archive/sample') {
		const room = recording.rooms()[0];
		const base = room ? windowsOf(recording, room)[0] : undefined;
		return json(room && base !== undefined ? { room, base } : {});
	}
	if (rest === '/terrain.bin' || rest === '/api/terrain') {
		let buffer = recording.terrainBin();
		if (!buffer && !recording.bundle && options.world && options.roomNames) {
			// An older directory recording: take the live world's terrain
			const file = path.join(recording.dir, 'terrain.bin');
			writeTerrainBin(file, options.world, options.roomNames);
			buffer = fs.readFileSync(file);
		}
		if (!buffer) {
			return json({ error: 'no terrain' }, 404);
		}
		context.status = 200;
		context.type = 'application/octet-stream';
		context.set('Cache-Control', 'no-cache');
		context.set('X-World-Dim', String(Math.round(Math.sqrt(buffer.length / BYTES_PER_ROOM))));
		context.body = buffer;
		return true;
	}
	if (rest === '/client-log') {
		return json({ ok: 1 });
	}
	const badge = /^\/badge\/([^/]+)\.svg$/.exec(rest);
	if (badge) {
		const id = decodeURIComponent(badge[1]!);
		const user = meta.users[id];
		const fromFile = user ? badgeSvgFromFile(options.badges, user.username) : undefined;
		if (fromFile !== undefined) {
			context.status = 200;
			context.type = 'image/svg+xml';
			context.set('Cache-Control', 'no-cache');
			context.body = fromFile;
			return true;
		}
		if (user && isCustomBadge(user.badge)) {
			context.status = 200;
			context.type = 'image/svg+xml';
			context.set('Cache-Control', 'public, max-age=3600');
			context.body = customBadgeSvg(user.badge);
			return true;
		}
		const username = user?.username ?? (id === INVADER ? 'Invader' : id);
		// Hand over to the live badge route (and its no-badge fallback)
		context.url = `/api/user/badge-svg?username=${encodeURIComponent(username)}`;
		return false;
	}

	// The page itself
	if (!options.dir) {
		context.status = 503;
		context.type = 'text/plain';
		context.body = 'replay: set `replay.viewer` to the shardreplay web directory to enable the world view';
		return true;
	}
	const relative = rest === '/' ? 'index.html' : rest.replace(/^\/+/, '');
	const file = path.resolve(options.dir, relative);
	if (!file.startsWith(path.resolve(options.dir))) {
		context.status = 403;
		return true;
	}
	try {
		const body = fs.readFileSync(file);
		context.status = 200;
		context.type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
		context.set('Cache-Control', 'no-cache');
		context.body = body;
	} catch {
		context.status = 404;
		context.type = 'text/plain';
		context.body = 'not found';
	}
	return true;
}
