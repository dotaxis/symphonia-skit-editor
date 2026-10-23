//! Local-only readers for the PC skit preview's assets. No executable code runs.
use serde::Serialize;
use std::collections::HashSet;

type Result<T> = std::result::Result<T, String>;

fn bytes(data: &[u8], offset: usize, count: usize) -> Result<&[u8]> {
    data.get(offset..offset.checked_add(count).ok_or("Offset overflow")?)
        .ok_or_else(|| format!("Truncated asset at byte {offset}"))
}
fn le16(d: &[u8], o: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(bytes(d, o, 2)?.try_into().unwrap()))
}
fn le32(d: &[u8], o: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(bytes(d, o, 4)?.try_into().unwrap()))
}
fn be16(d: &[u8], o: usize) -> Result<u16> {
    Ok(u16::from_be_bytes(bytes(d, o, 2)?.try_into().unwrap()))
}
fn be32(d: &[u8], o: usize) -> Result<u32> {
    Ok(u32::from_be_bytes(bytes(d, o, 4)?.try_into().unwrap()))
}

#[derive(Debug, Serialize)]
pub struct Texture {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

fn rgb565(value: u16) -> [u8; 4] {
    let r = ((value >> 11) & 31) as u8;
    let g = ((value >> 5) & 63) as u8;
    let b = (value & 31) as u8;
    [
        (r << 3) | (r >> 2),
        (g << 2) | (g >> 4),
        (b << 3) | (b >> 2),
        255,
    ]
}

/// Decode the first DDS mip, with or without the PC TOTEXP_P size prefix.
pub fn decode_texture(input: &[u8]) -> Result<Texture> {
    let data = if input.starts_with(b"DDS ") {
        input
    } else {
        if le32(input, 0)? as usize != input.len().saturating_sub(4) {
            return Err("Invalid TOTEXP_P size prefix".into());
        }
        bytes(input, 4, input.len() - 4)?
    };
    if bytes(data, 0, 4)? != b"DDS " || le32(data, 4)? != 124 || le32(data, 76)? != 32 {
        return Err("Invalid DDS header".into());
    }
    let height = le32(data, 12)?;
    let width = le32(data, 16)?;
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || width as u64 * height as u64 > 16_777_216
    {
        return Err("DDS dimensions exceed preview limits".into());
    }
    let dxt5 = match bytes(data, 84, 4)? {
        b"DXT1" => false,
        b"DXT5" => true,
        _ => return Err("Preview supports DDS DXT1 and DXT5 textures".into()),
    };
    let blocks_x = (width as usize).div_ceil(4);
    let blocks_y = (height as usize).div_ceil(4);
    let stride = if dxt5 { 16 } else { 8 };
    let compressed = bytes(data, 128, blocks_x * blocks_y * stride)?;
    let mut rgba = vec![0; width as usize * height as usize * 4];
    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let block = &compressed[(by * blocks_x + bx) * stride..][..stride];
            let color = if dxt5 { &block[8..] } else { block };
            let a = le16(color, 0)?;
            let b = le16(color, 2)?;
            let mut palette = [rgb565(a), rgb565(b), [0, 0, 0, 255], [0, 0, 0, 255]];
            let endpoints = [palette[0], palette[1]];
            for (component, (&x, &y)) in endpoints[0].iter().zip(&endpoints[1]).take(3).enumerate()
            {
                let x = x as u16;
                let y = y as u16;
                if a > b || dxt5 {
                    palette[2][component] = ((2 * x + y) / 3) as u8;
                    palette[3][component] = ((x + 2 * y) / 3) as u8;
                } else {
                    palette[2][component] = ((x + y) / 2) as u8;
                }
            }
            if a <= b && !dxt5 {
                palette[3] = [0, 0, 0, 0];
            }
            let indices = le32(color, 4)?;
            let mut alpha = [255u8; 8];
            let mut alpha_indices = 0u64;
            if dxt5 {
                alpha[0] = block[0];
                alpha[1] = block[1];
                if alpha[0] > alpha[1] {
                    for i in 2..8 {
                        alpha[i] = (((8 - i) as u16 * alpha[0] as u16
                            + (i - 1) as u16 * alpha[1] as u16)
                            / 7) as u8;
                    }
                } else {
                    for i in 2..6 {
                        alpha[i] = (((6 - i) as u16 * alpha[0] as u16
                            + (i - 1) as u16 * alpha[1] as u16)
                            / 5) as u8;
                    }
                    alpha[6] = 0;
                    alpha[7] = 255;
                }
                for i in 0..6 {
                    alpha_indices |= (block[2 + i] as u64) << (8 * i);
                }
            }
            for pixel in 0..16 {
                let x = bx * 4 + pixel % 4;
                let y = by * 4 + pixel / 4;
                if x >= width as usize || y >= height as usize {
                    continue;
                }
                let mut value = palette[((indices >> (pixel * 2)) & 3) as usize];
                if dxt5 {
                    value[3] = alpha[((alpha_indices >> (pixel * 3)) & 7) as usize];
                }
                let at = (y * width as usize + x) * 4;
                rgba[at..at + 4].copy_from_slice(&value);
            }
        }
    }
    Ok(Texture {
        width,
        height,
        rgba,
    })
}

fn name_table(data: &[u8], suffix: &str, allow_empty: bool) -> Result<Vec<Option<String>>> {
    let count = le32(data, 0)? as usize;
    if count > 65_536 {
        return Err("Too many manifest entries".into());
    }
    let table_end = 4 + count * 4;
    bytes(data, 0, table_end)?;
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        let offset = le32(data, 4 + i * 4)? as usize;
        if offset == 0 && allow_empty {
            result.push(None);
            continue;
        }
        if offset < table_end || offset >= data.len() {
            return Err("Manifest string offset is outside the string area".into());
        }
        let remaining = &data[offset..data.len().min(offset + 256)];
        let end = remaining
            .iter()
            .position(|&b| b == 0)
            .ok_or("Unterminated manifest name")?;
        let raw = &remaining[..end];
        if raw.is_empty()
            || !raw
                .iter()
                .all(|&b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
        {
            return Err("Invalid asset name in manifest".into());
        }
        let name = String::from_utf8(raw.to_vec()).map_err(|_| "Non-ASCII asset name")?;
        if !name.to_ascii_lowercase().ends_with(suffix) {
            return Err(format!("Expected {suffix} manifest entries"));
        }
        result.push(Some(name));
    }
    Ok(result)
}

/// Index is the executable's portrait resource ID, including empty slots.
pub fn parse_skitdata(data: &[u8]) -> Result<Vec<Option<String>>> {
    name_table(data, ".pac", true)
}

/// PAC order defines the texture IDs used by facial animation keyframes.
pub fn parse_pac(data: &[u8]) -> Result<Vec<Option<String>>> {
    name_table(data, ".totexb_d", false)
}

#[derive(Debug, Serialize)]
pub struct AwbEntry {
    pub id: u16,
    pub offset: u32,
    pub size: u32,
}

pub fn parse_awb(data: &[u8]) -> Result<Vec<AwbEntry>> {
    if bytes(data, 0, 8)? != b"AFS2\x01\x04\x02\0" {
        return Err("Unsupported AWB header".into());
    }
    let count = le32(data, 8)? as usize;
    let alignment = le16(data, 12)? as usize;
    if count == 0 || count > 65_536 || alignment == 0 || le16(data, 14)? != 0 {
        return Err("Invalid or encrypted AWB bank".into());
    }
    let offset_table = 16 + count * 2;
    let table_end = offset_table + (count + 1) * 4;
    bytes(data, 0, table_end)?;
    let mut ids = HashSet::new();
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        let id = le16(data, 16 + i * 2)?;
        if !ids.insert(id) {
            return Err("Duplicate AWB entry ID".into());
        }
        let raw_start = le32(data, offset_table + i * 4)? as usize;
        let end = le32(data, offset_table + (i + 1) * 4)? as usize;
        let start = raw_start
            .checked_add(alignment - 1)
            .ok_or("AWB offset overflow")?
            / alignment
            * alignment;
        if raw_start < table_end || end <= start || end > data.len() {
            return Err("Invalid AWB member bounds".into());
        }
        result.push(AwbEntry {
            id,
            offset: start as u32,
            size: (end - start) as u32,
        });
    }
    Ok(result)
}

#[derive(Debug, Serialize)]
pub struct Audio {
    pub sample_rate: u32,
    pub channels: u8,
    /// Interleaved normalized floating point PCM.
    pub pcm: Vec<f32>,
}

/// Standard fixed-predictor ADX v3 decoder for the original Japanese CHT banks.
/// Decode only the member selected by parse_awb; never decode an entire bank.
pub fn decode_adx(data: &[u8]) -> Result<Audio> {
    if bytes(data, 0, 2)? != [0x80, 0] {
        return Err("Invalid ADX magic".into());
    }
    let start = be16(data, 2)? as usize + 4;
    let header = bytes(data, 4, 16)?;
    let channels = header[3];
    let sample_rate = be32(data, 8)?;
    let samples = be32(data, 12)? as usize;
    let cutoff = be16(data, 16)? as f64;
    if header[0..3] != [3, 18, 4] || !(1..=2).contains(&channels) || header[14..16] != [3, 0] {
        return Err("Preview supports unencrypted ADX v3, 18-byte 4-bit blocks".into());
    }
    if !(8000..=192000).contains(&sample_rate)
        || samples == 0
        || samples > 20_000_000
        || cutoff >= sample_rate as f64 / 2.0
    {
        return Err("Invalid ADX audio geometry".into());
    }
    if start < 24 || bytes(data, start - 6, 6)? != b"(c)CRI" {
        return Err("Invalid ADX CRI signature".into());
    }
    let frames = samples.div_ceil(32);
    let compressed = bytes(data, start, frames * 18 * channels as usize)?;
    // CRI ADX's second-order high-pass predictor, expressed in Q12.
    let a = 2.0_f64.sqrt() - (2.0 * std::f64::consts::PI * cutoff / sample_rate as f64).cos();
    let b = 2.0_f64.sqrt() - 1.0;
    let c = (a - ((a + b) * (a - b)).sqrt()) / b;
    let coefficient1 = (c * 2.0 * 4096.0).floor() as i64;
    let coefficient2 = (-c * c * 4096.0).floor() as i64;
    let mut history = [[0i64; 2]; 2];
    let mut pcm = vec![0.0; samples * channels as usize];
    for frame in 0..frames {
        for channel in 0..channels as usize {
            let offset = (frame * channels as usize + channel) * 18;
            let block = &compressed[offset..offset + 18];
            let encoded_scale = be16(block, 0)?;
            if encoded_scale & 0x8000 != 0 {
                return Err("ADX terminator or encrypted block before sample end".into());
            }
            let scale = encoded_scale as i64 + 1;
            for i in 0..32 {
                let byte = block[2 + i / 2];
                let unsigned = if i % 2 == 0 { byte >> 4 } else { byte & 15 };
                let signed = if unsigned >= 8 {
                    unsigned as i64 - 16
                } else {
                    unsigned as i64
                };
                let value = ((signed * scale * 4096
                    + coefficient1 * history[channel][0]
                    + coefficient2 * history[channel][1])
                    >> 12)
                    .clamp(-32768, 32767);
                history[channel] = [value, history[channel][0]];
                let sample = frame * 32 + i;
                if sample < samples {
                    pcm[sample * channels as usize + channel] = value as f32 / 32768.0;
                }
            }
        }
    }
    Ok(Audio {
        sample_rate,
        channels,
        pcm,
    })
}

#[derive(Debug, Serialize)]
pub struct AnimationFrame {
    /// Placement in original low-resolution units; multiply by coordinate_scale.
    pub x: i16,
    pub y: i16,
    pub duration: u16,
    /// Index into the portrait's PAC, NOT the SKITDATA slot index.
    pub texture: u16,
}

#[derive(Debug, Serialize)]
pub struct AnimationChannel {
    /// 0x7000 blink, 0x7003 mouth, 0x7006 additional animated layer.
    pub tag: u16,
    /// Native header parameter retained without assuming it is a frame count.
    pub parameter: u16,
    pub frames: Vec<AnimationFrame>,
    /// "loop" for duration 0xFD; "hold" for duration 0xFE.
    pub ending: String,
}

#[derive(Debug, Serialize)]
pub struct PortraitAnimation {
    pub slot: u16,
    pub flags: u32,
    pub channels: Vec<AnimationChannel>,
}

#[derive(Debug, Serialize)]
pub struct AnimationCatalog {
    pub layout: String,
    pub coordinate_scale: u8,
    pub ticks_per_second: u16,
    pub slots: Vec<PortraitAnimation>,
}

struct Section {
    rva: u32,
    size: u32,
    offset: u32,
}
struct Pe<'a> {
    data: &'a [u8],
    base: u32,
    sections: Vec<Section>,
}
impl<'a> Pe<'a> {
    fn read(data: &'a [u8]) -> Result<Self> {
        if bytes(data, 0, 2)? != b"MZ" {
            return Err("Expected a Windows TOS.exe".into());
        }
        let pe = le32(data, 0x3c)? as usize;
        if bytes(data, pe, 4)? != b"PE\0\0" || le16(data, pe + 4)? != 0x14c {
            return Err("Expected the supported x86 PC executable".into());
        }
        let count = le16(data, pe + 6)? as usize;
        let optional_size = le16(data, pe + 20)? as usize;
        if count == 0 || count > 96 || optional_size < 96 || le16(data, pe + 24)? != 0x10b {
            return Err("Invalid PE32 section layout".into());
        }
        let base = le32(data, pe + 24 + 28)?;
        if base != 0x400000 {
            return Err("Unsupported TOS.exe image base".into());
        }
        let table = pe + 24 + optional_size;
        bytes(data, table, count * 40)?;
        let mut sections = Vec::with_capacity(count);
        for i in 0..count {
            let at = table + i * 40;
            let rva = le32(data, at + 12)?;
            let size = le32(data, at + 16)?;
            let offset = le32(data, at + 20)?;
            bytes(data, offset as usize, size as usize)?;
            sections.push(Section { rva, size, offset });
        }
        Ok(Self {
            data,
            base,
            sections,
        })
    }
    fn at(&self, va: u32, count: usize) -> Result<&'a [u8]> {
        let rva = va
            .checked_sub(self.base)
            .ok_or("PE virtual address precedes image")?;
        for section in &self.sections {
            if let Some(relative) = rva.checked_sub(section.rva) {
                if relative as u64 + count as u64 <= section.size as u64 {
                    let at = section.offset as usize + relative as usize;
                    return bytes(self.data, at, count);
                }
            }
        }
        Err(format!("PE address {va:#x} is not backed by file data"))
    }
}

/// Read data only from the supported PC layout, validating the consumers as
/// well as every pointer. This accepts timing patches without requiring a hash
/// of the entire executable, and never executes or uploads it.
pub fn extract_animation_catalog(data: &[u8]) -> Result<AnimationCatalog> {
    let pe = Pe::read(data)?;
    if pe.at(0x5564aa, 7)? != [0x8b, 0x04, 0x85, 0x08, 0x39, 0x8b, 0x00]
        || pe.at(0x55659b, 5)? != [0xbf, 0x03, 0x70, 0x00, 0x00]
        || pe.at(0x55667f, 5)? != [0xbf, 0x06, 0x70, 0x00, 0x00]
    {
        return Err("Unsupported TOS.exe facial animation layout".into());
    }
    let table = pe.at(0x8b3908, 222 * 4)?;
    let mut slots = Vec::with_capacity(222);
    for slot in 0..222 {
        let pointer = le32(table, slot * 4)?;
        if pointer == 0 {
            return Err("Null facial animation pointer".into());
        }
        let flags = le32(pe.at(pointer, 4)?, 0)?;
        let mut cursor = pointer
            .checked_add(4)
            .ok_or("PE animation pointer overflow")?;
        let mut channels = Vec::new();
        loop {
            let command = pe.at(cursor, 4)?;
            if command == [0xfe; 4] {
                break;
            }
            if channels.len() >= 3 {
                return Err("Too many facial animation channels".into());
            }
            let tag = le16(command, 0)?;
            let parameter = le16(command, 2)?;
            if ![0x7000, 0x7003, 0x7006].contains(&tag)
                || channels.iter().any(|c: &AnimationChannel| c.tag == tag)
            {
                return Err("Unknown or duplicate facial animation channel".into());
            }
            cursor = cursor
                .checked_add(4)
                .ok_or("PE animation pointer overflow")?;
            let mut frames = Vec::new();
            let ending;
            loop {
                if frames.len() >= 256 {
                    return Err("Unterminated facial animation channel".into());
                }
                let frame = pe.at(cursor, 8)?;
                cursor = cursor
                    .checked_add(8)
                    .ok_or("PE animation pointer overflow")?;
                let duration = le16(frame, 4)?;
                if duration == 0xfd || duration == 0xfe {
                    if frames.is_empty() {
                        return Err("Empty facial animation channel".into());
                    }
                    ending = if duration == 0xfd { "loop" } else { "hold" }.to_owned();
                    break;
                }
                let texture = le16(frame, 6)?;
                if duration > 32767 || texture > 255 {
                    return Err("Invalid facial animation keyframe".into());
                }
                frames.push(AnimationFrame {
                    x: le16(frame, 0)? as i16,
                    y: le16(frame, 2)? as i16,
                    duration,
                    texture,
                });
            }
            channels.push(AnimationChannel {
                tag,
                parameter,
                frames,
                ending,
            });
        }
        slots.push(PortraitAnimation {
            slot: slot as u16,
            flags,
            channels,
        });
    }
    Ok(AnimationCatalog {
        layout: "tos-pc-x86-8b3908".into(),
        coordinate_scale: 2,
        ticks_per_second: 60,
        slots,
    })
}
