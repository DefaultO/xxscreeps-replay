#!/usr/bin/env node
// Measures a real recording and draws the charts in docs/.
//
//   node scripts/bench.mjs REC [--out docs]
//   node scripts/bench.mjs --charts-only [--out docs]   redraw from docs/bench.json
//
// Two questions, answered from the same recording:
//
//  1. codecs - the same chunks stored with brotli, zstd or nothing, at two
//     levels each: bytes on disk, time to encode, time to decode.
//  2. formats - what the same ticks cost as the JSON screeps.com's history
//     API serves (the first tick whole, then diffs), raw and gzipped as it
//     travels, and as the full room state per tick the room socket sends,
//     against the .xrr file.
//
// Writes bench.json and two SVG bar charts (transparent background).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Recording, CODECS, compress, decompress } from '../dist/recording.js';

const args = process.argv.slice(2);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'docs';
const chartsOnly = args.includes('--charts-only');
const target = args.find(arg => !arg.startsWith('--') && arg !== outDir);
if (!target && !chartsOnly) {
	console.error('usage: node scripts/bench.mjs REC [--out docs] | --charts-only');
	process.exit(1);
}
const WINDOW = 100;
const now = () => performance.now();

function measure(recording) {
	const { meta } = recording;
	const rooms = recording.rooms();

	// ---- 1. codecs ---------------------------------------------------------
	const codecs = [
		{ name: 'brotli 5 (default)', codec: 'brotli', level: 5 },
		{ name: 'brotli 11', codec: 'brotli', level: 11 },
		{ name: 'zstd 19', codec: 'zstd', level: 19 },
		{ name: 'zstd 3', codec: 'zstd', level: 3 },
		{ name: 'none', codec: 'none' },
	];
	const codecTotals = codecs.map(() => ({ bytes: 0, encodeMs: 0, decodeMs: 0 }));
	let rawBytes = 0;
	let frames = 0;
	let storedBytes = 0;
	for (const room of rooms) {
		for (const record of recording.index(room)) {
			const raw = recording.readChunk(room, record);
			rawBytes += raw.length;
			frames += record.frames;
			storedBytes += record.length + 28;
			codecs.forEach((entry, index) => {
				const t0 = now();
				const packed = compress(raw, entry.codec, entry.level);
				const t1 = now();
				decompress(packed, CODECS[entry.codec]);
				const t2 = now();
				codecTotals[index].bytes += packed.length;
				codecTotals[index].encodeMs += t1 - t0;
				codecTotals[index].decodeMs += t2 - t1;
			});
		}
		console.error(`codecs: ${room} done`);
	}

	// ---- 2. formats --------------------------------------------------------
	let fullJson = 0;        // every tick as the full room state
	let historyJson = 0;     // the official 100-tick chunk shape
	let historyGzip = 0;     // the same, gzipped as it is served and archived
	let windows = 0;
	for (const room of rooms) {
		const info = meta.rooms[room];
		const firstBase = Math.floor(info.firstTick / WINDOW) * WINDOW;
		const lastBase = Math.floor(info.lastTick / WINDOW) * WINDOW;
		for (let base = firstBase; base <= lastBase; base += WINDOW) {
			const chunk = recording.history(room, base, WINDOW);
			if (!chunk || Object.values(chunk.ticks).every(tick => tick === null)) {
				continue;
			}
			const json = Buffer.from(JSON.stringify(chunk));
			historyJson += json.length;
			historyGzip += zlib.gzipSync(json, { level: 6 }).length;
			windows++;
		}
		const firstChunk = recording.chunkIndexOf(info.firstTick);
		const lastChunk = recording.chunkIndexOf(info.lastTick);
		for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex++) {
			for (const frame of recording.chunkFrames(room, chunkIndex)) {
				fullJson += Buffer.byteLength(JSON.stringify(Object.fromEntries(frame.objects)));
			}
		}
		console.error(`formats: ${room} done`);
	}

	const perTick = value => value / frames;
	return {
		recording: recording.name,
		rooms: rooms.length,
		frames,
		ticks: meta.lastTick - meta.firstTick + 1,
		node: process.version,
		codecs: codecs.map((entry, index) => ({
			name: entry.name,
			bytes: codecTotals[index].bytes,
			bytesPerFrame: perTick(codecTotals[index].bytes),
			encodeMs: Math.round(codecTotals[index].encodeMs),
			decodeMs: Math.round(codecTotals[index].decodeMs),
		})),
		rawChunkBytes: rawBytes,
		formats: [
			{ name: 'room socket JSON, every tick', bytes: fullJson },
			{ name: 'room-history JSON (screeps.com API)', bytes: historyJson },
			{ name: 'room-history JSON, gzipped (served, archived)', bytes: historyGzip },
			// The file as the default codec writes it, whatever this recording
			// was made with, so the two charts describe the same thing
			{ name: `.xrr, ${codecs[0].codec} ${codecs[0].level}`, bytes: codecTotals[0].bytes },
		].map(entry => ({ ...entry, bytesPerFrame: perTick(entry.bytes) })),
		storedBytes,
		windows,
	};
}

// ---- charts ----------------------------------------------------------------
const fmt = value => value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB` : value >= 1e3 ? `${(value / 1e3).toFixed(0)} KB` : `${Math.round(value)} B`;
const secs = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const esc = text => text.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
const textWidth = text => text.length * 6.6;   // 13px sans, roughly

/** Horizontal bars on a transparent ground; greys that read on light and dark. */
function chart(title, rows, { highlight, log = false } = {}) {
	const left = Math.ceil(Math.max(...rows.map(row => textWidth(row.name))) + 20);
	const right = Math.ceil(Math.max(...rows.map(row => textWidth(row.label))) + 20);
	const span = 360;
	const width = left + span + right;
	const rowH = 34;
	const top = 44;
	const height = top + rows.length * rowH + 12;
	const max = Math.max(...rows.map(row => row.value));
	const min = Math.min(...rows.map(row => row.value));
	const scale = value => {
		if (!log) {
			return span * value / max;
		}
		const lo = Math.log10(Math.max(1, min / 3));
		const hi = Math.log10(max);
		return span * (Math.log10(Math.max(1, value)) - lo) / (hi - lo);
	};
	const bars = rows.map((row, index) => {
		const y = top + index * rowH;
		const w = Math.max(2, scale(row.value));
		const fill = row.name === highlight ? '#1f9d8c' : '#8b949e';
		return `<text x="${left - 12}" y="${y + 21}" text-anchor="end">${esc(row.name)}</text>` +
			`<rect x="${left}" y="${y + 8}" width="${w.toFixed(1)}" height="18" fill="${fill}" rx="1"/>` +
			`<text x="${(left + w + 8).toFixed(1)}" y="${y + 21}">${esc(row.label)}</text>`;
	}).join('\n');
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="13" fill="#8b949e">
<text x="${left}" y="24" font-size="14" font-weight="600">${esc(title)}</text>
${bars}
</svg>
`;
}

function draw(result) {
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, 'bench-codecs.svg'), chart(
		`Bytes per room-tick by codec, ${result.recording} (${result.frames.toLocaleString('en-US')} room-ticks)`,
		result.codecs.map(entry => ({
			name: entry.name,
			value: entry.bytesPerFrame,
			label: `${entry.bytesPerFrame.toFixed(1)} B, encode ${secs(entry.encodeMs)}, decode ${secs(entry.decodeMs)}`,
		})),
		{ highlight: result.codecs[0].name }));
	fs.writeFileSync(path.join(outDir, 'bench-format.svg'), chart(
		`Bytes per room-tick by format, ${result.recording} (log scale)`,
		result.formats.map(entry => ({
			name: entry.name,
			value: entry.bytesPerFrame,
			label: `${fmt(entry.bytesPerFrame)}, ${fmt(entry.bytes)} total`,
		})),
		{ highlight: result.formats[result.formats.length - 1].name, log: true }));
}

let result;
if (chartsOnly) {
	result = JSON.parse(fs.readFileSync(path.join(outDir, 'bench.json'), 'utf8'));
} else {
	const recording = Recording.open(path.resolve(target));
	if (!recording) {
		console.error(`no recording at ${target}`);
		process.exit(1);
	}
	result = measure(recording);
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, 'bench.json'), JSON.stringify(result, null, '\t'));
}
draw(result);
console.log(JSON.stringify(result, null, 1));
