//! Export the PC portrait tables and decoded RGBA layers for the static editor.
//! PNG encoding is handled by scripts/prepare-portraits.py using Python's stdlib.
use std::{collections::BTreeMap, env, fs, path::Path, process};
use tos_skit_core::assets::{decode_texture, extract_animation_catalog, parse_pac, parse_skitdata};

fn read(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| format!("{}: {error}", path.display()))
}

fn run() -> Result<(), String> {
    let args: Vec<_> = env::args().collect();
    if args.len() != 4 {
        return Err(
            "Usage: export-portraits /path/to/extracted/R01 /path/to/TOS.exe /path/to/output"
                .into(),
        );
    }
    let root = Path::new(&args[1]);
    let output = Path::new(&args[3]);
    fs::create_dir_all(output).map_err(|error| error.to_string())?;
    let catalog = extract_animation_catalog(&read(Path::new(&args[2]))?)?;
    let names = parse_skitdata(&read(&root.join("PACKBIN/SKITDATA.TOSBIN"))?)?;
    if names.len() != catalog.slots.len() {
        return Err("SKITDATA resource count does not match executable layout".into());
    }
    let mut portraits = BTreeMap::new();
    let mut textures = BTreeMap::new();
    for (slot, name) in names.iter().enumerate() {
        let Some(name) = name else { continue };
        let members = parse_pac(&read(&root.join("PAC/SKIT").join(name.to_uppercase()))?)?;
        for channel in &catalog.slots[slot].channels {
            for frame in &channel.frames {
                if members
                    .get(frame.texture as usize)
                    .is_none_or(Option::is_none)
                {
                    return Err(format!(
                        "Portrait {slot} references missing texture {}",
                        frame.texture
                    ));
                }
            }
        }
        let members: Vec<_> = members
            .into_iter()
            .map(|name| name.map(|name| name.to_lowercase().replace(".totexb_d", ".totexp_p")))
            .collect();
        for name in members.iter().flatten() {
            if textures.contains_key(name) {
                continue;
            }
            let texture =
                decode_texture(&read(&root.join("GLOBAL/SKIT").join(name.to_uppercase()))?)?;
            let raw_name = name.replace(".totexp_p", ".rgba");
            fs::write(output.join(&raw_name), &texture.rgba).map_err(|error| error.to_string())?;
            textures.insert(
                name.clone(),
                serde_json::json!({
                    "file": name.replace(".totexp_p", ".png"), "raw": raw_name,
                    "width": texture.width, "height": texture.height,
                }),
            );
        }
        portraits.insert(name.to_lowercase(), members);
    }
    let manifest = serde_json::json!({
        "version": 1, "names": names, "catalog": catalog,
        "portraits": portraits, "textures": textures,
    });
    fs::write(
        output.join("manifest.json"),
        serde_json::to_vec(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}
