use tos_skit_core::{
    compile, create, inspect,
    skp::{CreateEntry, CreateSpec, Edits, MessageEdit, Token},
    vm::{Deletion, Insertion, LiteralEdit, NewInstruction as I},
};

fn text(value: &str) -> Vec<Token> {
    vec![Token::Text { text: value.into() }]
}
fn sample() -> Vec<u8> {
    create(&CreateSpec {
        instructions: vec![
            I::Literal { value: 1 },
            I::Calculate { opcode: 0 },
            I::Argument,
            I::Native { opcode: 0x59 },
            I::Jump {
                target: "finish".into(),
            },
            I::Label {
                name: "finish".into(),
            },
            I::End,
        ],
        messages: vec![text("Original line."), text("Second line.")],
        entries: vec![CreateEntry {
            kind: 2,
            id: 3000,
            pc: None,
            label: Some("finish".into()),
        }],
        ..Default::default()
    })
    .unwrap()
}

#[test]
fn unchanged_file_reconstructs_exactly() {
    let bytes = sample();
    assert_eq!(compile(&bytes, &Edits::default()).unwrap(), bytes);
}

#[test]
fn longer_text_rebuilds_offsets_preserving_code_and_footer() {
    let bytes = sample();
    let old = inspect(&bytes).unwrap();
    let new_text = "A much longer replacement line. ".repeat(12);
    let result = compile(
        &bytes,
        &Edits {
            messages: vec![MessageEdit {
                index: 0,
                tokens: text(&new_text),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    let new = inspect(&result).unwrap();
    assert_eq!(new.messages[0].text, new_text);
    assert_eq!(new.messages[1].text, "Second line.");
    assert_eq!(
        &result[new.code_offset..new.data_offset],
        &bytes[old.code_offset..old.data_offset]
    );
    assert_eq!(&result[result.len() - 64..], &bytes[bytes.len() - 64..]);
    assert_eq!(result.len() % 64, 0);
    assert!(new.messages[1].offset > old.messages[1].offset);
}

#[test]
fn literal_promotion_relocates_branch_and_entry() {
    let bytes = sample();
    let old = inspect(&bytes).unwrap();
    let result = compile(
        &bytes,
        &Edits {
            literals: vec![LiteralEdit {
                pc: 0,
                value: 123456,
            }],
            ..Default::default()
        },
    )
    .unwrap();
    let new = inspect(&result).unwrap();
    assert_eq!(new.instructions[0].value, Some(123456));
    assert_eq!(new.entries[0].pc, old.entries[0].pc + 2);
    let branch = new
        .instructions
        .iter()
        .find(|i| i.target_pc.is_some())
        .unwrap();
    assert_eq!(branch.target_pc, Some(new.entries[0].pc));
    assert_eq!(new.messages[0].text, old.messages[0].text);
}

#[test]
fn insertion_and_deletion_relocate_existing_targets() {
    let bytes = sample();
    let old = inspect(&bytes).unwrap();
    let finish = old.entries[0].pc;
    let result = compile(
        &bytes,
        &Edits {
            insertions: vec![Insertion {
                before_pc: finish,
                instructions: vec![
                    I::Literal { value: 9 },
                    I::Calculate { opcode: 0 },
                    I::Argument,
                    I::Native { opcode: 0x59 },
                ],
            }],
            ..Default::default()
        },
    )
    .unwrap();
    let new = inspect(&result).unwrap();
    assert_eq!(new.entries[0].pc, finish);
    assert_eq!(
        new.instructions
            .iter()
            .find(|i| i.pc == finish)
            .unwrap()
            .value,
        Some(9)
    );
    let erased = compile(
        &result,
        &Edits {
            deletions: vec![Deletion {
                start_pc: finish,
                end_pc: finish + 4,
            }],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(erased, bytes);
}

#[test]
fn deleting_incoming_target_interior_is_rejected() {
    let bytes = sample();
    let doc = inspect(&bytes).unwrap();
    let err = compile(
        &bytes,
        &Edits {
            deletions: vec![Deletion {
                start_pc: 0,
                end_pc: doc.entries[0].pc + 1,
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.contains("entry") || err.contains("Entry"));
}

#[test]
fn append_messages_keeps_original_ids_and_tail() {
    let bytes = sample();
    let result = compile(
        &bytes,
        &Edits {
            messages: vec![MessageEdit {
                index: 2,
                tokens: text("New line."),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    let doc = inspect(&result).unwrap();
    assert_eq!(doc.messages.len(), 3);
    assert_eq!(doc.messages[0].text, "Original line.");
    assert_eq!(doc.messages[2].text, "New line.");
    assert_eq!(result.len() % 64, 0);
}

#[test]
fn malformed_ranges_and_bad_edits_fail_cleanly() {
    let bytes = sample();
    for size in 0..64 {
        assert!(inspect(&bytes[..size]).is_err());
    }
    let mut corrupt = bytes.clone();
    corrupt[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(inspect(&corrupt).is_err());
    assert!(compile(
        &bytes,
        &Edits {
            literals: vec![LiteralEdit { pc: 2, value: 2 }],
            ..Default::default()
        }
    )
    .is_err());
    assert!(compile(
        &bytes,
        &Edits {
            messages: vec![MessageEdit {
                index: 0,
                tokens: text("bad\0text")
            }],
            ..Default::default()
        }
    )
    .is_err());
    assert!(compile(
        &bytes,
        &Edits {
            messages: vec![MessageEdit {
                index: 0,
                tokens: text("Unencoded é")
            }],
            ..Default::default()
        }
    )
    .is_err());
}

#[test]
fn branch_overflow_is_reported() {
    let mut code = vec![I::Jump {
        target: "late".into(),
    }];
    code.extend((0..65536).map(|_| I::Literal { value: 0 }));
    code.push(I::Label {
        name: "late".into(),
    });
    code.push(I::End);
    assert!(create(&CreateSpec {
        instructions: code,
        ..Default::default()
    })
    .unwrap_err()
    .contains("16-bit"));
}

#[test]
fn unknown_json_fields_are_rejected() {
    assert!(serde_json::from_str::<Edits>(r#"{"mesages":[]}"#).is_err());
}

#[test]
fn embedded_zeros_and_escape_prefixed_expressions_are_protected() {
    for prefix in [vec![1], vec![0x1f, 1]] {
        let mut body = b"Hello ".to_vec();
        body.extend(prefix);
        body.extend([1, 0, 0, 0x30, 0xff, 0x20]);
        body.extend(b" world");
        let mut bytes = create(&CreateSpec {
            instructions: vec![I::End],
            messages: vec![text(&"X".repeat(body.len()))],
            ..Default::default()
        })
        .unwrap();
        let offset = inspect(&bytes).unwrap().messages[0].offset;
        bytes[offset..offset + body.len()].copy_from_slice(&body);
        let doc = inspect(&bytes).unwrap();
        assert!(doc.messages[0].editable);
        assert_eq!(doc.messages[0].text, "Hello  world");
        let mut tokens = doc.messages[0].tokens.clone();
        assert_eq!(tokens.len(), 3);
        tokens[0] = Token::Text {
            text: "Welcome, ".into(),
        };
        let rebuilt = compile(
            &bytes,
            &Edits {
                messages: vec![MessageEdit {
                    index: 0,
                    tokens: tokens.clone(),
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let next = inspect(&rebuilt).unwrap();
        assert_eq!(next.messages[0].text, "Welcome,  world");
        assert_eq!(next.messages[0].tokens[1], tokens[1]);
        tokens.remove(1);
        assert!(compile(
            &bytes,
            &Edits {
                messages: vec![MessageEdit { index: 0, tokens }],
                ..Default::default()
            }
        )
        .unwrap_err()
        .contains("protected"));
    }
}

#[test]
fn zero_table_placeholder_is_lossless_and_structural_growth_is_aligned() {
    let bytes = create(&CreateSpec {
        instructions: vec![I::Literal { value: 1 }, I::Calculate { opcode: 0 }, I::End],
        ..Default::default()
    })
    .unwrap();
    let doc = inspect(&bytes).unwrap();
    assert!(doc.messages.is_empty());
    assert_eq!(compile(&bytes, &Edits::default()).unwrap(), bytes);
    let changed = compile(
        &bytes,
        &Edits {
            literals: vec![LiteralEdit {
                pc: 0,
                value: 123456,
            }],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(changed.len() % 64, 0);
}

#[test]
fn malformed_escaped_expression_is_readonly_and_preserved() {
    let mut bytes = create(&CreateSpec {
        instructions: vec![I::End],
        messages: vec![text("XXXXXXXXXX")],
        ..Default::default()
    })
    .unwrap();
    let offset = inspect(&bytes).unwrap().messages[0].offset;
    // A truncated s32 operand after an escaped expression control must not
    // expose its embedded zero bytes as a message terminator.
    bytes[offset..offset + 10].copy_from_slice(&[0x1f, 1, 0, 2, 0, 0, 0, 0, 0, 0]);
    assert!(!inspect(&bytes).unwrap().messages[0].editable);
    assert_eq!(compile(&bytes, &Edits::default()).unwrap(), bytes);
    assert!(compile(
        &bytes,
        &Edits {
            messages: vec![MessageEdit {
                index: 0,
                tokens: text("replacement")
            }],
            ..Default::default()
        }
    )
    .is_err());
}

#[test]
fn text_cannot_change_an_original_encoded_character_boundary() {
    let mut bytes = create(&CreateSpec {
        instructions: vec![I::End],
        messages: vec![text("X")],
        ..Default::default()
    })
    .unwrap();
    let offset = inspect(&bytes).unwrap().messages[0].offset;
    bytes[offset] = 0x81; // Incomplete encoded character, preserved as one byte.
    let mut tokens = inspect(&bytes).unwrap().messages[0].tokens.clone();
    tokens.push(Token::Text { text: "A".into() });
    let error = compile(
        &bytes,
        &Edits {
            messages: vec![MessageEdit { index: 0, tokens }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(error.contains("token boundary"));
    assert_eq!(compile(&bytes, &Edits::default()).unwrap(), bytes);
}

#[test]
fn unknown_registry_kind_blocks_code_relocation_but_keeps_text_editable() {
    let mut bytes = sample();
    let scenario = inspect(&bytes).unwrap().scenario_offset;
    bytes[scenario + 8..scenario + 12].copy_from_slice(&99u32.to_le_bytes());
    assert!(!inspect(&bytes).unwrap().code_editable);
    assert_eq!(compile(&bytes, &Edits::default()).unwrap(), bytes);
    assert!(compile(
        &bytes,
        &Edits {
            literals: vec![LiteralEdit {
                pc: 0,
                value: 500000
            }],
            ..Default::default()
        }
    )
    .is_err());
    assert!(compile(
        &bytes,
        &Edits {
            messages: vec![MessageEdit {
                index: 0,
                tokens: text("Text remains editable")
            }],
            ..Default::default()
        }
    )
    .is_ok());
}

#[test]
fn unknown_record_suffix_survives_text_growth_exactly() {
    let mut bytes = sample();
    // Make the footer deliberately noncanonical so it must remain opaque.
    let last = bytes.len() - 1;
    bytes[last] = 0x91;
    let old = inspect(&bytes).unwrap();
    let tail = bytes[old.messages[1].offset..].to_vec();
    let result = compile(
        &bytes,
        &Edits {
            messages: vec![MessageEdit {
                index: 0,
                tokens: text(&"longer ".repeat(100)),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    let new = inspect(&result).unwrap();
    assert_eq!(&result[new.messages[1].offset..], tail);
    assert_eq!(
        &result[new.code_offset..new.data_offset],
        &bytes[old.code_offset..old.data_offset]
    );
}

#[test]
fn forced_frames_reject_values_that_would_truncate_on_export() {
    let bytes = sample();
    let override_code = |frame| {
        let mut code = Vec::new();
        for value in [1, 64, frame] {
            code.extend([
                I::Literal { value },
                I::Calculate { opcode: 0 },
                I::Argument,
            ]);
        }
        code.push(I::Native { opcode: 0x1d });
        code
    };
    for frame in [-2, 256, 999] {
        let error = compile(
            &bytes,
            &Edits {
                insertions: vec![Insertion {
                    before_pc: 0,
                    instructions: override_code(frame),
                }],
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(error.contains("Forced animation frame"));
    }
    for frame in [-1, 0, 255] {
        assert!(compile(
            &bytes,
            &Edits {
                insertions: vec![Insertion {
                    before_pc: 0,
                    instructions: override_code(frame)
                }],
                ..Default::default()
            }
        )
        .is_ok());
    }
}

#[test]
fn truncated_scenarios_and_hostile_header_fields_never_panic() {
    let source = sample();
    for size in 64..source.len() {
        let mut bytes = source[..size].to_vec();
        bytes[8..12].copy_from_slice(&((size - 64) as u32).to_le_bytes());
        let result = std::panic::catch_unwind(|| {
            if inspect(&bytes).is_ok() {
                let _ = compile(&bytes, &Edits::default());
            }
        });
        assert!(result.is_ok(), "panic for truncated length {size}");
    }
    for offset in [4, 8, 64, 66, 68, 70, 80, 88] {
        for value in [0u32, 1, 0x7fffffff, 0xffffffff] {
            let mut bytes = source.clone();
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert!(std::panic::catch_unwind(|| {
                let _ = compile(&bytes, &Edits::default());
            })
            .is_ok());
        }
    }
}

#[test]
fn reachable_fallthrough_into_message_data_is_rejected() {
    let error = create(&CreateSpec {
        instructions: vec![I::Literal { value: 1 }],
        messages: vec![text("Data is not code")],
        ..Default::default()
    })
    .unwrap_err();
    assert!(error.contains("falls outside"));
    // Retail scripts can contain inert words after a return/end; retain them.
    let bytes = create(&CreateSpec {
        instructions: vec![I::End, I::Literal { value: 0 }],
        ..Default::default()
    })
    .unwrap();
    assert_eq!(compile(&bytes, &Edits::default()).unwrap(), bytes);
    // A conditional branch has a fallthrough edge even if its target is safe.
    assert!(create(&CreateSpec {
        instructions: vec![
            I::Label {
                name: "start".into()
            },
            I::BranchFalse {
                target: "start".into()
            }
        ],
        ..Default::default()
    })
    .is_err());
}
