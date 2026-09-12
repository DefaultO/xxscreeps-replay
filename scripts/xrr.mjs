#!/usr/bin/env node
// Inspect .xrr recordings without a server.
//
//   xrr info DIR                    recording summary: rooms, ticks, sizes
//   xrr dump DIR ROOM TICK          the room at one tick, as client JSON
//   xrr history DIR ROOM BASE [N]   a room-history window, as the client gets it
//   xrr verify DIR [ROOM]           decode everything, check tick order
//   xrr keys DIR ROOM [N]           which fields cost the delta entries
//   xrr recode DIR ROOM [CODEC]     size of every chunk under another codec
//
// DIR is a recording directory (holds meta.json). Run with the same Node
// the server uses (Node 24: zstd).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChunkDecoder } from '../dist/format.js';
import { Recording, compress, indexRecords, readRecord } from '../dist/recording.js';

const [ command, dir, ...args ] = process.argv.slice(2);

function usage() {
	const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
	console.log(source.split('\n').slice(1, 12).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
	process.exit(1);
}

function open() {
	const recording = Recording.open(path.resolve(dir));
	if (!recording) {
		console.error(`no recording at ${dir}`);
		process.exit(1);
	}
	return recording;
}

function bytes(count) {
	return count < 1024 ? `${count} B` : count < 1024 * 1024 ? `${(count / 1024).toFixed(1)} KB` : `${(count / 1024 / 1024).toFixed(2)} MB`;
}

const commands = {
	info() {
		const recording = open();
		const { meta } = recording;
		console.log(`${meta.name}  shard ${meta.shard}  ticks ${meta.firstTick}-${meta.lastTick}  chunks of ${meta.chunkTicks}  codec ${meta.codec}`);
		console.log(`players: ${Object.values(meta.users).map(user => user.username).join(', ') || '-'}`);
		let totalBytes = 0;
		let totalFrames = 0;
		let totalRaw = 0;
		const rows = Object.entries(meta.rooms).sort((left, right) => right[1].frames - left[1].frames);
		for (const [ room, info ] of rows) {
			const records = indexRecords(recording.roomFile(room));
			const raw = records.reduce((sum, record) => sum + record.rawLength, 0);
			const onDisk = records.reduce((sum, record) => sum + record.length + 28, 0);
			totalBytes += onDisk;
			totalFrames += info.frames;
			totalRaw += raw;
			console.log(`${room.padEnd(8)} ticks ${String(info.firstTick).padStart(6)}-${String(info.lastTick).padEnd(6)} frames ${String(info.frames).padStart(6)}  chunks ${String(records.length).padStart(4)}  raw ${bytes(raw).padStart(10)}  disk ${bytes(onDisk).padStart(10)}  ${(onDisk / Math.max(1, info.frames)).toFixed(1).padStart(6)} B/tick`);
		}
		console.log(`total   frames ${totalFrames}  raw ${bytes(totalRaw)}  disk ${bytes(totalBytes)}  ${(totalBytes / Math.max(1, totalFrames)).toFixed(1)} B/frame`);
		if (meta.lastTick > meta.firstTick) {
			const ticks = meta.lastTick - meta.firstTick + 1;
			console.log(`${(totalBytes / ticks).toFixed(1)} B per game tick across rooms; ${bytes(totalBytes / ticks * 20000)} per 20k ticks at this rate`);
		}
	},

	dump() {
		const [ room, tick ] = args;
		const recording = open();
		const frame = recording.frameAt(room, Number(tick));
		if (!frame) {
			console.error('tick not recorded');
			process.exit(1);
		}
		console.log(JSON.stringify(Object.fromEntries(frame.objects), null, 1));
	},

	history() {
		const [ room, base, size ] = args;
		const recording = open();
		const chunk = recording.history(room, Number(base), Number(size ?? 100));
		if (!chunk) {
			console.error('room not recorded');
			process.exit(1);
		}
		console.log(JSON.stringify(chunk));
	},

	verify() {
		const [ only ] = args;
		const recording = open();
		let problems = 0;
		for (const room of recording.rooms()) {
			if (only && room !== only) {
				continue;
			}
			const file = recording.roomFile(room);
			let last = -1;
			let frames = 0;
			for (const record of indexRecords(file)) {
				const decoder = new ChunkDecoder(readRecord(file, record));
				for (let frame = decoder.next(); frame; frame = decoder.next()) {
					if (frame.tick <= last) {
						console.log(`${room}: tick ${frame.tick} after ${last}`);
						++problems;
					}
					last = frame.tick;
					++frames;
				}
				if (decoder.frameCount !== record.frames) {
					console.log(`${room}: record @${record.offset} says ${record.frames} frames, chunk says ${decoder.frameCount}`);
					++problems;
				}
			}
			console.log(`${room}: ${frames} frames, last tick ${last}`);
		}
		console.log(problems ? `${problems} problems` : 'ok');
		process.exit(problems ? 1 : 0);
	},

	keys() {
		const [ room, top = 30 ] = args;
		const recording = open();
		const file = recording.roomFile(room);
		const totals = new Map();
		let frames = 0;
		for (const record of indexRecords(file)) {
			const decoder = new ChunkDecoder(readRecord(file, record));
			while (decoder.next()) {
				++frames;
			}
			for (const [ key, count ] of decoder.stats) {
				totals.set(key, (totals.get(key) ?? 0) + count);
			}
		}
		const all = [ ...totals.values() ].reduce((sum, count) => sum + count, 0);
		console.log(`${room}: ${frames} frames, ${all} delta entries (${(all / Math.max(1, frames)).toFixed(1)} per frame)`);
		for (const [ key, count ] of [ ...totals ].sort((left, right) => right[1] - left[1]).slice(0, Number(top))) {
			console.log(`${String(count).padStart(8)}  ${(100 * count / all).toFixed(1).padStart(5)}%  ${key}`);
		}
	},

	recode() {
		const [ room, codec = 'brotli' ] = args;
		const recording = open();
		const file = recording.roomFile(room);
		let before = 0;
		let after = 0;
		let raw = 0;
		for (const record of indexRecords(file)) {
			const chunk = readRecord(file, record);
			raw += chunk.length;
			before += record.length;
			after += compress(chunk, codec).length;
		}
		console.log(`${room}: raw ${bytes(raw)}  stored ${bytes(before)}  ${codec} ${bytes(after)}`);
	},
};

if (!commands[command] || !dir) {
	usage();
}
commands[command]();
