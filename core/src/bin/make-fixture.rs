//! Generate tiny original test scripts. No retail game files are read or copied.
use std::{env, fs, path::PathBuf};
use tos_skit_core::{
    compile, create, inspect,
    skp::{CreateEntry, CreateSpec, Edits, MessageEdit, Token},
    vm::{LiteralEdit, NewInstruction as I},
};

fn call(out: &mut Vec<I>, opcode: u8, args: &[i32]) {
    for &value in args {
        out.extend([
            I::Literal { value },
            I::Calculate { opcode: 0 },
            I::Argument,
        ]);
    }
    out.push(I::Native { opcode });
}
fn text(text: &str) -> Vec<Token> {
    vec![Token::Text { text: text.into() }]
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        env::args()
            .nth(1)
            .ok_or("Usage: make-fixture OUTPUT_DIRECTORY")?,
    );
    fs::create_dir_all(&root)?;
    let mut instructions = Vec::new();
    call(
        &mut instructions,
        0x57,
        &[1, 0, 190, 200, -1, -1, 0, 255, 255, 255, 255, 20, 0xD0000],
    );
    call(
        &mut instructions,
        0x57,
        &[2, 0, 450, 200, -1, -1, 0, 255, 255, 255, 255, 20, 0xD0001],
    );
    call(&mut instructions, 0xf4, &[1, -1, 0]);
    call(&mut instructions, 0xf1, &[1, 0xAE71B]);
    call(&mut instructions, 0x59, &[12]);
    instructions.push(I::Jump {
        target: "second".into(),
    });
    instructions.push(I::Label {
        name: "second".into(),
    });
    call(&mut instructions, 0xf4, &[2, -1, 1]);
    call(&mut instructions, 0xf1, &[2, 0xAE71B]);
    call(&mut instructions, 0x59, &[-1]);
    instructions.push(I::End);
    let protected = b"Speak to \x1f\x01\x01\x00\x00\x30\xff\x20.";
    let mut original = create(&CreateSpec {
        instructions,
        messages: vec![
            text("Hello, synthetic skit."),
            text(&"X".repeat(protected.len())),
        ],
        entries: vec![CreateEntry {
            kind: 2,
            id: 3000,
            pc: None,
            label: Some("second".into()),
        }],
        ..Default::default()
    })?;
    let at = inspect(&original)?.messages[1].offset;
    original[at..at + protected.len()].copy_from_slice(protected);
    let document = inspect(&original)?;
    let grown_text =
        "This original synthetic sentence is intentionally long enough to grow the text region. "
            .repeat(4);
    let speaker = document
        .instructions
        .iter()
        .find(|i| i.native_opcode == Some(0xf1))
        .unwrap()
        .arguments[0]
        .literal_pc
        .unwrap();
    let timing = document
        .instructions
        .iter()
        .find(|i| i.native_opcode == Some(0x59))
        .unwrap()
        .arguments[0]
        .literal_pc
        .unwrap();
    let edits = Edits {
        messages: vec![MessageEdit {
            omit_encoded_characters: false,
            index: 0,
            tokens: text(&grown_text),
        }],
        literals: vec![
            LiteralEdit {
                pc: speaker,
                value: 2,
            },
            LiteralEdit {
                pc: timing,
                value: 300,
            },
        ],
        ..Default::default()
    };
    let edited = compile(&original, &edits)?;
    fs::write(root.join("FC_W001.SKP"), &original)?;
    fs::write(root.join("expected.SKP"), &edited)?;
    fs::write(
        root.join("original.json"),
        serde_json::to_vec_pretty(&document)?,
    )?;
    fs::write(
        root.join("expected.json"),
        serde_json::to_vec_pretty(&inspect(&edited)?)?,
    )?;
    fs::write(root.join("edits.json"), serde_json::to_vec_pretty(&edits)?)?;
    fs::write(
        root.join("meta.json"),
        serde_json::to_vec_pretty(&serde_json::json!({"grownText":grown_text}))?,
    )?;
    println!("{}", root.display());
    Ok(())
}
