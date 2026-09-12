// Reads the merged server config. Kept apart from config.ts, which the
// engine imports while assembling that very config (a cycle otherwise).
import config from 'xxscreeps/config/index.js';
import { defaults } from './config.js';
import type { Schema } from './config.js';
import type { Codec } from './recording.js';

export interface ReplayConfig {
	enabled: boolean;
	dir: string;
	name: string | undefined;
	chunkTicks: number;
	historyChunkSize: number;
	codec: Codec;
	level: number | undefined;
	rooms: string[] | undefined;
	users: string[] | undefined;
	asUser: string | undefined;
	log: boolean;
	/** The shardreplay `web` directory that serves as the world view. */
	viewer: string | undefined;
	/** Directory of `<username>.json` / `<username>.svg` badge files. */
	badges: string;
}

export function replayConfig(): ReplayConfig {
	const raw = { ...defaults.replay, ...(config as { replay?: Schema['replay'] }).replay };
	const { env } = process;
	const enabled = env.XX_REPLAY === undefined ? raw.enabled !== false : !/^(0|false|no|off)$/i.test(env.XX_REPLAY);
	const chunkTicks = Math.max(1, Math.floor(raw.chunkTicks ?? 200));
	let historyChunkSize = Math.max(1, Math.floor(raw.historyChunkSize ?? 100));
	if (chunkTicks % historyChunkSize !== 0) {
		console.warn(`replay: chunkTicks (${chunkTicks}) is not a multiple of historyChunkSize (${historyChunkSize}); history windows will span chunks`);
	}
	if (historyChunkSize > chunkTicks) {
		historyChunkSize = chunkTicks;
	}
	return {
		enabled,
		dir: env.XX_REPLAY_DIR ?? raw.dir ?? './replays',
		name: env.XX_REPLAY_NAME ?? raw.name,
		chunkTicks,
		historyChunkSize,
		codec: raw.codec ?? 'zstd',
		level: raw.level,
		rooms: raw.rooms,
		users: raw.users,
		asUser: raw.asUser,
		log: raw.log !== false,
		viewer: env.XX_REPLAY_VIEWER ?? raw.viewer,
		badges: env.XX_REPLAY_BADGES ?? raw.badges ?? './badges',
	};
}
