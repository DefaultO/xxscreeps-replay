// Round-trips a synthetic room through the chunk codec and reports sizes.
//   node test/format.test.mjs
import assert from 'node:assert/strict';
import { ChunkDecoder, ChunkEncoder, historyTicks } from '../dist/format.js';
import { compress } from '../dist/recording.js';

// A deterministic little economy: creeps walk, harvest, deliver, age.
function makeRoom() {
	let seed = 7;
	const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
	const objects = new Map();
	const structures = [
		[ 'spawn', 25, 25 ], [ 'controller', 40, 10 ], [ 'source', 5, 5 ], [ 'source', 44, 44 ],
		...Array.from({ length: 12 }, (_, ii) => [ 'extension', 20 + (ii % 6), 27 + Math.floor(ii / 6) ]),
		...Array.from({ length: 60 }, (_, ii) => [ 'road', 5 + ii % 40, 5 + Math.floor(ii / 2) ]),
	];
	const sid = ii => `s${ii.toString(16).padStart(23, '0')}`;
	structures.forEach(([ type, x, y ], ii) => {
		const id = sid(ii);
		const base = { _id: id, type, x, y, hits: 5000, hitsMax: 5000, user: '123456789abc' };
		if (type === 'source') {
			Object.assign(base, { energy: 3000, energyCapacity: 3000, nextRegenerationTime: 300 });
		} else if (type === 'controller') {
			Object.assign(base, { level: 2, progress: 0, downgradeTime: 10000, safeMode: null, safeModeAvailable: 0 });
		} else if (type === 'spawn') {
			Object.assign(base, { store: { energy: 300 }, storeCapacity: 300, name: 'Spawn1' });
		} else if (type === 'extension') {
			Object.assign(base, { store: { energy: 50 }, storeCapacity: 50 });
		}
		objects.set(id, base);
	});
	const creeps = [];
	const spawnCreep = (tick, ii) => {
		const id = `c${(tick * 100 + ii).toString(16).padStart(23, '0')}`;
		const work = 1 + Math.floor(random() * 3);
		const creep = {
			_id: id, type: 'creep', x: 25, y: 26, name: `w${tick}_${ii}`, user: '123456789abc',
			body: [
				...Array.from({ length: work }, () => ({ type: 'work', hits: 100 })),
				{ type: 'carry', hits: 100 }, { type: 'carry', hits: 100 },
				{ type: 'move', hits: 100 }, { type: 'move', hits: 100 },
			],
			hits: 100 * (work + 4), hitsMax: 100 * (work + 4), spawning: false, fatigue: 0,
			ageTime: tick + 1500, store: {}, storeCapacity: 100,
			actionLog: {},
		};
		creeps.push({ creep, dx: 0, dy: 0, phase: 'toSource', target: ii % 2 });
		objects.set(id, creep);
	};
	for (let ii = 0; ii < 24; ++ii) {
		spawnCreep(0, ii);
	}
	return {
		objects,
		tick(time) {
			// Structures
			const [ source0, source1 ] = [ objects.get(sid(2)), objects.get(sid(3)) ];
			const controller = objects.get(sid(1));
			for (const source of [ source0, source1 ]) {
				if (time % 300 === 0) {
					source.energy = 3000;
					source.nextRegenerationTime = time + 300;
				}
			}
			controller.progress += 10;
			if (time % 500 === 499) {
				controller.level += 1;
			}
			// Creeps
			for (const entry of creeps) {
				const { creep } = entry;
				creep.actionLog = {};
				if (creep.ageTime <= time) {
					objects.delete(creep._id);
					entry.dead = true;
					continue;
				}
				const source = entry.target === 0 ? source0 : source1;
				const dest = entry.phase === 'toSource' ? source : objects.get(sid(0));
				const dx = Math.sign(dest.x - creep.x);
				const dy = Math.sign(dest.y - creep.y);
				if (Math.abs(dest.x - creep.x) + Math.abs(dest.y - creep.y) <= 1) {
					if (entry.phase === 'toSource') {
						const amount = Math.min(source.energy, 2 * creep.body.filter(part => part.type === 'work').length, creep.storeCapacity - (creep.store.energy ?? 0));
						source.energy -= amount;
						creep.store.energy = (creep.store.energy ?? 0) + amount;
						creep.actionLog = { harvest: { x: source.x, y: source.y } };
						if (creep.store.energy >= creep.storeCapacity) {
							entry.phase = 'toSpawn';
						}
					} else {
						creep.actionLog = { transfer: { x: dest.x, y: dest.y } };
						delete creep.store.energy;
						entry.phase = 'toSource';
					}
				} else if (creep.fatigue > 0) {
					creep.fatigue = Math.max(0, creep.fatigue - 4);
				} else {
					creep.x += dx;
					creep.y += dy;
					creep.fatigue = random() < 0.3 ? 4 : 0;
				}
				if (random() < 0.002) {
					creep.body[0].hits = 0;
					creep.hits -= 100;
				}
			}
			for (let ii = creeps.length - 1; ii >= 0; --ii) {
				if (creeps[ii].dead) {
					creeps.splice(ii, 1);
				}
			}
			if (time % 60 === 0) {
				spawnCreep(time, 0);
			}
		},
	};
}

// Objects as the recorder would hand them over: deep copies keyed by id
function snapshot(objects) {
	return new Map([ ...objects ].map(([ id, object ]) => [ id, JSON.parse(JSON.stringify(object)) ]));
}

function canonical(value) {
	return JSON.stringify(value, (key, child) =>
		child && typeof child === 'object' && !Array.isArray(child)
			? Object.fromEntries(Object.entries(child).sort())
			: child);
}

const room = makeRoom();
const CHUNK = 200;
const TICKS = 1000;
const frames = [];
const chunks = [];
let encoder;
for (let tick = 0; tick < TICKS; ++tick) {
	room.tick(tick);
	const objects = snapshot(room.objects);
	frames.push({ tick, objects });
	if (tick % CHUNK === 0) {
		if (encoder) {
			chunks.push(encoder.finish());
		}
		encoder = new ChunkEncoder();
	}
	encoder.addFrame(tick, objects);
}
chunks.push(encoder.finish());

// Round trip
let ii = 0;
for (const chunk of chunks) {
	for (const frame of ChunkDecoder.all(chunk)) {
		const expected = frames[ii++];
		assert.equal(frame.tick, expected.tick);
		assert.equal(frame.objects.size, expected.objects.size, `object count at ${frame.tick}`);
		for (const [ id, object ] of expected.objects) {
			assert.equal(canonical(frame.objects.get(id)), canonical(object), `object ${id} at tick ${frame.tick}`);
		}
	}
}
assert.equal(ii, TICKS);

// History windows: rebuilding a tick from the window's entries must give the
// same room the client would show
function apply(state, entry) {
	for (const [ id, value ] of Object.entries(entry)) {
		if (value === null) {
			delete state[id];
		} else if (!(id in state)) {
			state[id] = JSON.parse(JSON.stringify(value));
		} else {
			merge(state[id], value);
		}
	}
}
function merge(target, patch) {
	for (const [ key, value ] of Object.entries(patch)) {
		if (value === null) {
			delete target[key];
		} else if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
			merge(target[key], value);
		} else {
			target[key] = value;
		}
	}
}
const window = historyTicks(ChunkDecoder.all(chunks[1]), 300, 100);
const state = {};
for (let tick = 300; tick < 400; ++tick) {
	assert.notEqual(window[tick], null, `tick ${tick} missing`);
	apply(state, window[tick]);
	for (const [ id, object ] of frames[tick].objects) {
		// Arrays come back as index-keyed objects after a diff, like the client sees them
		assert.equal(canonical(JSON.parse(JSON.stringify(state[id], (key, child) => Array.isArray(child) ? Object.fromEntries(child.map((element, index) => [ index, element ])) : child))),
			canonical(JSON.parse(JSON.stringify(object, (key, child) => Array.isArray(child) ? Object.fromEntries(child.map((element, index) => [ index, element ])) : child))),
			`history ${id} at ${tick}`);
	}
}

// Sizes
const raw = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
const json = frames.reduce((sum, frame) => sum + JSON.stringify(Object.fromEntries(frame.objects)).length, 0);
console.log(`round trip ok: ${TICKS} ticks, ${room.objects.size} objects at the end`);
console.log(`client JSON per tick: ${(json / TICKS).toFixed(0)} B; raw chunk bytes per tick: ${(raw / TICKS).toFixed(1)} B`);
for (const codec of [ 'zstd', 'brotli' ]) {
	const started = Date.now();
	const size = chunks.reduce((sum, chunk) => sum + compress(chunk, codec).length, 0);
	console.log(`${codec}: ${(size / TICKS).toFixed(1)} B per tick (${size} B total, ${Date.now() - started} ms)`);
}
