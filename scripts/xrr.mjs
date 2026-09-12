#!/usr/bin/env node
// Inspect and repack recordings without a server. REC is a recording
// directory (holds meta.json) or a single-file bundle (.xrr).
//
//   xrr info    REC                  rooms, ticks, sizes, bytes per tick
//   xrr pack    DIR [FILE]           one bundle file from a directory (default DIR.xrr)
//   xrr unpack  FILE [DIR]           a directory from a bundle
//   xrr dump    REC ROOM TICK        the room at one tick, as client JSON
//   xrr history REC ROOM BASE [N]    a room-history window, as the client gets it
//   xrr verify  REC [ROOM]           decode everything, check tick order
//   xrr keys    REC ROOM [N]         which fields cost the delta entries
//   xrr recode  REC ROOM [CODEC]     size of every chunk under another codec
//
// Run with the same Node the server uses (22.15 or newer for zstd).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChunkDecoder } from '../dist/format.js';
import { Recording, compress, packRecording, unpackRecording } from '../dist/recording.js';

const [ command, target, ...args ] = process.argv.slice(2);

function usage() {
	const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
	console.log(source.split('\n').slice(1, 14).map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
	process.exit(1);
}

function open() {
	const recording = Recording.open(path.resolve(target));
	if (!recording) {
		console.error(`no recording at ${target}`);
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
		console.log(`${meta.name}  ${recording.bundle ? 'bundle' : 'directory'}  shard ${meta.shard}  ticks ${meta.firstTick}-${meta.lastTick}  chunks of ${meta.chunkTicks}  codec ${meta.codec}`);
		console.log(`players: ${Object.values(meta.users).map(user => user.username).join(', ') || '-'}`);
		let totalBytes = 0;
		let totalFrames = 0;
		let totalRaw = 0;
		const rows = Object.entries(meta.rooms).sort((left, right) => right[1].frames - left[1].frames);
		for (const [ room, info ] of rows) {
			const records = recording.index(room);
			const raw = records.reduce((sum, record) => sum + record.rawLength, 0);
			const onDisk = records.reduce((sum, record) => sum + record.length + 28, 0);
			totalBytes += onDisk;
			totalFrames += info.frames;
			totalRaw += raw;
			console.log(`${room.padEnd(8)} ticks ${String(info.firstTick).padStart(6)}-${String(info.lastTick).padEnd(6)} frames ${String(info.frames).padStart(6)}  chunks ${String(records.length).padStart(4)}  raw ${bytes(raw).padStart(10)}  disk ${bytes(onDisk).padStart(10)}  ${(onDisk / Math.max(1, info.frames)).toFixed(1).padStart(6)} B/tick`);
		}
		console.log(`total   frames ${totalFrames}  raw ${bytes(totalRaw)}  disk ${bytes(totalBytes)}  ${(totalBytes / Math.max(1, totalFrames)).toFixed(1)} B/frame  whole recording ${bytes(recording.size())}`);
		if (meta.lastTick > meta.firstTick) {
			const ticks = meta.lastTick - meta.firstTick + 1;
			console.log(`${(totalBytes / ticks).toFixed(1)} B per game tick across rooms; ${bytes(totalBytes / ticks * 20000)} per 20k ticks at this rate`);
		}
	},

	pack() {
		const dir = path.resolve(target);
		const file = path.resolve(args[0] ?? `${dir.replace(/[\\/]+$/, '')}.xrr`);
		const written = packRecording(dir, file);
		console.log(`${file}: ${bytes(written)}`);
	},

	unpack() {
		const file = path.resolve(target);
		const dir = path.resolve(args[0] ?? file.replace(/\.xrr$/i, ''));
		unpackRecording(file, dir);
		console.log(`unpacked to ${dir}`);
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
			let last = -1;
			let frames = 0;
			for (const record of recording.index(room)) {
				const decoder = new ChunkDecoder(recording.readChunk(room, record));
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
		const totals = new Map();
		let frames = 0;
		for (const record of recording.index(room)) {
			const decoder = new ChunkDecoder(recording.readChunk(room, record));
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
		let before = 0;
		let after = 0;
		let raw = 0;
		for (const record of recording.index(room)) {
			const chunk = recording.readChunk(room, record);
			raw += chunk.length;
			before += record.length;
			after += compress(chunk, codec).length;
		}
		console.log(`${room}: raw ${bytes(raw)}  stored ${bytes(before)}  ${codec} ${bytes(after)}`);
	},
};

if (!commands[command] || !target) {
	usage();
}
commands[command]();
