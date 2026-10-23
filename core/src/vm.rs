//! PC wordcode decoding and relocation. Native calls stay numeric: decoding a
//! call's instruction width does not establish the meaning of its arguments.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Argument {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal_pc: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operand_pc: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_count: Option<usize>,
    pub editable: bool,
}

impl Argument {
    fn unknown() -> Self {
        Self {
            value: None,
            literal_pc: None,
            operand_pc: None,
            word_count: None,
            editable: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instruction {
    pub pc: u32,
    pub word: u16,
    pub mnemonic: String,
    pub words: Vec<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_pc: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_opcode: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<i32>,
    pub arguments: Vec<Argument>,
}

/// The SKP corpus uses these instruction forms. Unknown forms are an error,
/// rather than guessed widths that could silently relocate an operand as code.
pub fn decode(data: &[u8]) -> Result<Vec<Instruction>, String> {
    if !data.len().is_multiple_of(2) {
        return Err("Wordcode has an odd byte length".into());
    }
    let words: Vec<u16> = data
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    let mut out = Vec::new();
    let mut pc = 0;
    while pc < words.len() {
        let word = words[pc];
        let (len, mnemonic) = match word {
            0x0000..=0x00ff => (1, "push.s8"),
            0x0100 => (2, "push.s16"),
            0x0200 => (3, "push.s32"),
            0x0300 => (2, "push.u16"),
            0x1000 => (2, "load.s8"),
            0x1100 => (2, "load.s16"),
            0x1200 => (2, "load.s32"),
            0x2001 => (2, "jump"),
            0x2002 => (2, "call"),
            0x2003 => (1, "return"),
            0x2004 => (2, "branch_false"),
            0x20ff => (1, "end"),
            0x2000..=0x20fe => (1, "native"),
            0x3000..=0x30ff => (1, "calculate"),
            0x4000 => (1, "argument"),
            _ => {
                return Err(format!(
                    "Unknown instruction 0x{word:04X} at word PC 0x{pc:X}"
                ))
            }
        };
        if pc + len > words.len() {
            return Err(format!("Truncated instruction at word PC 0x{pc:X}"));
        }
        let chunk = words[pc..pc + len].to_vec();
        let value = match word {
            0..=255 => Some(word as u8 as i8 as i32),
            0x0100 => Some(chunk[1] as i16 as i32),
            0x0200 => Some((u32::from(chunk[1]) | u32::from(chunk[2]) << 16) as i32),
            0x0300 => Some(i32::from(chunk[1])),
            _ => None,
        };
        out.push(Instruction {
            pc: pc as u32,
            word,
            mnemonic: mnemonic.into(),
            words: chunk,
            target_pc: if matches!(word, 0x2001 | 0x2002 | 0x2004) {
                Some(u32::from(words[pc + 1]))
            } else {
                None
            },
            native_opcode: if (0x2000..=0x20fe).contains(&word) && !matches!(word, 0x2001..=0x2004)
            {
                Some(word as u8)
            } else {
                None
            },
            value,
            arguments: Vec::new(),
        });
        pc += len;
    }
    annotate_arguments(&mut out);
    Ok(out)
}

/// Recover direct literal arguments within straight-line code. This display is
/// deliberately conservative at branches, calls, and computed expressions.
fn annotate_arguments(instructions: &mut [Instruction]) {
    let mut values = Vec::<Argument>::new();
    let mut args = Vec::<Argument>::new();
    let mut popped = Argument::unknown();
    let targets: BTreeSet<u32> = instructions.iter().filter_map(|i| i.target_pc).collect();
    for instruction in instructions {
        if targets.contains(&instruction.pc) {
            values.clear();
            args.clear();
            popped = Argument::unknown();
        }
        if let Some(value) = instruction.value {
            values.push(Argument {
                value: Some(value),
                literal_pc: Some(instruction.pc),
                operand_pc: Some(instruction.pc + u32::from(instruction.words.len() > 1)),
                word_count: Some(instruction.words.len()),
                editable: true,
            });
        } else if matches!(instruction.word, 0x1000 | 0x1100 | 0x1200) {
            values.push(Argument::unknown());
        } else if instruction.word == 0x3000 {
            popped = values.pop().unwrap_or_else(Argument::unknown);
        } else if instruction.word == 0x4000 {
            args.push(popped.clone());
            popped = Argument::unknown();
        } else if instruction.word >> 12 == 3 {
            // Do not expose a literal nested in a calculation as the value of
            // the full argument. Its instruction remains visible separately.
            values.clear();
            values.push(Argument::unknown());
        } else if let Some(opcode) = instruction.native_opcode {
            // Native 0x6F consumes an argument and produces a value inside
            // larger call expressions in retail skits. Other researched calls
            // consume the prepared argument sequence.
            if opcode == 0x6f {
                instruction.arguments = vec![args.pop().unwrap_or_else(Argument::unknown)];
                values.push(Argument::unknown());
            } else {
                instruction.arguments = std::mem::take(&mut args);
                values.clear();
                if matches!(opcode, 0x58 | 0x65 | 0x1c | 0x6a | 0xb8) {
                    values.push(Argument::unknown());
                }
            }
        } else if matches!(instruction.word, 0x2001..=0x2004 | 0x20ff) {
            values.clear();
            args.clear();
            popped = Argument::unknown();
        }
    }
}

pub fn validate_targets(instructions: &[Instruction], roots: &[u32]) -> Result<(), String> {
    let boundaries: BTreeSet<u32> = instructions.iter().map(|i| i.pc).collect();
    for &pc in roots {
        if !boundaries.contains(&pc) {
            return Err(format!("Entry PC 0x{pc:X} is not an instruction boundary"));
        }
    }
    for instruction in instructions {
        if let Some(target) = instruction.target_pc {
            if !boundaries.contains(&target) {
                return Err(format!(
                    "Branch at PC 0x{:X} targets invalid PC 0x{target:X}",
                    instruction.pc
                ));
            }
        }
    }
    // A valid target alone does not make a complete program: reachable code
    // must not fall through into the message table. Preserve unreachable tail
    // padding found in retail files rather than demanding a terminal last word.
    let by_pc: BTreeMap<_, _> = instructions
        .iter()
        .map(|instruction| (instruction.pc, instruction))
        .collect();
    let mut pending = roots.to_vec();
    let mut visited = BTreeSet::new();
    while let Some(pc) = pending.pop() {
        if !visited.insert(pc) {
            continue;
        }
        let instruction = by_pc.get(&pc).ok_or_else(|| {
            format!("Reachable code falls outside the instruction region at PC 0x{pc:X}")
        })?;
        if matches!(instruction.word, 0x2003 | 0x20ff) {
            continue;
        }
        if let Some(target) = instruction.target_pc {
            pending.push(target);
        }
        if instruction.word != 0x2001 {
            pending.push(instruction.pc + instruction.words.len() as u32);
        }
    }
    Ok(())
}

/// Property 64/65 writes a byte-sized forced eye/mouth frame. Resource-specific
/// limits require the imported animation catalog, but these values can be
/// rejected before any asset data is available. Both -1 and 255 mean automatic
/// in original native code; original unknown/computed arguments stay opaque.
pub fn validate_forced_frame_literals(instructions: &[Instruction]) -> Result<(), String> {
    for instruction in instructions {
        if instruction.native_opcode != Some(0x1d) || instruction.arguments.len() != 3 {
            continue;
        }
        if matches!(instruction.arguments[1].value, Some(64 | 65)) {
            if let Some(frame) = instruction.arguments[2].value {
                if !(-1..=255).contains(&frame) {
                    return Err(format!("Forced animation frame at PC 0x{:X} must be automatic or a byte-sized frame index", instruction.pc));
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiteralEdit {
    pub pc: u32,
    pub value: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum NewInstruction {
    Literal { value: i32 },
    LoadGlobal { offset: u16, width: String },
    Argument,
    Calculate { opcode: u8 },
    Native { opcode: u8 },
    End,
    Return,
    Label { name: String },
    Jump { target: String },
    Call { target: String },
    BranchFalse { target: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Insertion {
    pub before_pc: u32,
    pub instructions: Vec<NewInstruction>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Deletion {
    pub start_pc: u32,
    pub end_pc: u32,
}

pub struct RebuiltCode {
    pub bytes: Vec<u8>,
    pub relocated: BTreeMap<u32, u32>,
}

fn literal_words(value: i32, original: Option<u16>) -> Vec<u16> {
    match original {
        Some(0x0300) if (0..=65535).contains(&value) => return vec![0x0300, value as u16],
        Some(0x0100) if (-32768..=32767).contains(&value) => return vec![0x0100, value as u16],
        Some(0x0200) => return vec![0x0200, value as u16, (value as u32 >> 16) as u16],
        _ => {}
    }
    if (-128..=127).contains(&value) {
        vec![value as u8 as u16]
    } else if (-32768..=32767).contains(&value) {
        vec![0x0100, value as u16]
    } else if (0..=65535).contains(&value) {
        vec![0x0300, value as u16]
    } else {
        vec![0x0200, value as u16, (value as u32 >> 16) as u16]
    }
}

#[derive(Clone)]
enum Fixup {
    Original(u32),
    Label(String),
}

fn emit_new(
    program: &[NewInstruction],
    words: &mut Vec<u16>,
    labels: &mut BTreeMap<String, u32>,
    fixups: &mut Vec<(usize, Fixup)>,
) -> Result<(), String> {
    for instruction in program {
        match instruction {
            NewInstruction::Literal { value } => words.extend(literal_words(*value, None)),
            NewInstruction::LoadGlobal { offset, width } => {
                let op = match width.as_str() {
                    "s8" => 0x1000,
                    "s16" => 0x1100,
                    "s32" => 0x1200,
                    _ => return Err("Global load width must be s8, s16 or s32".into()),
                };
                words.extend([op, *offset]);
            }
            NewInstruction::Argument => words.push(0x4000),
            NewInstruction::Calculate { opcode } => {
                if !matches!(opcode, 0..=8 | 0x0f..=0x1a | 0x20..=0x27 | 0x31..=0x3a) {
                    return Err(format!("Unsupported calculator opcode 0x{opcode:02X}"));
                }
                words.push(0x3000 | u16::from(*opcode));
            }
            NewInstruction::Native { opcode } => {
                if matches!(opcode, 0..=9 | 0xff) {
                    return Err("Use explicit control-flow instruction kinds".into());
                }
                words.push(0x2000 | u16::from(*opcode));
            }
            NewInstruction::End => words.push(0x20ff),
            NewInstruction::Return => words.push(0x2003),
            NewInstruction::Label { name } => {
                if name.is_empty() || labels.insert(name.clone(), words.len() as u32).is_some() {
                    return Err(format!("Empty or duplicate label {name:?}"));
                }
            }
            NewInstruction::Jump { target }
            | NewInstruction::Call { target }
            | NewInstruction::BranchFalse { target } => {
                let op = match instruction {
                    NewInstruction::Jump { .. } => 0x2001,
                    NewInstruction::Call { .. } => 0x2002,
                    _ => 0x2004,
                };
                words.push(op);
                fixups.push((words.len(), Fixup::Label(target.clone())));
                words.push(0);
            }
        }
        if words.len() > u16::MAX as usize {
            return Err("Program exceeds the 16-bit word-PC limit".into());
        }
    }
    Ok(())
}

fn resolve(
    words: &mut [u16],
    fixups: Vec<(usize, Fixup)>,
    relocated: &BTreeMap<u32, u32>,
    labels: &BTreeMap<String, u32>,
) -> Result<(), String> {
    for (at, target) in fixups {
        let pc = match target {
            Fixup::Original(old) => *relocated
                .get(&old)
                .ok_or_else(|| format!("Cannot relocate deleted target PC 0x{old:X}"))?,
            Fixup::Label(name) => *labels
                .get(&name)
                .ok_or_else(|| format!("Undefined label {name:?}"))?,
        };
        words[at] =
            u16::try_from(pc).map_err(|_| "Relocated branch exceeds the 16-bit word-PC limit")?;
    }
    Ok(())
}

pub fn assemble(program: &[NewInstruction]) -> Result<(Vec<u8>, BTreeMap<String, u32>), String> {
    let mut words = Vec::new();
    let mut labels = BTreeMap::new();
    let mut fixups = Vec::new();
    emit_new(program, &mut words, &mut labels, &mut fixups)?;
    resolve(&mut words, fixups, &BTreeMap::new(), &labels)?;
    let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
    let instructions = decode(&bytes)?;
    validate_targets(&instructions, &[0])?;
    validate_forced_frame_literals(&instructions)?;
    Ok((bytes, labels))
}

pub fn rebuild(
    original: &[Instruction],
    literals: &[LiteralEdit],
    insertions: &[Insertion],
    deletions: &[Deletion],
) -> Result<RebuiltCode, String> {
    let end = original.last().map_or(0, |i| i.pc + i.words.len() as u32);
    let boundaries: BTreeSet<u32> = original
        .iter()
        .map(|i| i.pc)
        .chain(std::iter::once(end))
        .collect();
    let mut replacements = BTreeMap::new();
    for edit in literals {
        if replacements.insert(edit.pc, edit.value).is_some() {
            return Err(format!("Duplicate literal edit at PC 0x{:X}", edit.pc));
        }
        if !original
            .iter()
            .any(|i| i.pc == edit.pc && i.value.is_some())
        {
            return Err(format!("PC 0x{:X} is not a literal instruction", edit.pc));
        }
    }
    let mut ranges: Vec<_> = deletions.iter().map(|d| (d.start_pc, d.end_pc)).collect();
    ranges.sort_unstable();
    for (index, &(start, stop)) in ranges.iter().enumerate() {
        if start >= stop || !boundaries.contains(&start) || !boundaries.contains(&stop) {
            return Err("Deletion range must use complete instruction boundaries".into());
        }
        if index > 0 && ranges[index - 1].1 > start {
            return Err("Deletion ranges overlap".into());
        }
        if replacements.range(start..stop).next().is_some() {
            return Err("A literal edit lies inside a deleted range".into());
        }
    }
    let inside = |pc| ranges.iter().any(|&(start, stop)| pc > start && pc < stop);
    let mut inserted = BTreeMap::<u32, Vec<&NewInstruction>>::new();
    for insertion in insertions {
        if !boundaries.contains(&insertion.before_pc) || inside(insertion.before_pc) {
            return Err("Insertion PC is not an available instruction boundary".into());
        }
        inserted
            .entry(insertion.before_pc)
            .or_default()
            .extend(&insertion.instructions);
    }
    let mut words = Vec::new();
    let mut relocated = BTreeMap::new();
    let mut labels = BTreeMap::new();
    let mut fixups = Vec::new();
    for instruction in original {
        if !inside(instruction.pc) {
            relocated.insert(instruction.pc, words.len() as u32);
            if let Some(new) = inserted.get(&instruction.pc) {
                let new: Vec<_> = new.iter().map(|i| (*i).clone()).collect();
                emit_new(&new, &mut words, &mut labels, &mut fixups)?;
            }
        }
        if ranges
            .iter()
            .any(|&(start, stop)| instruction.pc >= start && instruction.pc < stop)
        {
            continue;
        }
        if let Some(&value) = replacements.get(&instruction.pc) {
            words.extend(literal_words(value, Some(instruction.word)));
        } else {
            let start = words.len();
            words.extend_from_slice(&instruction.words);
            if let Some(target) = instruction.target_pc {
                fixups.push((start + 1, Fixup::Original(target)));
            }
        }
    }
    relocated.insert(end, words.len() as u32);
    if let Some(new) = inserted.get(&end) {
        let new: Vec<_> = new.iter().map(|i| (*i).clone()).collect();
        emit_new(&new, &mut words, &mut labels, &mut fixups)?;
    }
    resolve(&mut words, fixups, &relocated, &labels)?;
    let bytes = words.iter().flat_map(|w| w.to_le_bytes()).collect();
    Ok(RebuiltCode { bytes, relocated })
}
