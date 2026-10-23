#!/usr/bin/env python3
"""Build bundled PC portraits from extracted R01 files and TOS.exe.

Usage (from skit-editor):
  python3 scripts/prepare-portraits.py /path/to/R01 /path/to/TOS.exe

Requires Python 3 and Cargo. No third-party Python packages are needed.
Only decoded portrait PNGs and animation metadata enter public/portraits.
Neither the executable, original containers, nor voice data are copied.
"""

import argparse
import json
import pathlib
import struct
import subprocess
import tempfile
import zlib


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png(width, height, rgba):
    if len(rgba) != width * height * 4:
        raise ValueError("Decoded RGBA size does not match its dimensions")
    stride = width * 4
    filtered = bytearray()
    previous = bytes(stride)
    for y in range(height):
        row = rgba[y * stride:(y + 1) * stride]
        # Choose a reversible PNG filter per row, preserving every decoded pixel.
        sub = bytes((value - (row[x - 4] if x >= 4 else 0)) & 255 for x, value in enumerate(row))
        up = bytes((value - previous[x]) & 255 for x, value in enumerate(row))
        kind, result = min(enumerate((row, sub, up)), key=lambda item: sum(min(value, 256 - value) for value in item[1]))
        filtered.append(kind)
        filtered.extend(result)
        previous = row
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(filtered, 9)) + chunk(b"IEND", b""))


def main():
    project = pathlib.Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("r01", type=pathlib.Path)
    parser.add_argument("exe", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, default=project / "public/portraits")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="tos-portraits-") as temporary:
        raw = pathlib.Path(temporary)
        subprocess.run(["cargo", "run", "--locked", "--release", "--manifest-path", str(project / "core/Cargo.toml"),
                        "--bin", "export-portraits", "--", str(args.r01.resolve()), str(args.exe.resolve()), str(raw)], check=True)
        manifest = json.loads((raw / "manifest.json").read_text())
        args.output.mkdir(parents=True, exist_ok=True)
        total = 0
        for texture in manifest["textures"].values():
            encoded = png(texture["width"], texture["height"], (raw / texture.pop("raw")).read_bytes())
            (args.output / texture["file"]).write_bytes(encoded)
            total += len(encoded)
        encoded = (json.dumps(manifest, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
        (args.output / "manifest.json").write_bytes(encoded)
        total += len(encoded)
        print(f"Prepared {len(manifest['portraits'])} portraits, {len(manifest['textures'])} PNG layers, "
              f"{len(manifest['catalog']['slots'])} animation slots; {total:,} bytes in {args.output}")


if __name__ == "__main__":
    main()
