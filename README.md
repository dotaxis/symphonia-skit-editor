# TOS Skit Editor

A browser tool for editing **Tales of Symphonia PC / Steam** skits. Open an
extracted `.SKP`, edit it, and download a replacement for your mod. Portraits and
facial animation data are included. Japanese voice banks can be loaded separately
for audio preview. Files you open are processed locally in the browser.

The interface uses React and TypeScript, with a Rust/WebAssembly core for parsing,
validation, and binary output. GameCube skits are not supported.

For development on another machine or continuation by another agent, read the
[local development handoff](HANDOFF.md). It records the implementation map,
accepted behavior, validation evidence, limitations, and files to preserve when
leaving the remote workspace.

## Run locally

Requirements: Node.js 22+, npm, Rust stable (1.88+), and `wasm-bindgen` CLI **0.2.128**.

```sh
cd skit-editor
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128 --locked
npm ci
npm run build
npm run dev
```

Open the localhost URL Vite prints. Ensure Cargo's `bin` directory is on `PATH`.
If the CLI is installed elsewhere, set
`WASM_BINDGEN=/absolute/path/to/wasm-bindgen` when running the build.
After the first build, Rust changes require `npm run build:wasm`; interface changes
only need the development server.

## Editing

Messages with original encoded characters show a **Preserve original encoded
characters** checkbox. Uncheck it to omit those characters from that message in
the preview and exported SKP. Control codes stay protected. Rechecking restores
the characters; the setting is saved with the project and supports undo/redo.
The same option is available under **Script details → Edit all message records**.

1. Open an extracted `CHT/FC_*.SKP` file, or drop it onto the editor.
2. Select a dialogue row to edit its English text, speaking character, facial
   frames, or an existing voice milestone. In **Cast & staging**, click a portrait
   in the preview to choose a replacement from the gallery, then select **This
   appearance** or **All instances**. Drag a portrait to a standard position,
   including an empty one. The preview shows destinations while dragging and
   snaps to the nearest one when released above the subtitle box. Hold **Shift**
   while dragging to another portrait's position to swap their positions. Each completed
   drag is one undo step; pressing Escape or dropping outside the stage or over
   the subtitles leaves the positions unchanged.
   Numeric position controls remain available for custom coordinates.
3. Use **Voices** to load Japanese `.AWB` banks if you want audio preview.
4. **Save project** keeps the original bytes and your edits in a `.skit.json` file.
   **Export SKP** downloads the replacement binary.

Opening another document keeps the previous draft in the 80-step undo history.
Save a project to retain work beyond the current browser session. Drafts with
unsupported text can be saved and reopened for correction while binary export is
blocked.

Preview portrait clicks and dragging only edit the cast in **Cast & staging**.
Position edits require editable coordinates for each affected portrait. For
authored sequences, a drop takes effect immediately at the selected line,
replacing that line's movement; later stage events remain intact. A timed scale
change on that line prevents moving that actor, since its timing is shared with
movement. The preview explains unavailable destinations while dragging.
Dropping on an occupied position normally moves only the dragged portrait. Hold
**Shift** to exchange its position with the occupant instead; the preview shows
both resulting positions before release. Shift can be pressed or released during
the drag, and an empty destination still accepts a move. A swap requires editable
positions for both portraits and uses one undo step. If portraits overlap, select
the one to move in the cast list to bring it forward for editing, then drag it to
an empty destination.

Retail position changes edit the placement instruction shown at the selected
line. Later respawns and movement keep their own positions; a rearrangement does
not rewrite every later appearance of that character. If a later placement
overlaps another portrait, drag it into an empty standard destination on that
line. One undo restores the entire drop.

Standard positions are based on the common arrangements observed across the
471 PC skits, grouped by on-screen character count. The selected cue's original
positions and current positions are also available, preserving unusual layouts.
Overlapping characters count separately, so they do not remove empty destinations
from the layout. The
[layout audit](research/stage-layouts.json) records frequencies and example files;
it can be regenerated with `node scripts/audit-stage-layouts.mjs /path/to/R01/CHT`
after building WASM. Original game files are optional inputs to this audit and
are not needed to use the bundled positions.

The header shows the original English skit title alongside its slot filename,
including after saving or reopening a project. Titles come from a bundled PC
catalog, matched by filename; changing the destination slot updates the title.
Unnamed slots show **No English title**, and filenames outside the catalog show
**Unknown skit title**. These menu titles are stored outside the SKP in the game's
text archive and are not changed by editing the skit's message records.

**Script details → Skit ID** shows the decimal ID used by the test maps' skit
selector, such as **685** for `FC_W085.SKP`. It follows the slot filename,
including in saved projects and authored sequences. Known slots retain their IDs
even without an English title; unknown filenames show **Unknown skit ID**.

Character names follow the selected portrait, including per-line portrait changes.
The gallery can be searched by character name, portrait ID, or PAC filename.
Sequence projects can override a character's display label; leaving it blank uses
the portrait's name. Existing custom labels are preserved.

**This appearance** changes the selected retail portrait placement, which may
span several dialogue lines before the script replaces it again. **All
instances** changes every use of that same portrait resource in the skit; other
expressions remain separate. In a sequence project, the local choice applies
from the selected line until the next portrait change. Choosing a gallery image
does not modify the draft until a scope is selected. **Cancel** keeps it unchanged.
The **Replace portrait** button in the cast controls provides keyboard access.

Local retail replacements preserve shared texture handles used by other
placements. The editor reuses a verified loaded resource or adds a load into a
proven unused handle-array entry. If the script's resource setup cannot support
a safe scoped replacement, the unavailable option explains why. The existing
**Script portrait resource → Browse portraits** control remains available for
explicit replacements throughout the original resource group.

Text can grow or shrink. Script controls and encoded character sequences remain
protected tokens. English output accepts printable ASCII and line breaks;
unsupported characters are reported instead of replaced. **Script details → Edit
all message records** exposes every text record stored in the SKP. Font rendering and
wrapping in the preview are approximate; check the result in game.

Original scripts retain their parallel staging and voice cues. A voice milestone
is an absolute position within the original clip, not a line duration; `-1` waits
for the clip to finish. The selected-line preview follows portrait replacements
and eye/mouth overrides at each dialogue cue. It aligns the original staging and
subtitle streams using voice launches and native milestones, including multiple
lines within one clip. Facial holds persist until a later override or portrait
replacement. The bundled animation catalog supplies frame limits for the
resources an actor uses.

Character entrances and exits follow spawns, removals, and known movement
destinations. Constant coordinate expressions are resolved, so characters that
move off-screen no longer remain at their original position. Seeking backward
restores the earlier cast and positions.

The preview also follows finite scale, movement, and shake loops whose counters
are initialized in the script, so they do not hide later portrait replacements
or facial holds. This applies to every filename and character. Unknown game
state and native results remain unresolved; computed values stay read-only.

Retail preview remains a five-second audition of the state at the selected line;
movements retain their start position at their launch cue and use their target at
later cues. It does not replay motion or expression changes within a line. Unresolved
branches or computed portrait changes are marked as approximate rather than
showing later script states as if they had already happened. Position controls
edit the known placement shown for the selected line.

Speaker changes update matching activation cues and preserve other simultaneously
active speakers. Computed or inherited values without a proven literal edit stay
read-only. `FC_W015.SKP` has a branch to `0xFFFF`: its text is editable, but
structural edits are blocked. Placeholder skits are preserved byte for byte.

## Larger changes to a skit

For line insertion, deletion, reordering, independent durations, voice disabling,
or more extensive staging, open **Script details → Sequence editing** and choose
**Edit as sequence**. Confirm with **Save original & edit sequence** to download
the original project and copy its text, reconstructed initial cast, and voice
IDs into a sequential script you can edit.

This changes the script structure. Original branches, parallel choreography,
embedded text expressions, and voice milestones are not copied. Rows initially
last three seconds. A voice clip may cover several original subtitle rows, so
review its assignments and durations after conversion. There is no separate
blank-skit workflow.

In a sequence, each row has a speaker, a duration in **60 Hz ticks**, an optional
voice, and automatic or held facial frames. **Fit duration to voice** uses the
loaded clip length. Disabling a voice preserves the row duration; a shorter
duration can cut a voice off. **Cast & staging** supports portrait changes,
movement, scale, rotation, visibility, opacity, and fades. **Browse portraits**
opens the included portrait gallery; **Choose portrait expression** changes the
speaker's portrait at the current row. **Play skit** previews the whole sequence.
Native resource loading and scheduling can add time in game.

Export to an existing `FC_Bnnn.SKP`, `FC_Cnnn.SKP`, `FC_Unnn.SKP`, or `FC_Wnnn.SKP`
slot. The editor does not register new slots, install files, repack archives, or
modify the game executable.

## Portraits and optional voices

Portrait textures, expression resources, and animation tables ship with the
editor. Neither an extracted R01 folder nor `TOS.exe` is needed for portrait
preview, facial frame selection, or the gallery. The game artwork is separate
from the editor's source-code license. The bundle contains 106 portrait resources,
479 PNG layers, and 222 animation slots, totaling about 8.4 MB. Image layers load
only when displayed.

To regenerate it from a local extraction, run the
[portrait preparation script](scripts/prepare-portraits.py) from this directory:

```sh
python3 scripts/prepare-portraits.py /path/to/R01 /path/to/TOS.exe
```

It writes browser-ready PNGs and a JSON catalog to `public/portraits/`. The bundle
contains no executable, original archives, or voice banks.

To preview Japanese voices, choose **Voices → Select voice banks** and select any of:

- `VOICE_JP/CHT_COMMON.AWB`
- `VOICE_JP/CHT_DISC_1.AWB`
- `VOICE_JP/CHT_DISC_2.AWB`

Voice banks remain local and are not included with the editor or saved projects.
Load them again after reopening the browser. Preview continues without audio when
a bank is missing and shows a notice naming the needed file. `SND/AFSBIN/CHT*.BIN` files are
filename manifests, not audio. Banks are indexed without reading their entire
payloads; clips are decoded on demand with a bounded cache. Audio preview is not
sample-identical to the game's decoder and mixer.

## Skit title and ID catalog

`src/skit-titles.json` contains 492 canonical PC slot filenames, each with its
decimal selector `id` and `title`: 391 English titles and 101 blank entries
(80 present scripts and 21 absent script slots). It comes
from the workspace's `tos-60-experiments/skit-id/skit-names-and-ids.json`, extracted
by `export_skit_names.py` from the executable's filename/title tables and the
English entries in `APPKEEP/TOS_TEXT.TXB`. Noncanonical selector aliases are
excluded because they can point at a script with a mismatched title.

To regenerate the bundled catalog from that research export:

```sh
python3 scripts/prepare-skit-titles.py ../tos-60-experiments/skit-id/skit-names-and-ids.json
```

The catalog is included in static builds; users do not need to supply game data
to see the titles or test-map IDs.

## Checks

```sh
cargo test --locked --manifest-path core/Cargo.toml
npm run build
npx playwright install chromium
CHROMIUM_PATH="$(node --input-type=module -e 'import {chromium} from "@playwright/test"; process.stdout.write(chromium.executablePath())')" npm test
```

The browser suite defaults to `/usr/bin/chromium`; `CHROMIUM_PATH` overrides it.
Tests generate synthetic skits in the system temporary directory. They cover
native/WASM parity, edited exports, protected controls, project recovery,
undo/redo, sequence editing, frame validation, preview state, and deployment under
a repository subpath. Retail skit files are not included as test fixtures.

Optional checks against an extracted local game:

```sh
cargo run --release --manifest-path core/Cargo.toml --bin skit-corpus -- /path/to/R01/CHT --exercise-edits
cargo run --release --manifest-path core/Cargo.toml --bin asset-check -- /path/to/R01 /path/to/TOS.exe /path/to/VOICE_JP
node scripts/audit-retail-preview.mjs /path/to/R01/CHT
```

The workspace corpus passes 471 byte-exact no-op exports, 434 text-growth checks,
and 470 code-relocation checks. Asset checks cover 479 textures, 106 PACs, 222
animation slots, and 3,103 Japanese clips. **In-game replay remains unverified** for
edited and rebuilt exports. Check text wrapping, speakers, faces, movement,
voice disabling, skit exit, and repeated entry at stock 30 FPS and patched 60 FPS
before distributing a mod. Command evidence and timing limits are recorded in
[the PC VM research](research/pc-skit-vm.md).

The [portrait preview audit](research/retail-preview-audit.json) checks all 471
local SKPs. Both staging and subtitle traces complete for all 391 skits with
portrait subtitles. The 43 conditional field-style dialogue scripts still use
the conservative fallback. This checks reconstruction coverage, not in-game
timing parity.

## GitHub Pages

`npm run build` produces `dist/` with relative asset URLs, including the bundled
portraits. It can be served from a GitHub Pages repository subpath without a
backend or the rest of this workspace.

`.github/workflows/skit-editor.yml` builds, tests, and uploads the static site as an
artifact. Configure Pages to use GitHub Actions. Pushes to `main` automatically
publish after the build and tests pass. Other branch pushes and pull requests
run checks without publishing. You can also manually run the skit editor workflow
with **deploy** enabled. It follows GitHub's
[custom Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
Local builds do not publish anything.

Keep local voice banks, projects, and private exports out of the repository.

## Core interfaces

The WASM worker exposes `parse_skit(bytes)`, `compile_skit(bytes, editsJson)`,
`create_skit(specJson)`, `author_skit(specJson)`, `inspect_assets(kind, bytes)`,
`decode_texture(bytes)`, and `decode_audio(bytes)`. Parse and inspection results
are JSON; compile and author results are byte arrays. Native Rust interfaces use
the same structures and validators. Low-level edits preserve the original file;
sequence editing generates a sequential program.

The implementation builds on the workspace's PC investigations and the format
research in `gc-decomp/tales-script-lang` (MIT OR Apache-2.0). It does not require
that repository to build.
