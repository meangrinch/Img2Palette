#!/usr/bin/env python3
"""Build script for Img2Palette.

Bundles modular source code (src/) and assets (assets/) into self-contained standalone
HTML files:
  1. index.html        - For GitHub Pages root hosting
  2. Img2Palette.html  - For standalone offline distribution and releases
"""

import argparse
import base64
import json
import sys
from pathlib import Path


def parse_semver(v_str: str):
    parts = v_str.strip().lstrip('v').split('.')
    while len(parts) < 3:
        parts.append('0')
    return [int(p) for p in parts[:3]]


def bump_version(current: str, part: str) -> str:
    major, minor, patch = parse_semver(current)
    if part == 'major':
        major += 1
        minor = 0
        patch = 0
    elif part == 'minor':
        minor += 1
        patch = 0
    elif part == 'patch':
        patch += 1
    else:
        raise ValueError(f"Unknown bump target: {part}. Use 'patch', 'minor', or 'major'.")
    return f"{major}.{minor}.{patch}"


def build(bump: str | None = None):
    root_dir = Path(__file__).resolve().parent.parent

    src_dir = root_dir / 'src'
    assets_dir = root_dir / 'assets'
    version_file = src_dir / 'version.json'
    template_file = src_dir / 'template.html'
    engine_file = src_dir / 'engine.js'

    logo_file = assets_dir / 'logo.png'
    sample_file = root_dir / 'docs' / 'images' / 'example_original.jpg'

    # 1. Read & optionally bump version
    if not version_file.exists():
        print(f"Error: {version_file} does not exist.", file=sys.stderr)
        sys.exit(1)

    with open(version_file, 'r', encoding='utf-8') as f:
        v_data = json.load(f)
    version = v_data.get('version', '1.0.0')

    if bump:
        new_version = bump_version(version, bump)
        print(f"Bumping version: {version} -> {new_version}")
        version = new_version
        v_data['version'] = version
        with open(version_file, 'w', encoding='utf-8') as f:
            json.dump(v_data, f, indent=2)
            f.write('\n')

    print(f"Building Img2Palette v{version}...")

    # 2. Encode assets to base64
    if not logo_file.exists():
        print(f"Error: Logo file missing at {logo_file}", file=sys.stderr)
        sys.exit(1)
    with open(logo_file, 'rb') as f:
        logo_b64 = "data:image/png;base64," + base64.b64encode(f.read()).decode('ascii')

    if not sample_file.exists():
        print(f"Error: Sample image missing at {sample_file}", file=sys.stderr)
        sys.exit(1)
    with open(sample_file, 'rb') as f:
        sample_b64 = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode('ascii')

    # 3. Read engine logic
    if not engine_file.exists():
        print(f"Error: Engine script missing at {engine_file}", file=sys.stderr)
        sys.exit(1)
    with open(engine_file, 'r', encoding='utf-8') as f:
        engine_js = f.read()

    # 4. Read template and substitute placeholders
    if not template_file.exists():
        print(f"Error: HTML template missing at {template_file}", file=sys.stderr)
        sys.exit(1)
    with open(template_file, 'r', encoding='utf-8') as f:
        template = f.read()

    html = template
    html = html.replace('{{VERSION}}', version)
    html = html.replace('{{LOGO_B64}}', logo_b64)
    html = html.replace('{{SAMPLE_B64}}', sample_b64)
    html = html.replace('/* {{ENGINE_JS}} */', engine_js)

    # Ensure no unresolved placeholders remain
    remaining = [p for p in ['{{VERSION}}', '{{LOGO_B64}}', '{{SAMPLE_B64}}', '/* {{ENGINE_JS}} */'] if p in html]
    if remaining:
        print(f"Warning: Unresolved placeholders in output: {remaining}", file=sys.stderr)

    # 5. Write outputs
    out_index = root_dir / 'index.html'
    out_standalone = root_dir / 'Img2Palette.html'

    with open(out_index, 'w', encoding='utf-8') as f:
        f.write(html)

    with open(out_standalone, 'w', encoding='utf-8') as f:
        f.write(html)

    size_kb = len(html.encode('utf-8')) / 1024.0
    print("Successfully generated:")
    print(f"  - {out_index.name} ({size_kb:.1f} KB)")
    print(f"  - {out_standalone.name} ({size_kb:.1f} KB)")
    print(f"Img2Palette v{version} build complete.")


def main():
    parser = argparse.ArgumentParser(description="Build standalone HTML bundles for Img2Palette.")
    parser.add_argument(
        '--bump',
        choices=['patch', 'minor', 'major'],
        help="Increment the semantic version and rebuild."
    )
    args = parser.parse_args()
    build(bump=args.bump)


if __name__ == '__main__':
    main()
