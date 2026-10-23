# PC skit command evidence

These are offline findings from the installed 32-bit PC executable, checked on
2026-10-22. The inspected file's SHA-256 is
`01cad33820c383b938452acb60eed21262152b9f85f29bfbbcee04d51d3a7104`.
It includes this workspace's modifications; addresses identify inspected native
implementations, not a promise that every retail build has identical code.
No game process, executable, save, or IDB was modified for this work.

The native dispatch registry begins at virtual address `0x8AE4F8`: 8-byte
records containing an opcode and handler address. `0x5701B0` searches this
registry. The PC VM's argument count is at context `+0x844`, with argument
storage at `+0x848`. Its expression stack supports 256 entries and native
argument stack supports 128 entries. The older GameCube registry is useful
for arities, but some semantic names are misleading on PC: native `0x56`
plays a skit voice, rather than changing music.

## Confirmed commands

Arguments below are in script/source order. Values are signed 32-bit unless
noted. Coordinates are the script's nominal 640 × 480 stage coordinates.

| Command | PC handler | Arguments and behavior |
| --- | --- | --- |
| `0x12` | `0x55EFE0` | `[actor]`: destroy matching actor(s), running state 6. Yields briefly. |
| `0x16` | `0x55F500` | `[actor,x,y,z,speed_or_duration]`: move to target. Nonnegative final value is speed, doubled per stock tick. `0x80000000 | ticks` is duration, computing speed from distance / `max(ticks/2,1)`. |
| `0x1D` | `0x560670` | `[actor,property,value]`: set property and **push previous value**. Discard this result with `calculate 0` when unused. See property table below. |
| `0x39` | `0x564510` | `[entry_id]`: start a context from an entry of kind 2; returns context handle or zero. |
| `0x56` | `0x565A80` | `[voice_id]`: call voice starter `0x570FA0`, yielding wait type 14 until ready. `-1` stops playback and clears the failure flag. |
| `0x57` | `0x56EB50` | `[actor,texture_handle,x,y,width,height,rotation,r,g,b,alpha,fade_frames,animation_resource]`: create a portrait entity. Width/height `-1` use asset dimensions. `rotation` is **not scale**. |
| `0x58` | `0x567040` | `[resource]`: start loading a resource and return a handle with high bits `0xFFFE0000`. The loader has 64 slots. |
| `0x59` | `0x565EB0` | `[position]`: wait type 19. `-1` waits for audio completion; nonnegative values wait for a position in the current clip. This is an absolute clip milestone, not a delay after the preceding command. |
| `0x5E` | `0x55FAE0` | `[actor,scale_percent,ticks]`: target scale is percent / 100; step uses `max(ticks/2,1)`. |
| `0x64` | `0x565DC0` | `[wait_type,value]`: suspend context; verified types below. |
| `0x65` | `0x565EE0` | `[divisor]`: random result modulo divisor. Consumes one argument and pushes a result, preserving enclosing native arguments. The preview leaves the random result unknown. |
| `0x6F` | `0x566A90` | `[angle]`: sine calculation. Consumes one argument inside the enclosing expression. Its result remains unknown in the preview. |
| `0xF1` | `0x56F910` | `[actor,mode]`: set portrait mouth activity. `0xAE71B` clears all other mouths and activates this actor; `0x604F1` clears all mouths; other modes activate this actor without clearing others. Retail uses `0x604F0` for the latter. |
| `0xF4` | `0x56FA10` | `[actor,-1,text_id]`: set skit subtitle text. **Only argument 2 is read on PC**; changing argument 0 alone does not change the animated speaker. |
| `0xFF` | VM `0x5702E4` | End context. Completion of context zero exits the skit, verified at `0x555391`. |

Portrait resource IDs are `0xD0000 | texture_slot`. The executable's animation
table has 222 slots. Native `0x57` stores the low 16-bit animation slot at
entity `+0x34`, texture handle at `+0xC0`, actor ID at `+0xB8`, and the
portrait callback `0x556350` at `+0`.

The allocated skit entity array contains 31 usable slots and a sentinel,
confirmed at `0x55527B`–`0x555294`.

| Property (`0x1D`) | Setter address | Meaning |
| --- | --- | --- |
| 1 / 2 / 3 | `0x5608D3` / `0x5608F9` / `0x56091F` | Position x / y / z. |
| 37 | `0x560FF1` | Rotation angle, written to entity `+0x40` and `+0x74`. |
| 63 | `0x56138F` | Animation resource/slot only; does **not** replace texture handle. |
| 64 | `0x5613D5` | Forced eye frame at `+0xC7`; `-1` restores automatic animation. |
| 65 | `0x561412` | Forced mouth frame at `+0xCD`; `-1` restores automatic animation. |

No third-channel forced-frame setter was established. Frame selection must be
bounded by the imported executable's actual playable frame count; arbitrary
indices can run past a native animation table. Switching to a different
expression asset requires loading that asset and destroying/recreating the
portrait, rather than changing property 63 alone.

## Wait and voice behavior

`0x55C5C0` dispatches wait states through table `0x55CF6C`.

| Wait type | Resume address | Meaning |
| --- | --- | --- |
| 0 | `0x55C604` | Fixed delay, in 60 Hz ticks. Stock code subtracts 2 per update, using float at `0x72F418`. |
| 1 | `0x55C64F` | Wait for loaded resource handle; finish native texture/resource setup before use. |
| 14 | `0x55CB79` | Voice has reached ready/playing state, or has failed/stopped. Used by `0x56`. |
| 15 | `0x55CB97` | Voice has completed; in skit mode adds a further 30 ticks before continuing. |
| 17 | `0x55CC00` | Current voice identifier `0xB18924` equals the requested ID. |
| 19 | `0x55CC47` | `0x59` milestone/completion; reads playback position through `0x581FC0`. |

`0x581FC0` divides the engine's 64-bit audio position counter by 10. The counter's
upstream unit was not established here; the editor must label native milestone
values as native audio-position units unless separately verified. Do not
confuse these with fixed 60 Hz wait ticks.

Native `0x57` fade duration differs: it divides alpha by its duration directly
and adds that delta once per portrait update (`0x55694B`). It counts stock
30 FPS updates. Authored `fadeTicks` is converted to `ceil(ticks/2)` for the
stock game; behavior with the workspace's 60 FPS patches still needs gameplay
validation. `fadeTicks=0` gives immediate opacity.

Native `0x51` is a BGM-volume/fade operation (via `0x570960`, using user setting
`+0x23D`). It does not mute voices. `0x570FA0` takes voice volume from setting
`+0x23F` and calls `0x582710` on the voice channel. The inspected script-native
region has no direct voice-volume setter. Do not implement voice disabling by
calling `0x51` or changing a persistent user setting.

## Retail script organization

The corpus has two cooperating streams in common cases. The default context
loads portraits, stages movement, and launches voices. A kind-2 entry with ID
3000 contains subtitles and mouth cues, started with `0x39[3000]`. That second
stream waits for `0x64[17,voice_id]`, emits `0xF4` and `0xF1`, and often waits
on several `0x59` audio milestones within the same clip.

For example `FC_W011.SKP` uses one voice clip for three subtitle records.
Therefore “one subtitle row” is not necessarily “one voice clip”. Changing
the clip's `0x56` affects all rows linked to it. Deleting or muting a `0x56`
without changing the other stream can hang the skit at a type-17 or type-19
wait. Reordering only subtitle blocks can separate text from voice/staging.

Retail edits preserve those programs and unknown operations. The new authoring
mode deliberately creates a fresh sequential program. Converting retail text
to that mode must be an explicit operation that explains that choreography
is not transferred; it cannot masquerade as a lossless conversion.

The browser's retail row projection is intentionally conservative. A subtitle
row begins at `0xF4`; the first active `0xF1` before the next subtitle supplies
its primary speaker. Clear-all mode `0x604F1` is not a speaker activation.
Changing that speaker must update every later activation of the same actor in
the row, because those pulses otherwise restore the old animated speaker.
Distinct active actors in one row are retained and flagged rather than merged.
An inherited speaker has no row-local edit target and is shown read-only.
Voice/speaker inheritance stops at registered context entries, end, and return.
Voice-ID waits in entry 3000 only bind an editable launch when exactly one
matching `0x56` occurs in the default context; repeated IDs remain ambiguous.

The retail portrait preview joins the two streams at these voice cues and at
their `0x59` milestones. It reconstructs the cast at the selected subtitle,
including native eye/mouth setters and saved frame overrides. A destroy/spawn
pair replaces the portrait and resets those holds. Property 63 changes only the
animation table, leaving the current texture resource intact. Seeking backward
rebuilds the state instead of retaining changes from a later line.

`FC_W085.SKP` demonstrates why the first spawn and voice ID alone are
insufficient. Zelos (actor 6) uses slot 118 for rows 1–2, 125 for rows 3–6,
117 at row 7, and 123 for rows 8–9. Rows 7–9 share voice 66368: the main
context replaces Zelos at milestone 165, while row 8 starts at milestone 170
and sets eye property 64 to 1. Row 9 starts at 547 and restores automatic eyes
with -1. Genis changes from 60 to 56, Presea from 138 to 141, and Regal from
159 to 163 elsewhere in the same skit.

This is a cue snapshot, not execution of the full skit VM. The preview compares
native milestones without converting their unverified units to seconds.
Movement and changes within a line are not replayed during the five-second
audition. Ambiguous branches or synchronization produce a preview notice;
irrelevant rotation loops can be skipped when all exits reach the same next
portrait/voice event. The example's original SKP was checked locally and is not
included as a test fixture; synthetic parallel scripts exercise these cases.

The same skit's exits use native `0x16`, rather than destroying the other three
characters. After voice 66368 starts, Genis and Presea move to x=`200-500`=-300,
and Regal moves to x=`420+500`=920. Their duration is `0x80000000|30` (30 ticks).
Zelos moves to (320,200) over `0x80000000|60` ticks, then respawns there before
row 8. At rows 8–9 only Zelos intersects the stage. These expressions are pure
constants: the installed PC calculator dispatch at `0x56FD10` maps calculate
`0x31` to addition (`0x570017`), `0x32` to subtraction (`0x570026`), and `0x37`
to bitwise OR (`0x570080`). Preview evaluation resolves globals only after a
known assignment on the current path; uninitialized globals and native results
stay unknown. Computed coordinates never become editable literals.
Cue snapshots retain movement starts at the launch cue and settle to
destinations at later cues; they do not claim interpolated audio-time motion.

### Finite loops across the corpus

The previous branch merge stopped on movement or scale loops that could emit
different next events. This affected many more files than the `FC_W085` example:
only 64 of 471 main contexts completed. In `FC_C000`, a signed 32-bit counter at
`0x810` starts at 90, scales a portrait while `counter <= 110`, increments by 4,
and waits one tick per iteration. Stopping at that loop hid Genis's later
54 → 55 → 59 → 54 → 64 portraits and Lloyd's 0 → 1 change. `FC_B006` also uses
computed movement and a nested sine call.

The PC calculator at `0x56FD10` implements indexed references (`0x0F`) using the
reference width (1, 2, or 4 bytes), assignment `0x10` at `0x56FE60`, and addition
assignment `0x11` at `0x56FE74`. The store routine is `0x56FB40`. These support
tracking script-initialized counters without inventing initial game memory.
The native random handler `0x565EE0` decrements context `+0x844` by one and pushes
its result onto the expression stack, so it must retain earlier arguments of an
enclosing `0x1D` call. Treating it as consuming every argument shifts the actor,
property, and value of a random shake command.

`preview-values.ts` now evaluates these scalar operations along proven paths;
`retail-projection.ts` bounds execution and falls back to branch merging when a
condition is unknown. Inserted edit instructions participate in the same stacks,
including arguments that replace deleted original code. This remains a partial
preview evaluator, with unknown native results and no scheduler/game execution.

The optional `scripts/audit-retail-preview.mjs` uses the editor's tracing and
snapshots directly. The checked-in summary reports 428 complete main contexts
and complete main/subtitle traces for all 391 portrait-subtitle SKPs, with 347
files showing more than one appearance state. The 43 conditional field-dialogue
files remain incomplete. `FC_W139` starts with a subtitle before a voice cue,
so that introductory row uses the initial cast. These coverage counts do not
establish timing parity; all animation within a selected line remains subject
to the cue-snapshot limits above.

Corpus inspection found 635 `0x0C` dialogue configurations in 51 SKPs, including
43 files with no `0xF4`. Their text cannot be omitted just because they do not
follow the subtitle/mouth-cue layout. The GameCube registry identifies primary
and secondary message arguments 6 and 7; text-only access to the SKP's message
table does not depend on asserting equivalent PC speaker behavior for them.

## Implemented sequential authoring template

For each unique portrait resource, assign the `0x58` returned handle to an
otherwise unused `load.s32` reference at `0x678 + 4*index`, then wait type 1
on that handle. There are no secondary contexts or other globals in the
generated program sharing this scratch region.

Spawn the cast with `0x57`, then process each row:

1. Apply explicit stage changes, safely loading all selected texture variants
   during initialization. Texture/opacity changes replace the portrait.
2. Apply validated eye/mouth overrides with properties 64 and 65.
3. If enabled, start the chosen voice with `0x56`; its native wait completes
   before the subtitle begins.
4. Set subtitle `0xF4`, speaker `0xF1`, and fixed delay `0x64[0,durationTicks]`.
5. Stop mouth animation and stop this row's voice at its configured boundary.

The final sequence is `0x56[-1]`, end. There is no `0x59` or voice-ID wait in
this format, so disabled voices preserve the configured fixed duration. A
short configured duration deliberately truncates the voice; the UI can fit
duration to decoded audio length when desired.

This template is supported by inspected native handlers and structural tests,
including expression/native-argument stack balance and exported-file reopening.
It has **not been validated by in-game playback**. Both stock 30 FPS and the
workspace's patched 60 FPS remain required manual acceptance checks before a
release claims validated custom-skits playback.
