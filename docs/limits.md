# Limits on files from others

Mochi Maker opens files it did not make: art files, model folders, projects, templates, and what
an agent sends through the bridge or the MCP server. A small file can be crafted to make a reader
allocate gigabytes, by declaring a huge image or by compressing a lot of zeros into a few bytes.
So every reader checks what a file declares against caps before it allocates for it.

- **Too large:** a file past a cap is refused with `E_TOO_LARGE`, and the message says "too
  large", naming the file, its size and the cap. The file may be fine; Mochi Maker does not read
  it.
- **Damaged:** a file that breaks its own format is refused with another code (`E_ASSET_FORMAT`,
  `E_PROJECT_FORMAT` or `E_MODEL_IMPORT`), and the message says what is wrong. That includes data
  that inflates past the size its own header declares, which no genuine file does.

The caps are in `LIMITS` (`packages/core/src/limits.ts`). If a real file of yours passes one,
please say so in an issue.

## The caps

| What | Cap |
| --- | --- |
| One file read whole: a PSD, OpenRaster file, PNG, sound, template, project asset | 512 MiB |
| One image's width or height | 16,384 pixels |
| One image's pixels (width × height) | 2^27 (134,217,728; 512 MiB as RGBA) |
| Layers in one art file or PNG folder (groups included) | 2,000 |
| The pixels of all layers and masks of one art file, or of all of a model's textures | 2^28 (268,435,456; 1 GiB as RGBA) |
| A PNG's embedded color profile, inflated | 16 MiB |
| A model from others, in a folder or a zip: each file, all files, the number of files | 64 MiB, 256 MiB, 2,000 |
| A zipped project or a template: each entry, all entries, the number of entries | 256 MiB, 1 GiB, 50,000 |
| An OpenRaster file's zip: each entry, all entries, the number of entries | 256 MiB, 512 MiB, 4,000 |
| A project folder: each JSON file, all of them, the number of object files | 64 MiB, 512 MiB, 50,000 |
| A message to the bridge | 16 MiB |
| A message on the MCP server's standard input | 64 MiB |
| Art the MCP server sends to the editor through the bridge | what fits in one bridge message (about 12 MiB) |

The model folder's caps are the ones Mochi2D suggests for models from strangers.

## One rule: the same numbers on both sides

Mochi2D also caps what it reads: zip entries, what a model's textures declare, and files' own
sizes. Mochi Maker passes it the caps above, so the two can never disagree:

| Check | Who checks | With |
| --- | --- | --- |
| A file's or folder's size, before reading | Mochi Maker (it reads every file itself) | the caps above |
| A zip's entries (OpenRaster, projects, templates, model zips) | Mochi2D's zip reader | `archive`: the caps above |
| A picture Mochi Maker decodes (art, project images, a model's textures on import) | Mochi Maker, before decoding with fast-png or ag-psd | the image caps above |
| The textures of a model Mochi2D loads or renders (the editor's view, its renders, the template preview, the agent API's and the conformance pack's renders) | Mochi2D, from each texture's header | `textures`: what an export may hold (below) |

- **Models Mochi Maker builds** are checked against what an export may hold: pages of at most
  8,192 (the largest atlas), textures kept from an imported model at most 16,384 a side and 2^27
  pixels, and 2^30 pixels together, Mochi2D's default. All are within Mochi2D's defaults, and the
  export refuses a model past them, so every export loads with Mochi2D's defaults. An export past
  the caps above for models from others (more than 2^28 pixels of textures, a file over 64 MiB or
  256 MiB in all) is written with a warning: an app that loads models from others with these
  caps, Mochi Maker's import among them, may refuse it.
- **Mochi2D's `files` caps** are not passed: they apply to files Mochi2D reads from a folder, a
  URL or a pick, and Mochi Maker always hands it files it has already read within the caps above.
- **Formats:** Mochi Maker reads art as PSD, OpenRaster or PNG, and a model's textures as PNG. A
  picture in another format is refused by name ("is a JPEG image, not a PNG"); AVIF, HEIF, TIFF
  and JPEG XL are not texture formats models can use at all. Exports always write PNG textures.
- **A lying picture,** one whose data holds more or less than its header declares, is refused as
  damaged before it is decoded.

## Motion sounds

A project keeps motion sounds as WAV files: `sound.import` reads WAV only, and a model's import
leaves out any other sound, naming its format in the import report. The editor's view of the
person's own project plays compressed sounds too (`sounds: { compressed: true }`); a template's
preview, from others, plays WAV only. What Mochi2D warns about the shown model (a sound that
won't play, an optional file it skipped) goes to the message bar, each warning once.

## What each reader does

- **Zip archives** (OpenRaster files, zipped projects, templates) are read with Mochi2D's zip
  reader with the caps above (Mochi2D's `ArchiveLimits`). It inflates an entry only when it is
  read, counts the bytes really inflated, refuses an entry whose records declare more than a cap
  before inflating it, stops one that inflates past its declared size (damaged), and checks every
  entry's CRC-32 (damaged).
- **PNG** (fast-png): the header's size is checked against the image caps before decoding. The
  image data is then inflated once in small steps, counted and not kept: data that inflates past
  what the declared size holds is refused as damaged, before fast-png inflates it all at once. The
  color profile is counted the same way.
- **PSD** (ag-psd): the canvas size is checked from the file's header. A first pass reads the
  layers' records and keeps the channel data as stored, without decoding it: the number of
  layers, each layer's and mask's size and their total are checked, and every zip-compressed
  channel is inflated in small steps and counted against the size it is for. Only then are the
  pixels decoded.
- **OpenRaster:** the canvas and each layer PNG as above, the layers' total counted.
- **PNG folders:** the number of layers and each file's size before reading it; each PNG as
  above; the canvas.
- **Model folders:** every file is listed and its size summed before any is read; textures as
  PNG, their total counted. The `.moc3` is read by Mochi2D, which checks the file's framing
  against its length.
- **Project folders:** every project file is listed and its size summed before any is read;
  assets are read when they are used, each within its cap, and decoded as PNG.
- **The editor** checks a chosen or dropped file's size, or a chosen folder's files and sizes,
  before reading them. **The desktop app** does the same from the disk.
- **The bridge** closes a connection that sends a message past 16 MiB (WebSocket close code 1009)
  and goes on serving others.
- **The MCP server** drops a message past its cap as it arrives, without keeping it, and answers
  it with an error that says it is too large. Art it sends to the editor is checked by its files'
  sizes before any is read.

Where a file system cannot tell a file's size without reading it, the file is read and then
checked; the file system's own read bounds the memory then.

## How much memory a refusal takes

`packages/art/test/limits.test.ts` builds crafted files (a PNG whose data inflates to 1 GiB, a
PSD layer of 20,000 × 20,000 pixels, a zip entry that declares 1 GiB, sparse files of hundreds of
MiB, and more) and reads each in a fresh process, measuring how much its peak memory grows. Each
is refused within a few MiB. For comparison, the test also decodes a PNG whose data inflates to
256 MiB with fast-png alone, which takes about 700 MiB.

Within the caps, memory is bounded by them: an art file's decoded layers take at most about
1 GiB, plus the copies made while trimming them.
