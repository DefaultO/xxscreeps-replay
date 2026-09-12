# The recording format

Everything is little-endian. Varints are unsigned LEB128 (7 bits a byte,
high bit set on every byte but the last), up to 2^53. Zigzag maps a signed
value to a varint: `v >= 0 ? 2v : -2v - 1`. Strings are a varint byte length
followed by UTF-8.

A recording is a directory, or the same entries packed into one bundle
file:

| entry | |
|---|---|
| `meta.json` | players, rooms, tick ranges, timeline events (below) |
| `terrain.bin` | the world's terrain (below) |
| `<room>.xrr` | one file per recorded room: a sequence of records |

## Records

A room file (`<room>.xrr`) has no header of its own. It is a sequence of
records, each one a compressed chunk behind a 28-byte header, and it only
ever grows: the recorder appends a record every `chunkTicks` ticks and
never rewrites what is there. A reader finds the records by reading a
header, skipping the payload it describes, and repeating.

| offset | size | field | |
|---|---|---|---|
| 0 | 4 | magic | the ASCII bytes `XRRC` |
| 4 | 1 | record version | 1 |
| 5 | 1 | codec | 0 none, 1 zstd, 2 brotli |
| 6 | 2 | reserved | 0 |
| 8 | 4 | first tick | of the chunk inside |
| 12 | 4 | last tick | |
| 16 | 4 | frames | how many ticks the chunk holds |
| 20 | 4 | raw length | the chunk's size before compression |
| 24 | 4 | payload length | the chunk's size after compression |
| 28 | payload length | payload | the chunk, compressed with the codec |

All integers are little-endian. The next record starts at
`28 + payload length`.

The first record of `W7N3.xrr` in the recording the README shows:

```
58 52 52 43   magic XRRC
01            version 1
01            codec 1 = zstd
00 00         reserved
02 00 00 00   first tick 2
c7 00 00 00   last tick 199
c6 00 00 00   198 frames
e0 0b 00 00   3040 bytes before compression
08 04 00 00   1032 bytes of payload
```

So this record spans bytes 0 to 1059 and the next header is at 1060;
reading it gives ticks 200 to 399, 200 frames, 5332 raw bytes in 2082. The
first record has 198 frames rather than 200 because the room was picked
up at tick 2, when its spawn landed; chunks are aligned to absolute ticks,
not to when recording started.

The header repeats what the chunk knows about itself (ticks, frames) so a
reader can index a whole file, build a timeline and find the chunk for a
tick without decompressing anything. That is what the viewers do on every
request.

**Alignment.** Chunk `n` holds ticks `[n * chunkTicks, (n + 1) * chunkTicks)`
and nothing else; `chunkTicks` is in `meta.json` and is 200 unless
configured. Records are in tick order and never overlap. One span can hold
two records: when the recorder is asked to flush (before a shutdown) it
closes the open chunk early, and the ticks that follow in the same span
start a new chunk. Both records begin with a keyframe, so a reader
concatenates their frames and carries on. A tick with no frame in any
record was not recorded.

**A truncated tail.** If the recorder died while writing, the last header
describes a payload the file does not fully contain. `indexRecords` stops
there and ignores that record; everything before it is intact, because
each record is written in one `write` call after the chunk is complete in
memory.

## Chunks

A chunk is `frames` consecutive recorded ticks of one room, starting with
the whole room and continuing with what changed. Everything a reader needs
is inside it: the key and string tables come first, so a chunk can be
decoded on its own, without the ones before it.

### Numbers and strings

Three primitives make up everything below.

A **varint** is an unsigned integer in LEB128: seven bits a byte, low bits
first, the high bit set on every byte except the last.

```
100    → 64
200    → c8 01        (200 = 0b1_1001000: low 7 bits 1001000 = 0x48, with continuation 0xc8; then 1)
300    → ac 02
6000   → f0 2e
```

A **zigzag** varint carries a signed integer by folding the sign into the
low bit: `v >= 0 ? 2v : -2v - 1`, then varint. Small magnitudes stay small
either way.

```
 0 → 0 → 00
 1 → 2 → 02
-1 → 1 → 01
-10 → 19 → 13
 50 → 100 → 64
 3000 → 6000 → f0 2e
```

A **string** is a varint byte length followed by that many bytes of
UTF-8: `"x"` is `01 78`, `"store.energy"` is `0c` and twelve bytes.

### The header

```
varint  format version, 1
varint  first tick
varint  last tick
varint  frame count
varint  key count, then that many strings
varint  string count, then that many strings
frames, one after another
```

The **key table** lists every field path used anywhere in the chunk;
entries refer to fields by their index in it. The **string table** lists
every string value; values refer to strings by index. Both are written
last by the encoder and read first by the decoder: the encoder buffers the
frames while it collects keys and strings, then writes the tables ahead of
them. A creep's `x` changes thousands of times in a chunk and costs one
byte each time because the path `"x"` is written once.

### Objects and fields

Before encoding, every object is flattened to a list of `path → value`
pairs. Nested objects become dotted paths: `{store: {energy: 50}}` is one
field `store.energy = 50`. An object that is nested but empty (`store: {}`
on an empty creep) is kept as one field `store` with the empty-object
value, so the client gets its `store` back. Arrays are not flattened: a
creep's `body` is one field whose value is the whole array. The object's
`_id` is the key it is stored under in the frame, not a field.

Within a chunk, objects are numbered in the order they first appear,
starting at 0. A removed object keeps its number; it is not reused. Frames
refer to objects by number, and numbers in a frame are written as
ascending deltas, so a frame that touches objects 0, 1 and 7 writes
`0, 1, 6`.

### Frames

```
varint  tick delta         0 for the first frame, else ticks since the previous frame
varint  removed count      then that many object numbers, as ascending deltas
varint  added count        then that many new objects:
          string  id
          varint  field count
          entries            every one absolute (kind 1)
varint  changed count      then that many known objects:
          varint  object number, as a delta from the previous changed object
          varint  entry count
          entries
```

The first frame of a chunk is the keyframe: it has no removals or changes,
and every object of the room appears under "added". Ticks between two
frames' ticks were not recorded; the tick delta says how many.

### Entries

An entry is one field of one object. It starts with a varint **code**:

```
code = key * 4 + kind
```

`key` indexes the key table; `kind` says what follows:

| kind | | followed by |
|---|---|---|
| 0 | residual | a zigzag varint: the actual value minus the predicted one (below) |
| 1 | absolute | a value (below): the field is set to this |
| 2 | removed | nothing: the field no longer exists |

So `x` as key 1 gives codes 4 (residual), 5 (absolute), 6 (removed);
`energy` as key 5 gives 20, 21, 22.

### Values

An absolute value is one tag byte and then what the tag says:

| tag | | then |
|---|---|---|
| 0 | null | |
| 1 | false | |
| 2 | true | |
| 3 | integer | zigzag varint |
| 4 | float | 8 bytes, IEEE 754 double, little-endian |
| 5 | string | varint index into the string table |
| 6 | empty object | |
| 7 | array | varint length, then that many values |
| 8 | object | varint pair count, then pairs of (varint key string index, value) |

Integers are numbers with no fractional part and magnitude at most 2^48;
anything else numeric is a float. Objects and arrays nest: a creep's body
is tag 7, a length, then one tag-8 object per part with keys `type` and
`hits`, both taken from the string table.

### A chunk, byte by byte

A room with a creep and a source, recorded for five ticks. The creep walks
east one tile a tick and gets 50 energy on the third tick; the source is
harvested for 10 a tick; on the last tick the creep is gone. Built with
the encoder and read back with the decoder, 131 bytes in all:

```
off  bytes                 meaning
  0  01                    format version 1
  1  64                    first tick 100
  2  68                    last tick 104
  3  05                    5 frames
  4  06                    6 keys
  5  04 74 79 70 65        key 0 "type"
 10  01 78                 key 1 "x"
 12  01 79                 key 2 "y"
 14  0c 73 74 6f 72 65 2e 65 6e 65 72 67 79
                           key 3 "store.energy"
 27  04 6e 61 6d 65        key 4 "name"
 32  06 65 6e 65 72 67 79  key 5 "energy"
 39  03                    3 strings
 40  05 63 72 65 65 70     string 0 "creep"
 46  02 77 31              string 1 "w1"
 49  06 73 6f 75 72 63 65  string 2 "source"

     frame 0, tick 100: the keyframe
 56  00                    tick delta 0
 57  00                    0 removed
 58  02                    2 added
 59  02 61 31              id "a1"                       → object 0
 62  05                    5 fields
 63  01 05 00              code 1 = key 0 type, absolute: tag 5 string 0 "creep"
 66  05 03 14              code 5 = key 1 x, absolute: tag 3 zigzag 20 → 10
 69  09 03 28              code 9 = key 2 y, absolute: 20
 72  0d 03 00              code 13 = key 3 store.energy, absolute: 0
 75  11 05 01              code 17 = key 4 name, absolute: string 1 "w1"
 78  02 62 32              id "b2"                       → object 1
 81  04                    4 fields
 82  01 05 02              type = "source"
 85  05 03 0a              x = 5
 88  09 03 0a              y = 5
 91  15 03 f0 2e           code 21 = key 5 energy, absolute: zigzag 6000 → 3000
 95  00                    0 changed

     frame 1, tick 101: x is 11, energy 2990; nothing has a trend yet
 96  01                    tick delta 1
 97  00                    0 removed
 98  00                    0 added
 99  02                    2 changed
100  00                    object 0 (delta 0)
101  01                    1 entry
102  04 02                 code 4 = key 1 x, residual: zigzag 2 → +1
104  01                    object 1 (delta 1)
105  01                    1 entry
106  14 13                 code 20 = key 5 energy, residual: zigzag 19 → -10

     frame 2, tick 102: x is 12, store.energy 50, energy 2980
108  01 00 00 02           tick delta 1, 0 removed, 0 added, 2 changed
112  00 02                 object 0, 2 entries
114  04 02                 x residual +1        (second equal delta: the trend is now confirmed)
116  0c 64                 store.energy residual: zigzag 100 → +50
118  01 01                 object 1, 1 entry
120  14 13                 energy residual -10  (likewise)

     frame 3, tick 103: x is 13, energy 2970, store.energy still 50
122  01 00 00 00           tick delta 1, nothing removed, added or changed

     frame 4, tick 104: the creep is gone
126  01                    tick delta 1
127  01                    1 removed
128  00                    object 0
129  00 00                 0 added, 0 changed
```

Frame 3 is the point of the format: both the walk and the harvest are
predicted exactly, `store.energy` stays where it was put, and a tick with
two objects costs four bytes. The keyframe is 40 bytes for two objects;
the tables, which every later frame draws on, are 52.

### Prediction

For every integer field of every object the decoder keeps three numbers:
the current value, the last delta `d1`, and the delta before it `d2`. Both
deltas start as "none".

Before a frame's entries are applied, every integer field gets a
**predicted** value:

```
predicted = (d1 == d2 and both known) ? value + d1 : value
```

That is: if the field moved by the same amount in the last two frames, it
is expected to move by that amount again; otherwise it is expected to stay.

Then the entries apply, and every integer field is updated, whether or
not it had an entry:

- no entry: `new = predicted`
- residual `r`: `new = predicted + r`
- absolute `v`: `new = v`, and both deltas are forgotten (set to "none")

and after that, for the no-entry and residual cases:
`d2 = d1`, `d1 = new - old`.

The encoder keeps the same three numbers, computes the same prediction,
and writes a residual entry only when the actual value differs from it.
Since both sides update identically, the decoder ends every frame with
exactly the encoder's state. The rule that a field without an entry
follows its prediction is what makes a frame with no entries meaningful:
it says "everything moved as expected".

How the three common shapes of change cost:

A creep walking east, `x` over six ticks:

| tick | x | d1, d2 before | predicted | entry |
|---|---|---|---|---|
| 0 | 10 | none, none | keyframe | absolute 10 |
| 1 | 11 | none, none | 10 | residual +1 |
| 2 | 12 | 1, none | 11 | residual +1 |
| 3 | 13 | 1, 1 | 13 | none |
| 4 | 14 | 1, 1 | 14 | none |
| 5 | 14 | 1, 1 | 15 | residual -1 (it stopped) |
| 6 | 14 | 0, 1 | 14 | none |

Two entries to establish a trend, one to break it, nothing in between. A
countdown (`ticksToLive`, a decaying structure's timer) is the same table
with -1, and costs nothing for the whole life of the creep once two ticks
are in. A source under a steady harvest (`energy` 3000, 2990, 2980, ...)
likewise: two entries, then free until the harvester leaves or the source
regenerates, each of which is one residual.

A one-off change, a creep receiving 50 energy once:

| tick | store.energy | d1, d2 before | predicted | entry |
|---|---|---|---|---|
| 1 | 0 | none, none | 0 | none |
| 2 | 50 | 0, none | 0 | residual +50 |
| 3 | 50 | 50, 0 | 50 | none |
| 4 | 50 | 0, 50 | 50 | none |

One entry. The deltas 50 and 0 never agree, so no false trend appears;
the field is predicted to hold, which it does.

Why the decoder must touch every integer field every frame even when the
frame has no entries: a field in a trend keeps moving on its own, and a
decoder that only applied entries would leave a walking creep standing
still. The cost is a loop over all fields per frame, which for a room of a
hundred objects is a few thousand additions.

Non-integer fields (strings, booleans, floats, arrays, objects) have no
prediction. They are written as absolute entries when they change and are
left alone otherwise. An integer field that becomes something else, or the
reverse, goes through an absolute entry, which resets the deltas.

### Reading a chunk

```
read the header and both tables
state = empty map of object number → (id, fields)
for each frame:
    tick += delta (or tick = first tick)
    remove the listed objects
    for each added object: number it, read its fields as absolute values
    for each changed object: apply its entries, remembering which fields were touched
    for every integer field of every object not touched in this frame:
        value = predicted; d2 = d1; d1 = delta just applied
    emit (tick, state) - unflatten each object's fields, put `_id` back
```

`ChunkDecoder` in `format.ts` is that loop; `historyTicks` turns its frames
into the client's 100-tick chunk shape, diffing consecutive states.

## Bundles

A bundle is a recording directory in one file, for sharing. It is a
container and nothing else: the entries are the directory's files byte for
byte, in a fixed order, each behind a small header. The room entries are
already compressed record by record, so the bundle applies no compression
of its own and gains nothing from being zipped.

```
4 bytes   magic, the ASCII bytes XRRB
1 byte    bundle version, 1
entries, each:
  1 byte   name length
  bytes    name, UTF-8
  8 bytes  entry length, unsigned 64-bit little-endian
  bytes    the entry
```

The first 40 bytes of the bundle made from the README's recording:

```
58 52 52 42            magic XRRB
01                     version 1
09                     name length 9
6d 65 74 61 2e 6a 73 6f 6e
                       "meta.json"
17 66 00 00 00 00 00 00
                       length 0x6617 = 26,135 bytes
7b 0a 09 22 76 65 72 73 69 6f 6e 22 3a 20 31 2c 0a ...
                       the entry: {\n\t"version": 1,\n ...
```

After 26,135 bytes of JSON comes the next name length, `0b`, then
`terrain.bin`, its length (360,000), the file, and so on for every room.

Entries are in the order `meta.json`, `terrain.bin` (if the recording has
one), then the rooms in the order `meta.json` lists them. A reader should
not depend on the order beyond the first: it walks the headers, records
where each entry starts and how long it is, and looks entries up by name.
There is no index at the end because a walk over a few dozen headers is
instant and an end-of-file index would break the one property worth
keeping, that a bundle can be produced by streaming a directory once.

**Reading a room from a bundle.** The entry `W7N3.xrr` starts at some
offset `o` and is `n` bytes long. Those `n` bytes are a room file exactly
as described under Records, so the record walk runs from `o` to `o + n`
instead of from 0 to the end of the file, and the record offsets it yields
are absolute positions in the bundle. Nothing else changes; `Recording`
opens a directory and a bundle the same way and the viewers do not know
which they have.

Names are ASCII letters, digits, `_`, `-` and `.`; a reader ignores an
entry with any other name, so a bundle cannot make an unpacker write
outside its directory. An entry length is 64-bit so a room file of any
size fits, though a real one is a few megabytes.

A bundle is read-only. To change a recording, unpack it; to share one
again, pack it. `packRecording` and `unpackRecording` in `recording.ts`
are short: a header, then the files copied through in order.

## terrain.bin

The terrain of the whole world in one file, written once when a recording
starts. Objects change every tick and are recorded; terrain never changes,
so it is stored exactly once, for every room of the world, not only the
recorded ones. The layout is the one the shardreplay viewer reads, which
is why it has no header of its own: the file is nothing but room blocks in
a fixed order, and everything about it follows from its size.

### What a tile is

Screeps terrain has three states per tile, and the game encodes them as
two flag bits: `TERRAIN_MASK_WALL = 1`, `TERRAIN_MASK_SWAMP = 2`. Both set
is legal and rare; the client draws it as wall. So a tile is a value 0 to 3
and fits in two bits:

| value | bits | |
|---|---|---|
| 0 | `00` | plain |
| 1 | `01` | wall |
| 2 | `10` | swamp |
| 3 | `11` | wall and swamp, drawn as wall |

This is the same numbering the client's `room-terrain` API uses, where a
room is a string of 2500 characters `'0'`..`'3'`. A room block here is that
string, packed.

### A room block: 625 bytes

A room is 50 by 50 tiles. Tiles are numbered in row-major order, the way
the API string is written: `index = y * 50 + x`, so index 0 is the top-left
tile `(0, 0)`, index 49 is `(49, 0)` at the end of the first row, index 50
is `(0, 1)`, and index 2499 is `(49, 49)`.

Four tiles share a byte, two bits each, the lowest-numbered tile in the
low bits:

```
byte = index >> 2          (index / 4, rounded down)
shift = (index & 3) * 2    (0, 2, 4 or 6)
value = (block[byte] >> shift) & 3
```

Worked example. The first four tiles of a room are plain, wall, swamp,
plain: values 0, 1, 2, 0.

```
tile 0 → bits 0-1 → 00
tile 1 → bits 2-3 → 01
tile 2 → bits 4-5 → 10
tile 3 → bits 6-7 → 00

byte 0 = 0b 00 10 01 00 = 0x24 = 36
              ^  ^  ^  ^
              t3 t2 t1 t0
```

Reading it back: `(0x24 >> 0) & 3 = 0`, `(0x24 >> 2) & 3 = 1`,
`(0x24 >> 4) & 3 = 2`, `(0x24 >> 6) & 3 = 0`.

2500 tiles at four a byte is exactly 625 bytes, no padding. A byte of
`0x55` is `01 01 01 01`: four walls. A room block of 625 `0x55` bytes is a
room that is all wall, which is how rooms the world does not have are
written; the viewer draws them as the void beyond the map.

### Where a room sits in the file

Room names map to world coordinates the way the game does it, with the
origin between the four central rooms:

```
W0 → wx = -1        E0 → wx = 0
W1 → wx = -2        E1 → wx = 1
N0 → wy = -1        S0 → wy = 0
N1 → wy = -2        S1 → wy = 1
```

So `W7N3` is `(wx, wy) = (-8, -4)`, `E0S0` is `(0, 0)`, `W0N0` is
`(-1, -1)`.

The file is a square grid of `dim` by `dim` room blocks, laid out row by
row like the tiles inside a room: the block for grid row `r`, column `c`
starts at byte `(r * dim + c) * 625`. The grid is centred on the origin,
so its top-left room has `wx = wy = tl` with

```
tl = -floor(dim / 2)
```

and a room `(wx, wy)` is at grid row `wy - tl`, column `wx - tl`:

```
offset = ((wy - tl) * dim + (wx - tl)) * 625
```

`dim` is even (see below), so `tl = -dim / 2` and the grid covers
`wx, wy` from `-dim/2` to `dim/2 - 1` inclusive: one more room on the
west and north than on the east and south, which is what a world named
this way looks like.

`dim` is not stored. The file's size is `dim * dim * 625`, so

```
dim = sqrt(size / 625)
```

and a file whose size is not 625 times a square is not a terrain.bin.

Worked example, from the recording in the README. Its file is 360,000
bytes: `360000 / 625 = 576 = 24 * 24`, so `dim = 24` and `tl = -12`. The
grid holds `wx` and `wy` from -12 to 11, that is rooms `W11`..`E11` and
`N11`..`S11`. `W7N3` is `(-8, -4)`:

```
row    = wy - tl = -4 - (-12) = 8
column = wx - tl = -8 - (-12) = 4
offset = (8 * 24 + 4) * 625 = 196 * 625 = 122,500
```

Its block is bytes 122,500 to 123,124. The source at `(41, 3)` in that
room is tile index `3 * 50 + 41 = 191`, byte `191 >> 2 = 47` of the block,
shift `(191 & 3) * 2 = 6`: `(file[122547] >> 6) & 3`.

### How the writer picks dim

The recorder asks the world for its room list and takes the largest
absolute coordinate it sees, plus one, as the reach:

```
reach = max over rooms of max(|wx| + 1, |wy| + 1)
dim = 2 * reach
```

`|wx| + 1` rather than `|wx|` because a room at `wx = -11` needs a grid
whose `tl` is -11 or less; `2 * 11 = 22` gives `tl = -11` and fits, but
the reach counts the room itself, so it is 12 and the grid 24, one row
and column to spare. The world above is 11 by 11 rooms, `W0`..`W10` and
`N0`..`N10`, so `wx` and `wy` run from -11 to -1: `reach = 12`,
`dim = 24`, and 121 of the 576 blocks hold a room. Every block the world
has no room for is filled with `0x55` before the real rooms are written
over it.

The grid is always the smallest even square that fits; two recordings of
different worlds can therefore have different `dim`, and a reader must
derive it from the size every time rather than assume one.

### Reading it

A complete decoder, one room to the API's string form:

```js
const BYTES_PER_ROOM = 625;

function parseRoomName(name) {
  const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  if (!m) return null;
  return {
    wx: m[1] === 'W' ? -Number(m[2]) - 1 : Number(m[2]),
    wy: m[3] === 'N' ? -Number(m[4]) - 1 : Number(m[4]),
  };
}

function roomTerrain(file, name) {           // file: Uint8Array of terrain.bin
  const dim = Math.round(Math.sqrt(file.length / BYTES_PER_ROOM));
  if (dim * dim * BYTES_PER_ROOM !== file.length) throw new Error('not a terrain.bin');
  const pos = parseRoomName(name);
  const tl = -Math.floor(dim / 2);
  if (!pos || pos.wx < tl || pos.wy < tl || pos.wx >= tl + dim || pos.wy >= tl + dim) {
    return null;                             // outside the grid: unknown
  }
  const offset = ((pos.wy - tl) * dim + (pos.wx - tl)) * BYTES_PER_ROOM;
  let out = '';
  for (let index = 0; index < 2500; index++) {
    out += (file[offset + (index >> 2)] >> ((index & 3) * 2)) & 3;
  }
  return out;                                // 2500 characters, '0'..'3', row-major
}
```

A room inside the grid that the world never had decodes to 2500 `'1'`s.
A room outside the grid cannot be told from one that was never there, so
the decoder says unknown rather than wall.

Writing is the reverse: allocate `dim * dim * 625` bytes filled with
`0x55`, and for each room zero its block and OR each tile into place:

```js
block[index >> 2] |= (value & 3) << ((index & 3) * 2);
```

### Relation to the rest of the recording

`terrain.bin` is the only copy of the terrain in a recording. Both viewers
take room terrain from it: the client's history view through the replay
code's `terrain` field, the world map through `terrain.bin` itself. Early
recordings (before this file existed) carried a 2500-character string per
room in `meta.json`; readers still accept that and build the grid from
those strings, which then holds only the recorded rooms.

## meta.json

```jsonc
{
  "version": 1,
  "name": "rcl5",
  "shard": "shard0",
  "created": 1789219632646,      // ms since the epoch, recording start
  "updated": 1789220936408,      // last save
  "chunkTicks": 200,
  "codec": "zstd",               // the configured codec; each record says its own
  "firstTick": 1,
  "lastTick": 19201,
  "users": { "<id>": { "username": "DefaultO", "badge": { /* as the API returns it */ } } },
  "rooms": {
    "W7N3": { "firstTick": 2, "lastTick": 19201, "chunks": 97, "frames": 19200, "bytes": 1354112,
              "controller": { "user": "<id>", "level": 5 } }
  },
  "events": [                    // what the world view marks on its timeline
    { "kind": "level", "tick": 631, "room": "W7N3", "level": 2, "user": "<id>" },
    { "kind": "owner", "tick": 12, "room": "W7N4", "user": null },
    { "kind": "raid", "room": "W7N4", "from": 8104, "to": 8104, "users": ["2", "<id>"] }
  ]
}
```

`bytes` per room counts the room file's records including headers.
