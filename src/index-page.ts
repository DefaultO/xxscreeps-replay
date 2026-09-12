// The /replay/ index, in the game client's own chrome: its navbar and
// logotype, the sidebar's panel blocks (#2d2d2d bodies under #3d3d3d
// headers with 10px uppercase titles), Arial, the #222→#111 page gradient,
// #428bca links, the teal (#009688) the client's slider uses for "on", and
// map tiles drawn from each room's recorded terrain with the level ring the
// world map puts on owned rooms. Values were read off the running client.

import type { Recording, RecordingMeta } from './recording.js';
import { parseRoomName } from './viewer.js';

export function historyUrl(recording: Recording, room: string, tick: number) {
	const { meta } = recording;
	return `/replay/${encodeURIComponent(meta.name)}/#!/history/${meta.shard}/${room}?t=${tick}&code=${encodeURIComponent(`${meta.name}~${room}`)}`;
}

export interface IndexOptions {
	/** The recording being written right now, if any. */
	live?: Recording | undefined;
	/** Whether the world view (shardreplay) is configured. */
	viewer: boolean;
}

const escape = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]!));
const num = (value: number) => value.toLocaleString('en-US');

function bytes(count: number) {
	if (count < 1024) {
		return `${count} B`;
	} else if (count < 1024 * 1024) {
		return `${(count / 1024).toFixed(1)} KB`;
	}
	return `${(count / 1024 / 1024).toFixed(2)} MB`;
}

function when(meta: RecordingMeta) {
	const date = new Date(meta.created);
	return `${date.toISOString().slice(0, 10)} ${date.toTimeString().slice(0, 5)}`;
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font:12px/1.5 Arial,sans-serif;color:#888;background:#111 linear-gradient(#222 0%,#111 100%) fixed}
a{color:#428bca;text-decoration:none}
a:hover{text-decoration:underline}
.navbar{height:40px;background:#191a1e;display:flex;align-items:center;gap:16px;padding:0 14px;border-bottom:1px solid #000}
.navbar a{display:flex;align-items:center;height:100%;line-height:0}
/* The logotype's letters fill the top three quarters of its box; the blinking
   cursor alone reaches the bottom. Centre the letters, not the box. */
.navbar img{height:22px;display:block;position:relative;top:2.5px}
.navbar .title{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#aaa}
.navbar .count{margin-left:auto;font-size:11px;color:#666}
main{max-width:1120px;margin:0 auto;padding:20px 16px 40px;display:grid;gap:18px}
.block{background:#2d2d2d;box-shadow:0 1px 2px #000}
.block-header{display:flex;align-items:center;gap:12px;height:34px;padding:0 12px;background:#3d3d3d;border-bottom:1px solid #222;font-size:10px;font-weight:700;letter-spacing:.1px;text-transform:uppercase;color:#aaa}
.block-header .name{color:#ddd;font-size:11px}
.block-header .live{color:#009688}
.block-header .live::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#009688;margin-right:5px;vertical-align:1px;animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
.block-header .when{margin-left:auto;font-weight:400;text-transform:none;color:#777;letter-spacing:0}
.block-body{display:flex;gap:22px;padding:14px 12px 16px;flex-wrap:wrap}
.map{display:grid;gap:2px;padding:2px;background:#111;align-self:flex-start}
.tile{position:relative;display:block;width:64px;height:64px;background:#171717;overflow:hidden}
.tile canvas{display:block;width:100%;height:100%}
.tile .rn{position:absolute;left:3px;top:1px;font-size:9px;font-weight:700;color:#bbb;text-shadow:0 0 2px #000,0 0 2px #000}
.tile .lvl{position:absolute;right:3px;bottom:3px;width:14px;height:14px;border-radius:50%;background:#009688;color:#fff;font-size:9px;font-weight:700;line-height:14px;text-align:center;box-shadow:0 0 0 1px #0b3f39}
.tile.owned{outline:1px solid #009688;outline-offset:-1px}
.tile:hover{outline:1px solid #ccc;outline-offset:-1px}
.tile.empty{background:#141414}
.info{flex:1 1 320px;display:flex;flex-direction:column;gap:10px;min-width:0}
.player{display:flex;align-items:center;gap:8px;font-size:14px}
.player img{width:22px;height:22px;border-radius:50%;background:#444}
.player .user{color:#428bca}
.facts{display:grid;grid-template-columns:auto 1fr;gap:2px 14px;font-size:12px}
.facts dt{color:#777;margin:0}
.facts dd{color:#ccc;margin:0}
.milestones{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px}
.milestones .m{display:inline-flex;align-items:center;gap:6px}
.milestones .ring{width:16px;height:16px;border-radius:50%;background:#009688;color:#fff;font-size:9px;font-weight:700;line-height:16px;text-align:center}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:6px}
.btn{display:inline-block;padding:7px 14px;border-radius:2px;background:#009688;color:#fff;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.btn:hover{text-decoration:none;background:#00a896}
.btn.alt{background:#444;color:#ccc}
.btn.alt:hover{background:#4d4d4d}
table.rooms{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px}
table.rooms th{font-size:10px;font-weight:700;text-transform:uppercase;color:#777;text-align:left;padding:4px 10px 4px 0;border-bottom:1px solid #222}
table.rooms td{padding:3px 10px 3px 0;color:#aaa;border-bottom:1px solid #262626;white-space:nowrap}
table.rooms td.n{color:#ccc}
.empty-note{padding:40px;text-align:center;color:#666}
`;

const SCRIPT = `
(function(){
var P=[[43,43,43],[14,14,14],[42,46,27],[14,14,14]];
var T=window.TERRAIN||{};
var tiles=document.querySelectorAll('canvas[data-rec]');
for(var i=0;i<tiles.length;i++){
	var c=tiles[i],s=(T[c.dataset.rec]||{})[c.dataset.room];
	if(!s||s.length<2500)continue;
	var g=c.getContext('2d'),img=g.createImageData(50,50),d=img.data;
	for(var t=0;t<2500;t++){var v=P[(s.charCodeAt(t)-48)&3]||P[0];d[t*4]=v[0];d[t*4+1]=v[1];d[t*4+2]=v[2];d[t*4+3]=255;}
	g.putImageData(img,0,0);
}
})();
`;

export function indexPage(recordings: Recording[], options: IndexOptions): string {
	const terrain: Record<string, Record<string, string>> = {};
	const blocks = recordings.map(recording => {
		const { meta } = recording;
		const rooms = Object.entries(meta.rooms);
		const players = Object.entries(meta.users);
		const total = rooms.reduce((sum, [ , info ]) => sum + info.bytes, 0);
		const frames = rooms.reduce((sum, [ , info ]) => sum + info.frames, 0);
		const live = options.live === recording;

		// The map: recorded rooms on their world coordinates
		const placed = rooms.map(([ room, info ]) => ({ room, info, pos: parseRoomName(room) })).filter(entry => entry.pos);
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const entry of placed) {
			minX = Math.min(minX, entry.pos!.wx);
			maxX = Math.max(maxX, entry.pos!.wx);
			minY = Math.min(minY, entry.pos!.wy);
			maxY = Math.max(maxY, entry.pos!.wy);
		}
		const cols = placed.length ? maxX - minX + 1 : 0;
		const rowsCount = placed.length ? maxY - minY + 1 : 0;
		terrain[meta.name] = {};
		const tiles: string[] = [];
		for (let y = 0; y < rowsCount; ++y) {
			for (let x = 0; x < cols; ++x) {
				const entry = placed.find(candidate => candidate.pos!.wx === minX + x && candidate.pos!.wy === minY + y);
				if (!entry) {
					tiles.push('<span class="tile empty"></span>');
					continue;
				}
				if (entry.info.terrain) {
					terrain[meta.name]![entry.room] = entry.info.terrain;
				}
				const controller = entry.info.controller;
				const owned = !!controller?.user && !!meta.users[controller.user];
				tiles.push(`<a class="tile${owned ? ' owned' : ''}" href="${historyUrl(recording, entry.room, entry.info.firstTick)}" title="${entry.room}: ticks ${num(entry.info.firstTick)}–${num(entry.info.lastTick)}">` +
					`<canvas width="50" height="50" data-rec="${escape(meta.name)}" data-room="${entry.room}"></canvas>` +
					`<span class="rn">${entry.room}</span>` +
					(owned && controller!.level > 0 ? `<span class="lvl">${controller!.level}</span>` : '') +
					'</a>');
			}
		}
		const map = cols ? `<div class="map" style="grid-template-columns:repeat(${cols},64px)">${tiles.join('')}</div>` : '';

		// Controller levels reached, as jumps to the moment each one landed
		const milestones = (meta.events ?? [])
			.filter(event => event.kind === 'level')
			.sort((left, right) => left.tick - right.tick)
			.map(event => event.kind === 'level'
				? `<a class="m" href="${historyUrl(recording, event.room, Math.max(meta.rooms[event.room]?.firstTick ?? 0, event.tick - 5))}" title="${event.room}"><span class="ring">${event.level}</span>t${num(event.tick)}</a>`
				: '')
			.join('');

		const player = players.length
			? players.map(([ id, user ]) =>
				`<span class="player"><img src="/replay/${encodeURIComponent(meta.name)}/api/user/badge-svg?username=${encodeURIComponent(user.username)}" alt="">` +
				`<a class="user" href="${historyUrl(recording, mainRoom(meta, id), meta.rooms[mainRoom(meta, id)]?.firstTick ?? meta.firstTick)}">${escape(user.username)}</a></span>`).join('')
			: '<span class="player">no players</span>';

		const home = mainRoom(meta);
		const actions = [
			options.viewer ? `<a class="btn" href="/replay/${encodeURIComponent(meta.name)}/map/">World map</a>` : '',
			home ? `<a class="btn alt" href="${historyUrl(recording, home, meta.rooms[home]!.firstTick)}">Room ${home}</a>` : '',
		].join('');

		const roomRows = rooms
			.sort((left, right) => right[1].frames - left[1].frames)
			.map(([ room, info ]) => `<tr><td class="n"><a href="${historyUrl(recording, room, info.firstTick)}">${room}</a></td><td>${num(info.firstTick)}–${num(info.lastTick)}</td><td>${num(info.frames)}</td><td>${bytes(info.bytes)}</td></tr>`)
			.join('');

		return `<section class="block">
<div class="block-header"><span class="name">${escape(meta.name)}</span><span>${escape(meta.shard)}</span>${live ? '<span class="live">recording</span>' : ''}<span class="when">${when(meta)}</span></div>
<div class="block-body">
${map}
<div class="info">
${player}
<dl class="facts"><dt>Ticks</dt><dd>${num(meta.firstTick)} – ${num(meta.lastTick)}</dd><dt>Rooms</dt><dd>${rooms.length}, ${num(frames)} frames</dd><dt>Size</dt><dd>${bytes(total)}</dd></dl>
${milestones ? `<div class="milestones">${milestones}</div>` : ''}
<div class="actions">${actions}</div>
</div>
<table class="rooms"><thead><tr><th>Room</th><th>Ticks</th><th>Frames</th><th>Size</th></tr></thead><tbody>${roomRows}</tbody></table>
</div>
</section>`;
	}).join('');

	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Replays</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style></head>
<body>
<header class="navbar"><a href="/"><img src="/logotype.svg" alt="Screeps" onerror="this.remove()"></a><span class="title">Replays</span><span class="count">${recordings.length ? `${recordings.length} recording${recordings.length === 1 ? '' : 's'}` : ''}</span></header>
<main>
${blocks || '<div class="empty-note">Nothing recorded yet. Every run the replay mod sees is listed here.</div>'}
</main>
<script>window.TERRAIN=${JSON.stringify(terrain)};${SCRIPT}</script>
</body></html>`;
}

/** The room a recording is about: the owned one with the most frames. */
function mainRoom(meta: RecordingMeta, userId?: string): string {
	let best: string | undefined;
	let bestFrames = -1;
	for (const [ room, info ] of Object.entries(meta.rooms)) {
		const owner = info.controller?.user;
		const owned = userId ? owner === userId : !!owner && !!meta.users[owner];
		const score = (owned ? 1e9 : 0) + info.frames;
		if (score > bestFrames) {
			best = room;
			bestFrames = score;
		}
	}
	return best ?? '';
}
