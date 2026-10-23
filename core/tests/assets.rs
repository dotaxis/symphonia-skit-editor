use tos_skit_core::assets::*;

fn put16(data: &mut [u8], offset: usize, value: u16) {
    data[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}
fn put32(data: &mut [u8], offset: usize, value: u32) {
    data[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn dds(fourcc: &[u8; 4], width: u32, height: u32, block: &[u8]) -> Vec<u8> {
    let mut data = vec![0; 128];
    data[..4].copy_from_slice(b"DDS ");
    put32(&mut data, 4, 124);
    put32(&mut data, 12, height);
    put32(&mut data, 16, width);
    put32(&mut data, 76, 32);
    data[84..88].copy_from_slice(fourcc);
    data.extend_from_slice(block);
    data
}

#[test]
fn dxt1_color_transparency_and_partial_block() {
    let mut block = vec![0; 8];
    put16(&mut block, 0, 0xf800);
    put16(&mut block, 2, 0x001f);
    // red, blue, 2/3 red, 2/3 blue in the first row.
    put32(&mut block, 4, 0b11_10_01_00);
    let texture = decode_texture(&dds(b"DXT1", 3, 1, &block)).unwrap();
    assert_eq!((texture.width, texture.height), (3, 1));
    assert_eq!(
        texture.rgba,
        [255, 0, 0, 255, 0, 0, 255, 255, 170, 0, 85, 255]
    );
    put16(&mut block, 0, 0);
    put16(&mut block, 2, 0xffff);
    put32(&mut block, 4, 3);
    assert_eq!(
        decode_texture(&dds(b"DXT1", 1, 1, &block)).unwrap().rgba,
        [0, 0, 0, 0]
    );
}

#[test]
fn dxt5_alpha_interpolation_and_wrapper() {
    let mut block = vec![0; 16];
    block[0] = 255;
    block[1] = 0;
    block[2] = 2; // interpolated 6/7 alpha
    put16(&mut block, 8, 0x07e0);
    let data = dds(b"DXT5", 1, 1, &block);
    let mut wrapped = (data.len() as u32).to_le_bytes().to_vec();
    wrapped.extend_from_slice(&data);
    assert_eq!(decode_texture(&wrapped).unwrap().rgba, [0, 255, 0, 218]);
    block[0] = 0;
    block[1] = 255;
    block[2] = 6;
    assert_eq!(
        decode_texture(&dds(b"DXT5", 1, 1, &block)).unwrap().rgba[3],
        0
    );
    block[2] = 7;
    assert_eq!(
        decode_texture(&dds(b"DXT5", 1, 1, &block)).unwrap().rgba[3],
        255
    );
    wrapped[0] ^= 1;
    assert!(decode_texture(&wrapped).is_err());
}

#[test]
fn rejects_truncated_or_excessive_textures() {
    assert!(decode_texture(&[]).is_err());
    assert!(decode_texture(&dds(b"DXT1", 4, 4, &[0; 7])).is_err());
    assert!(decode_texture(&dds(b"DXT1", u32::MAX, u32::MAX, &[0; 8])).is_err());
    assert!(decode_texture(&dds(b"DX10", 4, 4, &[0; 16])).is_err());
}

#[test]
fn manifests_preserve_sparse_resource_ids_and_order() {
    let mut data = vec![0; 16];
    put32(&mut data, 0, 3);
    put32(&mut data, 4, 16);
    put32(&mut data, 12, 26);
    data.extend_from_slice(b"skit0.pac\0skit2.pac\0");
    assert_eq!(
        parse_skitdata(&data).unwrap(),
        [Some("skit0.pac".into()), None, Some("skit2.pac".into())]
    );
    put32(&mut data, 4, 5);
    assert!(parse_skitdata(&data).is_err());
    let mut pac = vec![0; 8];
    put32(&mut pac, 0, 1);
    put32(&mut pac, 4, 8);
    pac.extend_from_slice(b"portrait.TOTEXB_D\0");
    assert_eq!(
        parse_pac(&pac).unwrap()[0].as_deref(),
        Some("portrait.TOTEXB_D")
    );
    pac[8] = b'/';
    assert!(parse_pac(&pac).is_err());
}

fn awb() -> Vec<u8> {
    let mut data = vec![0; 100];
    data[..8].copy_from_slice(b"AFS2\x01\x04\x02\0");
    put32(&mut data, 8, 2);
    put16(&mut data, 12, 32);
    put16(&mut data, 16, 7);
    put16(&mut data, 18, 10);
    put32(&mut data, 20, 32);
    put32(&mut data, 24, 63);
    put32(&mut data, 28, 100);
    data
}

#[test]
fn awb_uses_ids_and_alignment_and_rejects_bad_bounds() {
    let mut data = awb();
    let entries = parse_awb(&data).unwrap();
    assert_eq!(
        (entries[0].id, entries[0].offset, entries[0].size),
        (7, 32, 31)
    );
    assert_eq!(
        (entries[1].id, entries[1].offset, entries[1].size),
        (10, 64, 36)
    );
    put16(&mut data, 18, 7);
    assert!(parse_awb(&data).is_err());
    data = awb();
    put32(&mut data, 28, 101);
    assert!(parse_awb(&data).is_err());
    data = awb();
    put16(&mut data, 14, 1);
    assert!(parse_awb(&data).is_err());
}

fn adx(samples: u32, channels: u8) -> Vec<u8> {
    let mut data = vec![0; 36 + (samples as usize).div_ceil(32) * 18 * channels as usize];
    data[..8].copy_from_slice(&[0x80, 0, 0, 32, 3, 18, 4, channels]);
    data[8..12].copy_from_slice(&48000u32.to_be_bytes());
    data[12..16].copy_from_slice(&samples.to_be_bytes());
    data[16..18].copy_from_slice(&500u16.to_be_bytes());
    data[18] = 3;
    data[30..36].copy_from_slice(b"(c)CRI");
    data
}

#[test]
fn adx_signed_nibbles_sample_count_and_stereo_interleave() {
    let mut data = adx(1, 2);
    data[37] = 3;
    data[38] = 0x70; // (scale+1)*7 = 28
    data[55] = 3;
    data[56] = 0x80; // (scale+1)*-8 = -32
    let audio = decode_adx(&data).unwrap();
    assert_eq!((audio.sample_rate, audio.channels), (48000, 2));
    assert_eq!(audio.pcm, [28.0 / 32768.0, -32.0 / 32768.0]);
    assert_eq!(decode_adx(&adx(33, 1)).unwrap().pcm, vec![0.0; 33]);
}

#[test]
fn adx_rejects_unsupported_versions_encryption_and_short_payloads() {
    let mut data = adx(32, 1);
    data[18] = 4;
    assert!(decode_adx(&data).is_err());
    data[18] = 3;
    data[19] = 8;
    assert!(decode_adx(&data).is_err());
    data[19] = 0;
    data.pop();
    assert!(decode_adx(&data).is_err());
    data = adx(32, 1);
    data[36] = 0x80;
    assert!(decode_adx(&data).is_err());
}

// A synthetic single-section PE containing only invented animation data and
// the short instruction signatures identifying the supported consumer layout.
fn fake_pe() -> Vec<u8> {
    let mut data = vec![0; 0x4c0000 + 0x200];
    data[..2].copy_from_slice(b"MZ");
    put32(&mut data, 0x3c, 0x80);
    data[0x80..0x84].copy_from_slice(b"PE\0\0");
    put16(&mut data, 0x84, 0x14c);
    put16(&mut data, 0x86, 1);
    put16(&mut data, 0x94, 0xe0);
    put16(&mut data, 0x98, 0x10b);
    put32(&mut data, 0xb4, 0x400000);
    put32(&mut data, 0x184, 0x1000);
    put32(&mut data, 0x188, 0x4c0000);
    put32(&mut data, 0x18c, 0x200);
    let at = |va: usize| va - 0x401000 + 0x200;
    data[at(0x5564aa)..at(0x5564aa) + 7].copy_from_slice(&[0x8b, 0x04, 0x85, 0x08, 0x39, 0x8b, 0]);
    data[at(0x55659b)..at(0x55659b) + 5].copy_from_slice(&[0xbf, 3, 0x70, 0, 0]);
    data[at(0x55667f)..at(0x55667f) + 5].copy_from_slice(&[0xbf, 6, 0x70, 0, 0]);
    for i in 0..222 {
        put32(&mut data, at(0x8b3908) + i * 4, 0x8b0000);
    }
    let start = at(0x8b0000);
    put32(&mut data, start, 7);
    put16(&mut data, start + 4, 0x7000);
    put16(&mut data, start + 6, 12); // parameter deliberately NOT a frame count
    put16(&mut data, start + 8, (-3i16) as u16);
    put16(&mut data, start + 10, 4);
    put16(&mut data, start + 12, 8);
    put16(&mut data, start + 14, 1);
    put16(&mut data, start + 20, 0xfd);
    data[start + 24..start + 28].fill(0xfe);
    data
}

#[test]
fn pe_reads_only_validated_animation_data_with_sentinel_termination() {
    let mut data = fake_pe();
    let catalog = extract_animation_catalog(&data).unwrap();
    assert_eq!(catalog.slots.len(), 222);
    assert_eq!(catalog.coordinate_scale, 2);
    let channel = &catalog.slots[10].channels[0];
    assert_eq!(channel.parameter, 12);
    assert_eq!(channel.frames.len(), 1);
    assert_eq!(channel.frames[0].x, -3);
    assert_eq!(channel.ending, "loop");
    put32(&mut data, 0x8b3908 - 0x401000 + 0x200, 0xfffffff0);
    assert!(extract_animation_catalog(&data).is_err());
    let mut data = fake_pe();
    data[0x5564aa - 0x401000 + 0x200] = 0;
    assert!(extract_animation_catalog(&data).is_err());
}

#[test]
#[ignore = "Optional private corpus validation: set TOS_ASSET_ROOT and TOS_EXE; no fixtures are copied"]
fn local_retail_asset_corpus() {
    use std::{fs, path::PathBuf};
    let root = PathBuf::from(
        std::env::var("TOS_ASSET_ROOT").expect("TOS_ASSET_ROOT must name extracted R01"),
    );
    let exe = std::env::var("TOS_EXE").expect("TOS_EXE must name installed executable");
    let catalog = extract_animation_catalog(&fs::read(exe).unwrap()).unwrap();
    let names = parse_skitdata(&fs::read(root.join("PACKBIN/SKITDATA.TOSBIN")).unwrap()).unwrap();
    assert_eq!(names.len(), catalog.slots.len());
    for (slot, name) in names.iter().enumerate() {
        if let Some(name) = name {
            let members =
                parse_pac(&fs::read(root.join("PAC/SKIT").join(name.to_uppercase())).unwrap())
                    .unwrap();
            for channel in &catalog.slots[slot].channels {
                for frame in &channel.frames {
                    assert!((frame.texture as usize) < members.len());
                }
            }
        }
    }
    for entry in fs::read_dir(root.join("GLOBAL/SKIT")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "TOTEXP_P") {
            let texture = decode_texture(&fs::read(path).unwrap()).unwrap();
            assert_eq!(
                texture.rgba.len(),
                (texture.width * texture.height * 4) as usize
            );
        }
    }
    if let Ok(audio_root) = std::env::var("TOS_JP_AUDIO") {
        for name in ["CHT_COMMON.AWB", "CHT_DISC_1.AWB", "CHT_DISC_2.AWB"] {
            let data = fs::read(PathBuf::from(&audio_root).join(name)).unwrap();
            let entries = parse_awb(&data).unwrap();
            for entry in &entries {
                let at = entry.offset as usize;
                let audio = decode_adx(&data[at..at + entry.size as usize]).unwrap();
                assert_eq!(audio.sample_rate, 48000);
                assert!(audio
                    .pcm
                    .iter()
                    .all(|n| n.is_finite() && (-1.0..=1.0).contains(n)));
            }
        }
    }
}
