//! Read-only corpus checker. Pass a local extracted CHT directory; game assets
//! are deliberately neither copied into the project nor embedded in tests.
use std::{
    env, fs,
    path::{Path, PathBuf},
    process,
};
use tos_skit_core::{
    compile, inspect,
    skp::{MessageEdit, Token},
    vm::LiteralEdit,
    Edits,
};

fn collect(path: &Path, paths: &mut Vec<PathBuf>) -> Result<(), String> {
    for item in fs::read_dir(path).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let path = item.path();
        if path.is_dir() {
            collect(&path, paths)?;
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("skp"))
        {
            paths.push(path);
        }
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let path = env::args()
        .nth(1)
        .ok_or("Usage: skit-corpus /path/to/extracted/CHT")?;
    let mut paths = Vec::new();
    collect(Path::new(&path), &mut paths)?;
    paths.sort();
    if paths.is_empty() {
        return Err("No SKP files found".into());
    }
    let mut messages = 0;
    let mut readonly = 0;
    let mut warnings = 0;
    let mut instructions = 0;
    let exercise = env::args().any(|a| a == "--exercise-edits");
    let mut text_edits = 0;
    let mut relocations = 0;
    for path in &paths {
        let data = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let doc = inspect(&data).map_err(|e| format!("{}: {e}", path.display()))?;
        if env::args().any(|a| a == "--diagnostics") {
            for diagnostic in &doc.diagnostics {
                eprintln!("{}: {}", path.display(), diagnostic.message);
            }
        }
        let rebuilt =
            compile(&data, &Edits::default()).map_err(|e| format!("{}: {e}", path.display()))?;
        if rebuilt != data {
            return Err(format!(
                "{} failed byte-exact reconstruction",
                path.display()
            ));
        }
        if exercise {
            if let Some(message) = doc.messages.iter().find(|m| m.editable) {
                let mut tokens = message.tokens.clone();
                if let Some(Token::Text { text }) = tokens.last_mut() {
                    text.push_str(&" Expanded corpus validation text.".repeat(8));
                } else {
                    tokens.push(Token::Text {
                        text: " Expanded corpus validation text.".repeat(8),
                    });
                }
                let edited = compile(
                    &data,
                    &Edits {
                        messages: vec![MessageEdit {
                            index: message.index,
                            tokens: tokens.clone(),
                        }],
                        ..Default::default()
                    },
                )?;
                let reopened = inspect(&edited)?;
                if reopened.messages[message.index].tokens != tokens {
                    return Err(format!(
                        "{} failed edited-token preservation",
                        path.display()
                    ));
                }
                for old in doc.messages.iter().filter(|m| m.index != message.index) {
                    if reopened.messages[old.index].tokens != old.tokens {
                        return Err(format!("{} changed an unrelated message", path.display()));
                    }
                }
                if edited.len() % 64 != 0 {
                    return Err("Text growth lost retail container alignment".into());
                }
                text_edits += 1;
            }
            if doc.code_editable {
                if let Some(literal) = doc
                    .instructions
                    .iter()
                    .find(|i| i.value.is_some() && i.words.len() < 3)
                {
                    let edited = compile(
                        &data,
                        &Edits {
                            literals: vec![LiteralEdit {
                                pc: literal.pc,
                                value: 123456,
                            }],
                            ..Default::default()
                        },
                    )?;
                    let reopened = inspect(&edited)?;
                    if !reopened.code_editable {
                        return Err("Literal growth failed target relocation".into());
                    }
                    if edited.len() % 64 != 0 {
                        return Err("Code growth lost retail container alignment".into());
                    }
                    relocations += 1;
                }
            }
        }
        messages += doc.messages.len();
        readonly += doc.messages.iter().filter(|m| !m.editable).count();
        warnings += doc.diagnostics.len();
        instructions += doc.instructions.len();
    }
    println!(
        "{}",
        serde_json::json!({"files":paths.len(),"exact":paths.len(),"messages":messages,"readOnlyMessages":readonly,"instructions":instructions,"warnings":warnings,"textGrowthChecks":text_edits,"codeRelocationChecks":relocations})
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}
