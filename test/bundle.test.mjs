// Packs a small recording directory into a bundle, opens both, and checks
// that every frame, the terrain and the meta read the same.
//   node test/bundle.test.mjs
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChunkEncoder } from '../dist/format.js';
import { Recording, encodeRecord, packRecording, unpackRecording } from '../dist/recording.js';
import { roomFromTerrainBin, terrainBinFromStrings } from '../dist/terrain.js';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xrr-bundle-'));
const dir = path.join(work, 'run');
fs.mkdirSync(dir);

// A two-room recording: a few objects that move and count down
const rooms = [ 'W1N1', 'E2S3' ];
const terrain = Object.fromEntries(rooms.map((room, index) => [ room, Array.from({ length: 2500 }, (_, tile) => String((tile * (index + 3)) % 4)).join('') ]));
const meta = {
	version: 1, name: 'run', shard: 'shard0', created: Date.now(), chunkTicks: 50, codec: 'zstd',
	firstTick: 0, lastTick: 119, users: { abc: { username: 'Tester' } }, rooms: {}, events: [],
};
const expected = {};
for (const room of rooms) {
	const fd = fs.openSync(path.join(dir, `${room}.xrr`), 'a');
	let encoder;
	let chunkStart = -1;
	expected[room] = [];
	for (let tick = 0; tick < 120; tick++) {
		const objects = new Map();
		for (let ii = 0; ii < 5; ii++) {
			const id = `${room}-${ii}`;
			objects.set(id, { _id: id, type: 'creep', x: (ii * 7 + tick) % 50, y: (ii * 3 + Math.floor(tick / 2)) % 50, ageTime: 1500 - ii, store: tick % 10 === 0 ? {} : { energy: tick % 50 } });
		}
		expected[room].push({ tick, objects });
		const chunk = Math.floor(tick / meta.chunkTicks);
		if (chunk !== chunkStart) {
			if (encoder) {
				fs.writeSync(fd, encodeRecord(encoder.finish(), 'zstd', encoder.firstTick, encoder.lastTick, encoder.frameCount));
			}
			encoder = new ChunkEncoder();
			chunkStart = chunk;
		}
		encoder.addFrame(tick, objects);
	}
	fs.writeSync(fd, encodeRecord(encoder.finish(), 'zstd', encoder.firstTick, encoder.lastTick, encoder.frameCount));
	fs.closeSync(fd);
	meta.rooms[room] = { firstTick: 0, lastTick: 119, chunks: 3, frames: 120, bytes: fs.statSync(path.join(dir, `${room}.xrr`)).size, controller: { user: 'abc', level: 3 } };
}
fs.writeFileSync(path.join(dir, 'terrain.bin'), terrainBinFromStrings(rooms.map(room => ({ name: room, terrain: terrain[room] }))));
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));

const bundleFile = path.join(work, 'run.xrr');
const written = packRecording(dir, bundleFile);
assert.equal(written, fs.statSync(bundleFile).size);

const fromDir = Recording.open(dir);
const fromBundle = Recording.open(bundleFile);
assert.ok(fromDir && !fromDir.bundle, 'directory opens');
assert.ok(fromBundle && fromBundle.bundle, 'bundle opens');
assert.deepEqual(fromBundle.meta, fromDir.meta);
assert.deepEqual(fromBundle.rooms(), rooms);
for (const room of rooms) {
	assert.equal(fromBundle.terrain(room), terrain[room], `terrain ${room}`);
	assert.equal(fromDir.terrain(room), terrain[room]);
	assert.equal(fromBundle.index(room).length, 3, `records ${room}`);
	for (const { tick, objects } of expected[room]) {
		const a = fromDir.frameAt(room, tick);
		const b = fromBundle.frameAt(room, tick);
		assert.ok(a && b, `frame ${room}@${tick}`);
		assert.deepEqual(Object.fromEntries(b.objects), Object.fromEntries(a.objects));
		assert.deepEqual(Object.fromEntries(a.objects), Object.fromEntries(objects));
	}
	const window = fromBundle.history(room, 100, 20);
	assert.equal(Object.keys(window.ticks).length, 20);
	assert.notEqual(window.ticks[100], null);
}
// The grid is the smallest centred square holding both rooms (dim 8 here):
// a room inside it that the world lacks is wall, one beyond it is unknown
assert.equal(roomFromTerrainBin(fromBundle.terrainBin(), 'W3N3'), '1'.repeat(2500), 'a room the world lacks is wall');
assert.equal(roomFromTerrainBin(fromBundle.terrainBin(), 'W9N9'), undefined, 'a room beyond the grid is unknown');
assert.equal(fromBundle.size(), fs.statSync(bundleFile).size);

// Round trip back to a directory
const again = path.join(work, 'again');
unpackRecording(bundleFile, again);
for (const name of fs.readdirSync(dir)) {
	assert.ok(fs.readFileSync(path.join(again, name)).equals(fs.readFileSync(path.join(dir, name))), `${name} identical after unpack`);
}
assert.throws(() => fromBundle.saveMeta(), /bundle/);

fs.rmSync(work, { recursive: true, force: true });
console.log(`bundle ok: ${rooms.length} rooms, ${written} bytes packed, read identically from directory and bundle`);
