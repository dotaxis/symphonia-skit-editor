//! Lossless PC SKP container and message editing. English text is editable;
//! embedded expressions and bytes outside the ASCII repertoire are protected.
use crate::vm;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_MESSAGE_RECORDS: usize = 65_536;
const MAX_DECODED_TOKENS: usize = 65_536;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Token {
    Text { text: String },
    Protected { hex: String, label: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub kind: u32,
    pub id: u32,
    pub pc: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub index: usize,
    pub offset: usize,
    pub byte_length: usize,
    pub editable: bool,
    pub tokens: Vec<Token>,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pc: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub format: String,
    pub version: u32,
    pub byte_length: usize,
    pub scenario_offset: usize,
    pub scenario_size: usize,
    /// Absolute file offsets; instruction PCs remain relative word offsets.
    pub code_offset: usize,
    pub data_offset: usize,
    pub default_pc: u32,
    pub code_editable: bool,
    pub entries: Vec<Entry>,
    pub messages: Vec<Message>,
    pub instructions: Vec<vm::Instruction>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edits {
    #[serde(default)]
    pub messages: Vec<MessageEdit>,
    #[serde(default)]
    pub literals: Vec<vm::LiteralEdit>,
    #[serde(default)]
    pub insertions: Vec<vm::Insertion>,
    #[serde(default)]
    pub deletions: Vec<vm::Deletion>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageEdit {
    pub index: usize,
    pub tokens: Vec<Token>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSpec {
    pub instructions: Vec<vm::NewInstruction>,
    #[serde(default)]
    pub messages: Vec<Vec<Token>>,
    #[serde(default)]
    pub entries: Vec<CreateEntry>,
    #[serde(default)]
    pub default_pc: u32,
    #[serde(default)]
    pub default_label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateEntry {
    pub kind: u32,
    pub id: u32,
    #[serde(default)]
    pub pc: Option<u32>,
    #[serde(default)]
    pub label: Option<String>,
}

struct Record {
    raw: Vec<u8>,
    terminator: Option<usize>,
}

struct Parsed {
    document: Document,
    records: Vec<Record>,
    table_recognized: bool,
    code_valid: bool,
    code_base: usize,
    auxiliary: usize,
    canonical_tail: bool,
}

fn u16_at(data: &[u8], at: usize) -> Result<u16, String> {
    let b = data
        .get(at..at.checked_add(2).ok_or("Offset overflow")?)
        .ok_or("Truncated 16-bit field")?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}
fn u32_at(data: &[u8], at: usize) -> Result<u32, String> {
    let b = data
        .get(at..at.checked_add(4).ok_or("Offset overflow")?)
        .ok_or("Truncated 32-bit field")?;
    Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}
fn write_u16(out: &mut [u8], at: usize, value: usize) -> Result<(), String> {
    let value =
        u16::try_from(value).map_err(|_| "Scenario header or PC exceeds the 16-bit word limit")?;
    out.get_mut(at..at + 2)
        .ok_or("Invalid output header")?
        .copy_from_slice(&value.to_le_bytes());
    Ok(())
}
fn write_u32(out: &mut [u8], at: usize, value: usize) -> Result<(), String> {
    let value = u32::try_from(value).map_err(|_| "File or data offset exceeds 32 bits")?;
    out.get_mut(at..at + 4)
        .ok_or("Invalid output header")?
        .copy_from_slice(&value.to_le_bytes());
    Ok(())
}
fn footer() -> [u8; 64] {
    let mut f = [0xfe; 64];
    f[..8].copy_from_slice(&[1, 0, 0, 0, 0, 0, 0, 0]);
    f
}
fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return Err("Protected token contains invalid hex".into());
    }
    (0..text.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&text[i..i + 2], 16)
                .map_err(|_| "Protected token contains invalid hex".into())
        })
        .collect()
}
fn warning(message: impl Into<String>) -> Diagnostic {
    Diagnostic {
        severity: "warning".into(),
        message: message.into(),
        pc: None,
    }
}

/// Find an expression's terminator by decoding words, not by searching for a
/// zero byte or for FF20 inside the operand of an unrelated instruction.
fn expression_length(data: &[u8]) -> Option<usize> {
    let mut at = 0;
    while at + 2 <= data.len() {
        let word = u16::from_le_bytes([data[at], data[at + 1]]);
        if word == 0x20ff {
            return Some(at + 2);
        }
        let length = match word {
            0x0000..=0x00ff | 0x3000..=0x30ff | 0x4000 => 2,
            0x0100 | 0x0300 | 0x1000 | 0x1100 | 0x1200 => 4,
            0x0200 => 6,
            // Message expressions may invoke native value-producing helpers.
            0x200a..=0x20fe => 2,
            _ => return None,
        };
        at = at.checked_add(length)?;
    }
    None
}
fn is_control(byte: u8) -> bool {
    matches!(byte, 1..=9 | 0x11 | 0x12)
}
fn control_label(byte: u8) -> String {
    match byte {
        1 => "Character name",
        4 => "String reference",
        5 => "Number",
        9 => "Voice or formatting",
        0x11 => "Item or title name",
        0x12 => "Arte name",
        _ => "Formatting",
    }
    .into()
}

fn opaque_record(body: &[u8], label: &str) -> (Vec<Token>, Option<usize>, bool) {
    (
        vec![Token::Protected {
            hex: hex(body),
            label: label.into(),
        }],
        None,
        false,
    )
}

fn parse_tokens(body: &[u8], token_budget: usize) -> (Vec<Token>, Option<usize>, bool) {
    let mut tokens = Vec::new();
    let mut cursor = 0;
    let mut text = String::new();
    fn flush(text: &mut String, tokens: &mut Vec<Token>) {
        if !text.is_empty() {
            tokens.push(Token::Text {
                text: std::mem::take(text),
            });
        }
    }
    while cursor < body.len() {
        // Binary-looking records must not expand into millions of separately
        // allocated token strings. Preserve the entire record when the shared
        // inspection budget is exhausted, and keep it read-only.
        if tokens.len() >= token_budget {
            return opaque_record(body, "Record exceeds detailed inspection limit");
        }
        let byte = body[cursor];
        if byte == 0 {
            flush(&mut text, &mut tokens);
            return (tokens, Some(cursor), true);
        }
        if (0x20..=0x7e).contains(&byte) || matches!(byte, b'\n' | b'\r') {
            text.push(byte as char);
            cursor += 1;
            continue;
        }
        flush(&mut text, &mut tokens);
        let (prefix, control) =
            if byte == 0x1f && cursor + 1 < body.len() && is_control(body[cursor + 1]) {
                (2, body[cursor + 1])
            } else {
                (1, byte)
            };
        if is_control(control) {
            if let Some(length) = expression_length(&body[cursor + prefix..]) {
                let end = cursor + prefix + length;
                tokens.push(Token::Protected {
                    hex: hex(&body[cursor..end]),
                    label: control_label(control),
                });
                cursor = end;
                continue;
            }
            // Once a recognized expression prefix was encountered, embedded
            // zero operands cannot safely be reinterpreted as text terminators.
            return opaque_record(body, "Unrecognized message record");
        }
        let size = if cursor + 1 < body.len()
            && (byte == 0x1f || (matches!(byte,0x81..=0x9f|0xe0..=0xfc) && body[cursor + 1] != 0))
        {
            2
        } else {
            1
        };
        tokens.push(Token::Protected {
            hex: hex(&body[cursor..cursor + size]),
            label: if byte >= 128 {
                "Original encoded character"
            } else {
                "Original control byte"
            }
            .into(),
        });
        cursor += size;
    }
    (tokens, None, false)
}

fn parse(data: &[u8]) -> Result<Parsed, String> {
    if data.len() > MAX_FILE_BYTES {
        return Err("Skit exceeds the 16 MB editing limit".into());
    }
    if data.len() < 0x40 {
        return Err("File is shorter than the PC SKP header".into());
    }
    if u32_at(data, 0)? != 2 {
        return Err("Expected a little-endian PC version-2 SKP file".into());
    }
    let base = u32_at(data, 4)? as usize;
    let size = u32_at(data, 8)? as usize;
    if base < 0x40 || base.checked_add(size) != Some(data.len()) {
        return Err("SKP scenario range does not match the file length".into());
    }
    let payload = data.get(base..).ok_or("Invalid scenario offset")?;
    if payload.len() < 8 {
        return Err("Scenario header is truncated".into());
    }
    let c = usize::from(u16_at(payload, 0)?) * 2;
    let a = usize::from(u16_at(payload, 4)?) * 2;
    let count = usize::from(u16_at(payload, 6)?);
    let default_pc = u32::from(u16_at(payload, 2)?);
    let registry_end = 8usize
        .checked_add(count.checked_mul(12).ok_or("Registry overflow")?)
        .ok_or("Registry overflow")?;
    if c < registry_end || c > a || a > payload.len() {
        return Err("Invalid code, registry, or data-table boundaries".into());
    }
    let mut entries = Vec::new();
    for index in 0..count {
        let at = 8 + 12 * index;
        entries.push(Entry {
            kind: u32_at(payload, at)?,
            id: u32_at(payload, at + 4)?,
            pc: u32_at(payload, at + 8)?,
        });
    }
    let mut diagnostics = Vec::new();
    let (instructions, mut code_valid) = match vm::decode(&payload[c..a]) {
        Ok(i) => (i, true),
        Err(error) => {
            diagnostics.push(warning(format!("Code remains read-only: {error}")));
            (Vec::new(), false)
        }
    };
    if code_valid {
        let roots: Vec<_> = std::iter::once(default_pc)
            .chain(
                entries
                    .iter()
                    .filter(|e| matches!(e.kind, 1 | 2))
                    .map(|e| e.pc),
            )
            .collect();
        if let Err(error) = vm::validate_targets(&instructions, &roots) {
            diagnostics.push(warning(format!("Code remains read-only: {error}")));
            code_valid = false;
        }
    }
    if entries.iter().any(|entry| !matches!(entry.kind, 1 | 2)) {
        diagnostics.push(warning(
            "Code remains read-only: an unknown registry entry kind may contain a relocatable PC",
        ));
        code_valid = false;
    }
    let mut messages = Vec::new();
    let mut records = Vec::new();
    let mut table_recognized = false;
    if let Ok(first) = u32_at(payload, a) {
        let first = first as usize;
        let region = &payload[a..];
        if first > 0 && first.is_multiple_of(4) && first <= region.len() {
            let n = first / 4;
            if n > MAX_MESSAGE_RECORDS {
                return Err("Message table exceeds the supported record limit".into());
            }
            let offsets: Result<Vec<_>, _> = (0..n)
                .map(|i| u32_at(region, 4 * i).map(|o| o as usize))
                .collect();
            let offsets = offsets?;
            if offsets.iter().all(|&o| o >= first && o < region.len())
                && offsets.windows(2).all(|w| w[0] <= w[1])
            {
                table_recognized = true;
                let mut token_budget = MAX_DECODED_TOKENS;
                for index in 0..n {
                    let start = offsets[index];
                    let end = offsets.get(index + 1).copied().unwrap_or(region.len());
                    let body = &region[start..end];
                    let (tokens, terminator, editable) = parse_tokens(body, token_budget);
                    token_budget = token_budget.saturating_sub(tokens.len());
                    if !editable {
                        diagnostics.push(warning(format!(
                            "Message {index} has unrecognized controls and remains read-only"
                        )));
                    }
                    let text = tokens
                        .iter()
                        .filter_map(|token| {
                            if let Token::Text { text } = token {
                                Some(text.as_str())
                            } else {
                                None
                            }
                        })
                        .collect();
                    messages.push(Message {
                        index,
                        offset: base + a + start,
                        byte_length: body.len(),
                        editable,
                        tokens,
                        text,
                    });
                    records.push(Record {
                        raw: body.to_vec(),
                        terminator,
                    });
                }
            }
        }
    }
    if !table_recognized {
        diagnostics.push(warning(
            "No recognized message table; auxiliary bytes are preserved unchanged",
        ));
    }
    let canonical_tail = records.last().is_some_and(|r| {
        r.terminator.is_some_and(|t| {
            let suffix = &r.raw[t + 1..];
            suffix.len() >= 64
                && suffix[suffix.len() - 64..] == footer()
                && suffix[..suffix.len() - 64].iter().all(|&b| b == 0)
        })
    });
    Ok(Parsed {
        document: Document {
            format: "tos-pc-skp".into(),
            version: 1,
            byte_length: data.len(),
            scenario_offset: base,
            scenario_size: size,
            code_offset: base + c,
            data_offset: base + a,
            default_pc,
            code_editable: code_valid,
            entries,
            messages,
            instructions,
            diagnostics,
        },
        records,
        table_recognized,
        code_valid,
        code_base: c,
        auxiliary: a,
        canonical_tail,
    })
}

pub fn inspect(data: &[u8]) -> Result<Document, String> {
    Ok(parse(data)?.document)
}

fn protected(tokens: &[Token]) -> Vec<&str> {
    tokens
        .iter()
        .filter_map(|t| match t {
            Token::Protected { hex, .. } => Some(hex.as_str()),
            _ => None,
        })
        .collect()
}
fn encode_tokens(tokens: &[Token]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for token in tokens {
        match token {
            Token::Text { text } => {
                if !text
                    .bytes()
                    .all(|b| (0x20..=0x7e).contains(&b) || matches!(b, b'\n' | b'\r'))
                {
                    return Err("Editable text supports printable English ASCII and line breaks; preserve other characters as original tokens".into());
                }
                out.extend_from_slice(text.as_bytes());
            }
            Token::Protected { hex, .. } => out.extend(unhex(hex)?),
        }
    }
    Ok(out)
}

fn pack_records(records: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    let mut out = vec![
        0;
        records
            .len()
            .checked_mul(4)
            .ok_or("Message table overflow")?
    ];
    for (index, record) in records.iter().enumerate() {
        let offset = out.len();
        write_u32(&mut out, index * 4, offset)?;
        out.extend_from_slice(record);
    }
    Ok(out)
}
fn append_footer(out: &mut Vec<u8>) {
    let pad = (64 - out.len() % 64) % 64;
    out.resize(out.len() + pad, 0);
    out.extend_from_slice(&footer());
}

pub fn compile(data: &[u8], edits: &Edits) -> Result<Vec<u8>, String> {
    let parsed = parse(data)?;
    let doc = &parsed.document;
    let structural =
        !edits.literals.is_empty() || !edits.insertions.is_empty() || !edits.deletions.is_empty();
    if structural && !parsed.code_valid {
        return Err(
            "Structural editing requires fully decoded code and valid branch targets".into(),
        );
    }
    if !edits.messages.is_empty() && !parsed.table_recognized {
        return Err("Cannot edit an unrecognized message table".into());
    }
    let mut output = data[..doc.scenario_offset + parsed.code_base].to_vec();
    let payload = &data[doc.scenario_offset..];
    if structural {
        let rebuilt = vm::rebuild(
            &doc.instructions,
            &edits.literals,
            &edits.insertions,
            &edits.deletions,
        )?;
        let new_default = *rebuilt
            .relocated
            .get(&doc.default_pc)
            .ok_or("Default entry lies inside deleted code")?;
        write_u16(&mut output, doc.scenario_offset + 2, new_default as usize)?;
        let mut roots = vec![new_default];
        for (index, entry) in doc.entries.iter().enumerate() {
            if matches!(entry.kind, 1 | 2) {
                let pc = *rebuilt
                    .relocated
                    .get(&entry.pc)
                    .ok_or("Registered entry lies inside deleted code")?;
                write_u32(
                    &mut output,
                    doc.scenario_offset + 8 + 12 * index + 8,
                    pc as usize,
                )?;
                roots.push(pc);
            }
        }
        let instructions = vm::decode(&rebuilt.bytes)?;
        vm::validate_targets(&instructions, &roots)?;
        vm::validate_forced_frame_literals(&instructions)?;
        output.extend(rebuilt.bytes);
    } else {
        output.extend_from_slice(&payload[parsed.code_base..parsed.auxiliary]);
    }
    let new_auxiliary = output.len() - doc.scenario_offset;
    if !new_auxiliary.is_multiple_of(2) {
        return Err("Code boundary lost word alignment".into());
    }
    write_u16(&mut output, doc.scenario_offset + 4, new_auxiliary / 2)?;
    if edits.messages.is_empty() && !structural {
        // Reconstruct rather than returning a blind copy, so corpus verification
        // covers the section boundaries consumed by the editor.
        output.extend_from_slice(&payload[parsed.auxiliary..]);
    } else if parsed.table_recognized {
        let mut changes = BTreeMap::new();
        for edit in &edits.messages {
            if changes.insert(edit.index, &edit.tokens).is_some() {
                return Err("Duplicate message edit".into());
            }
        }
        let mut records = Vec::new();
        for (index, record) in parsed.records.iter().enumerate() {
            let mut body = if let Some(tokens) = changes.remove(&index) {
                let message = &doc.messages[index];
                if !message.editable {
                    return Err(format!(
                        "Message {index} contains unrecognized controls and is read-only"
                    ));
                }
                if protected(tokens) != protected(&message.tokens) {
                    return Err(format!(
                        "Message {index}: protected tokens must remain unchanged and in order"
                    ));
                }
                let mut body = encode_tokens(tokens)?;
                body.push(0);
                body.extend_from_slice(
                    &record.raw[record.terminator.ok_or("Missing structural terminator")? + 1..],
                );
                body
            } else {
                record.raw.clone()
            };
            if parsed.canonical_tail && index + 1 == parsed.records.len() {
                let suffix_length =
                    record.raw.len() - record.terminator.ok_or("Missing final terminator")? - 1;
                body.truncate(body.len() - suffix_length);
            }
            records.push(body);
        }
        for (index, tokens) in changes {
            if index != records.len() {
                return Err(
                    "New message IDs must append consecutively after existing messages".into(),
                );
            }
            if !protected(tokens).is_empty() {
                return Err("New messages must use plain text; original control expressions cannot be invented".into());
            }
            let mut body = encode_tokens(tokens)?;
            body.push(0);
            records.push(body);
        }
        output.extend(pack_records(&records)?);
        if parsed.canonical_tail {
            append_footer(&mut output);
        }
    } else {
        let auxiliary = &payload[parsed.auxiliary..];
        if auxiliary.ends_with(&footer()) {
            output.extend_from_slice(&auxiliary[..auxiliary.len() - 64]);
            append_footer(&mut output);
        } else {
            output.extend_from_slice(auxiliary);
        }
    }
    let size = output.len() - doc.scenario_offset;
    write_u32(&mut output, 8, size)?;
    // Parse the result again to check every exported range and table offset.
    let check = parse(&output)?;
    if structural && !check.code_valid {
        return Err("Exported code failed independent parsing".into());
    }
    if parsed.table_recognized && !check.table_recognized {
        return Err("Exported message table failed independent parsing".into());
    }
    // Preserving a protected byte sequence is insufficient if an adjacent text
    // edit changes its token boundary (for example an incomplete encoded
    // character becoming a new two-byte character). Reparse every requested
    // edit and require the intended text and protected tokens to survive.
    for edit in &edits.messages {
        let message = check
            .document
            .messages
            .get(edit.index)
            .ok_or("Exported message is missing")?;
        let expected_text: String = edit
            .tokens
            .iter()
            .filter_map(|token| match token {
                Token::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        if !message.editable
            || protected(&message.tokens) != protected(&edit.tokens)
            || message.text != expected_text
        {
            return Err(format!(
                "Message {}: edit changes a protected token boundary",
                edit.index
            ));
        }
    }
    Ok(output)
}

pub fn create(spec: &CreateSpec) -> Result<Vec<u8>, String> {
    let (code, labels) = vm::assemble(&spec.instructions)?;
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    for entry in &spec.entries {
        if !matches!(entry.kind, 1 | 2) {
            return Err("New registry entries must have kind 1 or 2".into());
        }
        if !seen.insert((entry.kind, entry.id)) {
            return Err("Duplicate entry identifier".into());
        }
        let pc = match (&entry.label, entry.pc) {
            (Some(label), None) => *labels
                .get(label)
                .ok_or_else(|| format!("Undefined entry label {label:?}"))?,
            (None, Some(pc)) => pc,
            _ => return Err("Each entry needs exactly one pc or label".into()),
        };
        entries.push(Entry {
            kind: entry.kind,
            id: entry.id,
            pc,
        });
    }
    let default_pc = if let Some(label) = &spec.default_label {
        *labels
            .get(label)
            .ok_or_else(|| format!("Undefined default label {label:?}"))?
    } else {
        spec.default_pc
    };
    let roots: Vec<_> = std::iter::once(default_pc)
        .chain(entries.iter().map(|e| e.pc))
        .collect();
    vm::validate_targets(&vm::decode(&code)?, &roots)?;
    let c = 8 + 12 * entries.len();
    let a = c
        .checked_add(code.len())
        .ok_or("Scenario length overflow")?;
    let mut output = vec![0xfe; 64];
    write_u32(&mut output, 0, 2)?;
    write_u32(&mut output, 4, 64)?;
    output.resize(64 + c, 0);
    write_u16(&mut output, 64, c / 2)?;
    write_u16(&mut output, 66, default_pc as usize)?;
    write_u16(&mut output, 68, a / 2)?;
    write_u16(&mut output, 70, entries.len())?;
    for (index, entry) in entries.iter().enumerate() {
        let at = 72 + 12 * index;
        write_u32(&mut output, at, entry.kind as usize)?;
        write_u32(&mut output, at + 4, entry.id as usize)?;
        write_u32(&mut output, at + 8, entry.pc as usize)?;
    }
    output.extend(code);
    let mut records = Vec::new();
    for tokens in &spec.messages {
        if !protected(tokens).is_empty() {
            return Err("New messages must use plain text".into());
        }
        let mut body = encode_tokens(tokens)?;
        body.push(0);
        records.push(body);
    }
    if records.is_empty() {
        output.extend_from_slice(&0u32.to_le_bytes());
    } else {
        output.extend(pack_records(&records)?);
    }
    append_footer(&mut output);
    let size = output.len() - 64;
    write_u32(&mut output, 8, size)?;
    let checked = parse(&output)?;
    if !checked.code_valid {
        return Err("Created scenario failed code validation".into());
    }
    Ok(output)
}
