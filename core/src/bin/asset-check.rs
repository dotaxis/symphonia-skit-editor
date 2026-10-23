//! Validate user-provided preview assets without copying or changing them.
use std::{env, fs, path::Path, process};
use tos_skit_core::assets::*;

fn read(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| format!("{}: {error}", path.display()))
}

fn run() -> Result<(), String> {
    let args: Vec<_> = env::args().collect();
    if !(3..=4).contains(&args.len()) {
        return Err(
            "Usage: asset-check /path/to/extracted/R01 /path/to/TOS.exe [/path/to/VOICE_JP]".into(),
        );
    }
    let root = Path::new(&args[1]);
    let catalog = extract_animation_catalog(&read(Path::new(&args[2]))?)?;
    let resources = parse_skitdata(&read(&root.join("PACKBIN/SKITDATA.TOSBIN"))?)?;
    if resources.len() != catalog.slots.len() {
        return Err("SKITDATA resource count does not match executable layout".into());
    }
    let mut pac_count = 0;
    for (slot, name) in resources.iter().enumerate() {
        let Some(name) = name else { continue };
        let members = parse_pac(&read(&root.join("PAC/SKIT").join(name.to_uppercase()))?)?;
        for channel in &catalog.slots[slot].channels {
            for frame in &channel.frames {
                if frame.texture as usize >= members.len() {
                    return Err(format!(
                        "Portrait {slot} references missing PAC texture {}",
                        frame.texture
                    ));
                }
            }
        }
        for name in members.iter().flatten() {
            let stem = name.to_uppercase().replace(".TOTEXB_D", ".TOTEXP_P");
            if !root.join("GLOBAL/SKIT").join(&stem).is_file() {
                return Err(format!("Portrait {slot} is missing {stem}"));
            }
        }
        pac_count += 1;
    }
    let mut texture_count = 0;
    let mut pixels = 0u64;
    for entry in fs::read_dir(root.join("GLOBAL/SKIT")).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("totexp_p"))
        {
            continue;
        }
        let texture =
            decode_texture(&read(&path)?).map_err(|e| format!("{}: {e}", path.display()))?;
        pixels += texture.width as u64 * texture.height as u64;
        texture_count += 1;
    }
    let mut bank_count = 0;
    let mut clip_count = 0;
    let mut audio_seconds = 0.0f64;
    if let Some(audio_root) = args.get(3) {
        for name in ["CHT_COMMON.AWB", "CHT_DISC_1.AWB", "CHT_DISC_2.AWB"] {
            let bank = read(&Path::new(audio_root).join(name))?;
            for entry in parse_awb(&bank)? {
                let start = entry.offset as usize;
                let audio = decode_adx(&bank[start..start + entry.size as usize])
                    .map_err(|e| format!("{name} member {}: {e}", entry.id))?;
                if audio.pcm.iter().any(|value| !value.is_finite()) {
                    return Err(format!(
                        "Nonfinite decoded sample: {name} member {}",
                        entry.id
                    ));
                }
                audio_seconds +=
                    audio.pcm.len() as f64 / audio.channels as f64 / audio.sample_rate as f64;
                clip_count += 1;
            }
            bank_count += 1;
        }
    }
    println!(
        "{}",
        serde_json::json!({
            "animationSlots": catalog.slots.len(), "portraitManifests": pac_count,
            "texturesDecoded": texture_count, "pixelsDecoded": pixels,
            "voiceBanks": bank_count, "voiceClipsDecoded": clip_count,
            "audioSeconds": audio_seconds,
            "audioFidelity": "preview predictor; not a bit-exact reproduction of the game mixer"
        })
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}
