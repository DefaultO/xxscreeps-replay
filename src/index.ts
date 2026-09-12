import type { Manifest } from 'xxscreeps/config/mods/index.js';

// Records the rooms players are in, every tick, to compact .xrr files and
// plays them back through the official client's history mode. Backend only:
// the recorder reads the same room blobs the room socket serves.
export const manifest: Manifest = {
	provides: [ 'backend', 'config' ],
};
