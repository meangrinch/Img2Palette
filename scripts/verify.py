#!/usr/bin/env python3
"""Verification and sanity test runner for Img2Palette.

Validates that:
  1. index.html and Img2Palette.html exist and are byte-for-byte identical.
  2. UI elements, DOM bindings, and styling contract are satisfied.
  3. UI version tags match src/version.json.
  4. Every inline script compiles.
  5. Algorithmic unit tests in tests/test_engine.js pass.
"""

import json
import re
import subprocess
import sys
from pathlib import Path


def main():
    root_dir = Path(__file__).resolve().parent.parent

    print("=== Running Img2Palette Integrity & Sanity Verification ===")

    index_path = root_dir / 'index.html'
    standalone_path = root_dir / 'Img2Palette.html'
    version_path = root_dir / 'src' / 'version.json'

    # Check 1: File existence
    if not index_path.exists():
        print("[FAIL] index.html does not exist.", file=sys.stderr)
        sys.exit(1)

    if not standalone_path.exists():
        print("[FAIL] Img2Palette.html does not exist.", file=sys.stderr)
        sys.exit(1)

    # Check 2: Byte equality
    with open(index_path, 'rb') as f1, open(standalone_path, 'rb') as f2:
        content_index = f1.read()
        content_standalone = f2.read()

    if content_index != content_standalone:
        print("[FAIL] index.html and Img2Palette.html are not identical!", file=sys.stderr)
        sys.exit(1)
    print(f"[PASS] index.html and Img2Palette.html are byte-identical ({len(content_index):,} bytes).")

    # Check 3: Version matching
    with open(version_path, 'r', encoding='utf-8') as vf:
        version_data = json.load(vf)
    expected_version = version_data.get('version', '1.0.0')

    html_text = content_index.decode('utf-8')

    version_checks = [
        (f'meta version tag ({expected_version})', f'<meta name="version" content="{expected_version}">'),
        (f'UI version badge (v{expected_version})', f'<span class="version-tag">v{expected_version}</span>'),
        ('window.IMG2PALETTE_VERSION assignment', f'window.IMG2PALETTE_VERSION = "{expected_version}";'),
    ]

    for label, needle in version_checks:
        if needle in html_text:
            print(f"[PASS] {label}")
        else:
            print(f"[FAIL] Missing {label} in HTML.", file=sys.stderr)
            sys.exit(1)

    # Check 4: UI & Engine contract checks
    contract_checks = [
        ('Main Canvas ID', 'id="mainCanvas"'),
        ('Side-by-side Container', 'id="sideBySideWrap"'),
        ('Source Image Card', 'id="sideImageCard"'),
        ('Extracted Palette Card', 'id="sidePaletteCard"'),
        ('Palette Matrix Grid', 'id="paletteBoardGrid"'),
        ('Side-by-side Default Tab', 'id="tabSideBySide" data-mode="side">Side-by-Side</button>'),
        ('Palette Result Tab', 'id="tabResult" data-mode="result">Palette</button>'),
        ('Wu Quantizer Default', '<option value="wu" selected>Wu</option>'),
        ('High Quality Sampling Default', '<option value="512" selected>High (512px)</option>'),
        ('Smooth Gradient Sort Default', '<option value="gradient" selected>Smooth Gradient</option>'),
        ('Colors Default 9', 'id="paramColorCount" min="1" max="256" step="1" value="9"'),
        ('Pixelated image-rendering CSS', 'image-rendering: pixelated;'),
        ('Embedded Engine Script', '<script id="engineSource">'),
        ('Embedded PaletteEngine', 'root.PaletteEngine = factory();'),
        ('Export Modal', 'id="exportModal"'),
        ('Hotkeys Button', 'id="btnHotkeys"'),
        ('About Button', 'id="btnAbout"'),
        ('Hotkeys Modal', 'id="hotkeysModal"'),
        ('About Modal', 'id="aboutModal"'),
        ('Viewport Pixel Grid Canvas', 'id="gridCanvas"'),
        ('Pixel Grid Canvas CSS', '.pixel-grid-canvas'),
    ]

    for label, needle in contract_checks:
        if needle in html_text:
            print(f"[PASS] Contract: {label}")
        else:
            print(f"[FAIL] Contract violation: {label} not found in HTML.", file=sys.stderr)
            sys.exit(1)

    # Check 4.5: Embedded JavaScript Syntax Validation (every inline script)
    scripts = re.findall(r'<script\b[^>]*>(.*?)</script>', html_text, re.DOTALL)
    if not scripts:
        print("[FAIL] No inline <script> blocks found.", file=sys.stderr)
        sys.exit(1)
    node_check_code = (
        "const fs = require('fs');\n"
        "const vm = require('vm');\n"
        "const code = fs.readFileSync(0, 'utf-8');\n"
        "try {\n"
        "  new vm.Script(code, { filename: 'index.html.js' });\n"
        "} catch (err) {\n"
        "  console.error(err.stack);\n"
        "  process.exit(1);\n"
        "}\n"
    )
    for n, js_code in enumerate(scripts, 1):
        proc_syntax = subprocess.run(
            ['node', '-e', node_check_code],
            input=js_code,
            encoding='utf-8',
            capture_output=True,
            check=False
        )
        if proc_syntax.returncode != 0:
            print(f"[FAIL] Embedded JavaScript syntax error in script {n}:\n{proc_syntax.stderr}", file=sys.stderr)
            sys.exit(1)
    print(f"[PASS] Embedded JavaScript syntax is valid ({len(scripts)} scripts).")

    # Check 5: Run Engine Unit Tests
    test_file = root_dir / 'tests' / 'test_engine.js'
    if not test_file.exists():
        print(f"[FAIL] Unit test file missing: {test_file}", file=sys.stderr)
        sys.exit(1)

    print("\n--- Spawning Node.js Unit Tests ---")
    proc = subprocess.run(['node', str(test_file)], cwd=str(root_dir), check=False)
    if proc.returncode != 0:
        print(f"[FAIL] Engine unit tests failed with code {proc.returncode}.", file=sys.stderr)
        sys.exit(proc.returncode)

    print("\n=======================================================")
    print(f" ALL VERIFICATION CHECKS PASSED FOR Img2Palette v{expected_version}! ")
    print("=======================================================")


if __name__ == '__main__':
    main()
