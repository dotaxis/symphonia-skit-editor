//! A deliberately small PC skit authoring language, compiled to verified native
//! operations. Retail programs remain in the lossless SKP document; this module
//! creates a new sequential script rather than guessing how to rewrite threads.
//! Native evidence and timing caveats are recorded in research/pc-skit-vm.md.
use crate::{
    skp::{self, CreateSpec, Token},
    vm::NewInstruction as I,
};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorSpec {
    pub actors: Vec<Actor>,
    pub rows: Vec<Row>,
    #[serde(default)]
    pub animation_frames: Vec<AnimationFrames>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Actor {
    pub id: i32,
    pub texture_slot: u16,
    pub x: i32,
    pub y: i32,
    #[serde(default = "hundred")]
    pub scale_percent: i32,
    #[serde(default)]
    pub rotation: i32,
    #[serde(default = "opaque")]
    pub alpha: i32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Row {
    pub text: String,
    pub speaker: i32,
    pub duration_ticks: u32,
    #[serde(default)]
    pub voice_id: Option<u32>,
    #[serde(default = "yes")]
    pub voice_enabled: bool,
    #[serde(default = "automatic")]
    pub eye_frame: i32,
    #[serde(default = "automatic")]
    pub mouth_frame: i32,
    #[serde(default)]
    pub stage: Vec<StageChange>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageChange {
    pub actor_id: i32,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub texture_slot: Option<u16>,
    pub scale_percent: Option<i32>,
    pub visible: Option<bool>,
    #[serde(default)]
    pub movement_ticks: u32,
    #[serde(default)]
    pub fade_ticks: u32,
    pub rotation: Option<i32>,
    pub alpha: Option<i32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnimationFrames {
    pub texture_slot: u16,
    pub eye_frames: u16,
    pub mouth_frames: u16,
}

fn hundred() -> i32 {
    100
}
fn opaque() -> i32 {
    255
}
fn yes() -> bool {
    true
}
fn automatic() -> i32 {
    -1
}

fn argument(code: &mut Vec<I>, value: i32) {
    code.push(I::Literal { value });
    code.push(I::Calculate { opcode: 0 });
    code.push(I::Argument);
}
fn native(code: &mut Vec<I>, opcode: u8, args: &[i32]) {
    for value in args {
        argument(code, *value);
    }
    code.push(I::Native { opcode });
}
fn load(code: &mut Vec<I>, offset: u16) {
    code.push(I::LoadGlobal {
        offset,
        width: "s32".into(),
    });
}
fn property(code: &mut Vec<I>, actor: i32, property: i32, value: i32) {
    native(code, 0x1d, &[actor, property, value]);
    // 0x1D returns the previous value even when the property is a setter.
    code.push(I::Calculate { opcode: 0 });
}
fn texture_id(slot: u16) -> i32 {
    0x000d_0000 | i32::from(slot)
}
fn texture_slot(slot: u16) -> Result<(), String> {
    if slot >= 222 {
        return Err(format!(
            "Texture slot {slot} is outside the verified PC table (0..221)"
        ));
    }
    Ok(())
}
fn actor_values(actor: &Actor) -> Result<(), String> {
    texture_slot(actor.texture_slot)?;
    if !(1..=99998).contains(&actor.id) {
        return Err("Actor IDs must be unique values from 1 to 99998".into());
    }
    if !(-32768..=32767).contains(&actor.x) || !(-32768..=32767).contains(&actor.y) {
        return Err(format!(
            "Actor {} position exceeds signed 16-bit staging bounds",
            actor.id
        ));
    }
    if !(0..=1000).contains(&actor.scale_percent) {
        return Err("Scale must be 0..1000 percent".into());
    }
    if !(0..=255).contains(&actor.alpha) {
        return Err("Opacity must be 0..255".into());
    }
    Ok(())
}

fn spawn(code: &mut Vec<I>, actor: &Actor, offset: u16, fade_ticks: u32) {
    argument(code, actor.id);
    load(code, offset);
    code.push(I::Calculate { opcode: 0 });
    code.push(I::Argument);
    // Portrait native 0x57 uses rotation at arg 6, NOT scale. Width and
    // height -1 use source texture dimensions. Fade duration is stock frames.
    let fade_frames = if fade_ticks == 0 {
        0
    } else {
        fade_ticks.div_ceil(2) as i32
    };
    for value in [
        actor.x,
        actor.y,
        -1,
        -1,
        actor.rotation,
        255,
        255,
        255,
        actor.alpha,
        fade_frames,
        texture_id(actor.texture_slot),
    ] {
        argument(code, value);
    }
    code.push(I::Native { opcode: 0x57 });
    if actor.scale_percent != 100 {
        native(code, 0x5e, &[actor.id, actor.scale_percent, 1]);
    }
}

/// Compile the explicitly authored sequential model. Fixed-duration rows stop
/// their clip at the configured boundary. A disabled voice emits no voice wait,
/// so it cannot deadlock on a missing clip. This does not mutate retail inputs.
pub fn author_skit(spec: &str) -> Result<Vec<u8>, String> {
    let spec: AuthorSpec =
        serde_json::from_str(spec).map_err(|e| format!("Invalid authored skit: {e}"))?;
    let compiled = author_program(&spec)?;
    skp::create(&compiled)
}

pub fn author_program(spec: &AuthorSpec) -> Result<CreateSpec, String> {
    if spec.actors.is_empty() || spec.actors.len() > 31 {
        return Err("A skit needs 1..31 portrait actors".into());
    }
    if spec.rows.is_empty() {
        return Err("Add at least one dialogue row before exporting a custom skit".into());
    }
    if spec.rows.len() > 4096 {
        return Err("A custom skit supports at most 4096 dialogue rows".into());
    }
    let mut actors = BTreeMap::new();
    let mut slots = BTreeSet::new();
    for actor in &spec.actors {
        actor_values(actor)?;
        if actors.insert(actor.id, (actor.clone(), true)).is_some() {
            return Err(format!("Duplicate actor ID {}", actor.id));
        }
        slots.insert(actor.texture_slot);
    }
    for (index, row) in spec.rows.iter().enumerate() {
        let mut staged_actors = BTreeSet::new();
        for change in &row.stage {
            if !staged_actors.insert(change.actor_id) {
                return Err(format!(
                    "Row {}: merge multiple stage changes for actor {} into one event",
                    index + 1,
                    change.actor_id
                ));
            }
            if let Some(slot) = change.texture_slot {
                texture_slot(slot)?;
                slots.insert(slot);
            }
        }
    }
    if slots.len() > 64 {
        return Err(
            "The native loader supports at most 64 loaded portrait resources in a skit".into(),
        );
    }
    let frames: BTreeMap<_, _> = spec
        .animation_frames
        .iter()
        .map(|f| (f.texture_slot, f))
        .collect();
    // The retail scripts use the same scratch region for portrait handles.
    // This program has no other threads or globals sharing it.
    let offsets: BTreeMap<_, _> = slots
        .iter()
        .enumerate()
        .map(|(index, slot)| (*slot, 0x678 + index as u16 * 4))
        .collect();
    let mut code = Vec::new();
    for (slot, offset) in &offsets {
        load(&mut code, *offset); // assignment destination remains on expression stack
        native(&mut code, 0x58, &[texture_id(*slot)]);
        code.push(I::Calculate { opcode: 0x10 });
        code.push(I::Calculate { opcode: 0 });
        argument(&mut code, 1);
        load(&mut code, *offset);
        code.push(I::Calculate { opcode: 0 });
        code.push(I::Argument);
        code.push(I::Native { opcode: 0x64 });
    }
    for actor in &spec.actors {
        spawn(&mut code, actor, offsets[&actor.texture_slot], 0);
    }
    let mut messages = Vec::new();
    for (index, row) in spec.rows.iter().enumerate() {
        let label = format!("Row {}", index + 1);
        if row.duration_ticks == 0 || row.duration_ticks > 216000 {
            return Err(format!(
                "{label}: duration must be 1..216000 ticks (60 ticks/second)"
            ));
        }
        if row.text.len() > 1023 {
            return Err(format!(
                "{label}: text exceeds the native 1024-byte skit text buffer"
            ));
        }
        if row
            .text
            .bytes()
            .any(|b| !(b == b'\n' || (0x20..=0x7e).contains(&b)))
        {
            return Err(format!("{label}: custom text supports printable ASCII and newlines; control bytes and unsupported characters are rejected"));
        }
        for change in &row.stage {
            let Some((actor, visible)) = actors.get_mut(&change.actor_id) else {
                return Err(format!("{label}: unknown staged actor {}", change.actor_id));
            };
            if change.movement_ticks > row.duration_ticks || change.fade_ticks > row.duration_ticks
            {
                return Err(format!(
                    "{label}: movement and fade must finish within the row duration"
                ));
            }
            let previous = actor.clone();
            let was_visible = *visible;
            if let Some(v) = change.x {
                actor.x = v;
            }
            if let Some(v) = change.y {
                actor.y = v;
            }
            if let Some(v) = change.texture_slot {
                actor.texture_slot = v;
            }
            if let Some(v) = change.scale_percent {
                actor.scale_percent = v;
            }
            if let Some(v) = change.rotation {
                actor.rotation = v;
            }
            if let Some(v) = change.alpha {
                actor.alpha = v;
            }
            if let Some(v) = change.visible {
                *visible = v;
            }
            actor_values(actor).map_err(|e| format!("{label}: {e}"))?;
            let replace = !was_visible
                || actor.texture_slot != previous.texture_slot
                || actor.alpha != previous.alpha
                || change.fade_ticks != 0;
            if was_visible && (!*visible || replace) {
                native(&mut code, 0x12, &[actor.id]);
            }
            if !*visible {
                continue;
            }
            if replace {
                let moving =
                    change.movement_ticks != 0 && (actor.x != previous.x || actor.y != previous.y);
                let mut initial = actor.clone();
                if moving {
                    initial.x = previous.x;
                    initial.y = previous.y;
                }
                spawn(
                    &mut code,
                    &initial,
                    offsets[&actor.texture_slot],
                    change.fade_ticks,
                );
                if moving {
                    native(
                        &mut code,
                        0x16,
                        &[
                            actor.id,
                            actor.x,
                            actor.y,
                            0,
                            (0x8000_0000u32 | change.movement_ticks) as i32,
                        ],
                    );
                }
            } else {
                if actor.x != previous.x || actor.y != previous.y {
                    if change.movement_ticks == 0 {
                        property(&mut code, actor.id, 1, actor.x);
                        property(&mut code, actor.id, 2, actor.y);
                    } else {
                        native(
                            &mut code,
                            0x16,
                            &[
                                actor.id,
                                actor.x,
                                actor.y,
                                0,
                                (0x8000_0000u32 | change.movement_ticks) as i32,
                            ],
                        );
                    }
                }
                if actor.rotation != previous.rotation {
                    property(&mut code, actor.id, 37, actor.rotation);
                }
                if actor.scale_percent != previous.scale_percent {
                    native(
                        &mut code,
                        0x5e,
                        &[
                            actor.id,
                            actor.scale_percent,
                            change.movement_ticks.max(1) as i32,
                        ],
                    );
                }
            }
        }
        let Some((speaker, visible)) = actors.get(&row.speaker) else {
            return Err(format!("{label}: unknown speaker {}", row.speaker));
        };
        if !visible {
            return Err(format!("{label}: speaker {} is hidden", row.speaker));
        }
        for (frame, channel) in [(row.eye_frame, "eye"), (row.mouth_frame, "mouth")] {
            if !(-1..=254).contains(&frame) {
                return Err(format!(
                    "{label}: {channel} frame must be -1 (automatic) or 0..254"
                ));
            }
            if frame >= 0 {
                let Some(counts) = frames.get(&speaker.texture_slot) else {
                    return Err(format!("{label}: load animation metadata before forcing a {channel} frame"));
                };
                let count = if channel == "eye" {
                    counts.eye_frames
                } else {
                    counts.mouth_frames
                };
                if frame >= i32::from(count) {
                    return Err(format!(
                        "{label}: {channel} frame {frame} exceeds this portrait's {count} frames"
                    ));
                }
            }
        }
        property(&mut code, row.speaker, 64, row.eye_frame);
        property(&mut code, row.speaker, 65, row.mouth_frame);
        let voice = row.voice_id.filter(|_| row.voice_enabled);
        if let Some(voice) = voice {
            if !(1..=3).contains(&(voice >> 16)) {
                return Err(format!("{label}: voice ID must select bank 1, 2, or 3"));
            }
            native(&mut code, 0x56, &[voice as i32]);
        }
        native(&mut code, 0xf4, &[row.speaker, -1, index as i32]);
        native(&mut code, 0xf1, &[row.speaker, 0x000a_e71b]);
        native(&mut code, 0x64, &[0, row.duration_ticks as i32]);
        native(&mut code, 0xf1, &[row.speaker, 0x0006_04f1]);
        if voice.is_some() {
            native(&mut code, 0x56, &[-1]);
        }
        messages.push(vec![Token::Text {
            text: row.text.clone(),
        }]);
    }
    native(&mut code, 0x56, &[-1]);
    code.push(I::End);
    Ok(CreateSpec {
        instructions: code,
        messages,
        entries: Vec::new(),
        default_pc: 0,
        default_label: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> AuthorSpec {
        serde_json::from_str(r#"{"actors":[{"id":1,"textureSlot":0,"x":320,"y":200}],"rows":[{"text":"A new skit.","speaker":1,"durationTicks":180}]}"#).unwrap()
    }
    #[test]
    fn muted_program_never_waits_for_absent_audio() {
        let mut spec = fixture();
        spec.rows[0].voice_id = Some(0x10000);
        spec.rows[0].voice_enabled = false;
        let program = author_program(&spec).unwrap();
        assert!(!program
            .instructions
            .iter()
            .any(|i| matches!(i, I::Native { opcode: 0x59 })));
        assert_eq!(
            program
                .instructions
                .iter()
                .filter(|i| matches!(i, I::Native { opcode: 0x56 }))
                .count(),
            1
        );
        assert!(program.entries.is_empty());
    }
    #[test]
    fn exported_custom_skit_reopens_and_all_native_arguments_balance() {
        let mut spec = fixture();
        spec.rows[0].voice_id = Some(0x10001);
        spec.rows[0].stage = vec![serde_json::from_str(
            r#"{"actorId":1,"textureSlot":1,"x":400,"movementTicks":60,"scalePercent":90}"#,
        )
        .unwrap()];
        let program = author_program(&spec).unwrap();
        let bytes = skp::create(&program).unwrap();
        let parsed = skp::inspect(&bytes).unwrap();
        assert_eq!(parsed.messages[0].text, "A new skit.");
        assert_eq!(parsed.default_pc, 0);
        assert!(parsed.entries.is_empty());
        // Independently check argument/expression stack balance across every
        // native boundary, including value-returning load/property operations.
        let (mut expressions, mut arguments) = (0i32, 0i32);
        for instruction in &program.instructions {
            match instruction {
                I::Literal { .. } | I::LoadGlobal { .. } => expressions += 1,
                I::Calculate { opcode: 0 | 0x10 } => {
                    expressions -= 1;
                    assert!(expressions >= 0);
                }
                I::Argument => arguments += 1,
                I::Native { opcode } => {
                    let (arity, returns) = match opcode {
                        0x12 | 0x56 => (1, 0),
                        0x58 => (1, 1),
                        0x64 | 0xf1 => (2, 0),
                        0x5e | 0xf4 => (3, 0),
                        0x1d => (3, 1),
                        0x16 => (5, 0),
                        0x57 => (13, 0),
                        _ => panic!("Unverified native in authored program"),
                    };
                    assert_eq!(arguments, arity);
                    arguments = 0;
                    expressions += returns;
                }
                I::End => {
                    assert_eq!(expressions, 0);
                    assert_eq!(arguments, 0);
                }
                _ => panic!("Unexpected control flow in sequential program"),
            }
        }
    }
    #[test]
    fn refuses_invalid_cast_and_unsafe_text_or_frames() {
        let mut spec = fixture();
        spec.actors.push(spec.actors[0].clone());
        assert!(author_program(&spec).unwrap_err().contains("Duplicate"));
        let mut spec = fixture();
        spec.rows[0].text = "\u{9}voice".into();
        assert!(author_program(&spec).unwrap_err().contains("control bytes"));
        let mut spec = fixture();
        spec.rows[0].eye_frame = 5;
        assert!(author_program(&spec).unwrap_err().contains("metadata"));
        spec.animation_frames.push(AnimationFrames {
            texture_slot: 0,
            eye_frames: 3,
            mouth_frames: 3,
        });
        assert!(author_program(&spec).unwrap_err().contains("exceeds"));
    }
    #[test]
    fn refuses_hidden_speaker_and_overlapping_staging() {
        let mut spec = fixture();
        spec.rows[0].stage =
            vec![serde_json::from_str(r#"{"actorId":1,"visible":false}"#).unwrap()];
        assert!(author_program(&spec).unwrap_err().contains("hidden"));
        spec.rows[0].stage =
            vec![serde_json::from_str(r#"{"actorId":1,"x":400,"movementTicks":240}"#).unwrap()];
        assert!(author_program(&spec).unwrap_err().contains("finish within"));
    }
}
