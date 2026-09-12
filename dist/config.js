// The `config` provider: types and defaults the engine merges into the
// server config. No runtime imports here: the engine loads this file while
// building `xxscreeps/config`, so importing that back would be a cycle. Read
// the merged values through settings.ts.
//
// `.screepsrc.yaml`:
//
//   replay:
//     enabled: true          # record at all
//     dir: ./replays         # one sub-directory per recording
//     name: run-42           # recording name (default: the start time)
//     chunkTicks: 200        # ticks per stored chunk; keyframe every chunk
//     historyChunkSize: 100  # ticks per room-history request; divides chunkTicks
//     codec: zstd            # zstd | brotli | none
//     level: 19              # codec level
//     rooms: [W7N3]          # fixed room list (default: every room a player is in)
//     users: [hivemind]      # players (ids or usernames) whose presence picks the rooms
//                            # (default: every player, the stock NPC bots included)
//     asUser: abc123         # render as this user (private says); default: the only player
//     log: true              # a progress line every 1000 ticks
//     viewer: ../shardreplay/web   # shardreplay's page, served as the world view at /replay/<name>/map/
//
// Environment overrides, for launchers: XX_REPLAY=0 disables recording,
// XX_REPLAY_NAME, XX_REPLAY_DIR and XX_REPLAY_VIEWER set the name, the
// directory and the viewer.
export const defaults = {
    replay: {
        enabled: true,
        dir: './replays',
        chunkTicks: 200,
        historyChunkSize: 100,
        codec: 'zstd',
        log: true,
    },
};
//# sourceMappingURL=config.js.map