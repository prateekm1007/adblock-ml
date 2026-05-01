#!/usr/bin/env python3
"""
compile_lists.py — Download EasyList/EasyPrivacy and compile to DNR JSON
=========================================================================
Chrome's declarativeNetRequest requires rules in a specific JSON format.
This script downloads the filter lists and compiles a representative subset
that fits within Chrome's static rule limits.

Chrome limits:
  - 30,000 static rules total across all rule_resources
  - Each rule_resource can have up to 30,000 rules
  - We split across easylist_dnr.json + easyprivacy_dnr.json

Usage:
  pip install requests
  python scripts/compile_lists.py

Output:
  lists/easylist_dnr.json    (~15,000 rules)
  lists/easyprivacy_dnr.json (~10,000 rules)
"""

import re
import json
import sys
import urllib.request
from pathlib import Path

LISTS = {
    'easylist': {
        'url': 'https://easylist.to/easylist/easylist.txt',
        'output': 'lists/easylist_dnr.json',
        'max_rules': 15000,
        'id_offset': 1,
    },
    'easyprivacy': {
        'url': 'https://easylist.to/easylist/easyprivacy.txt',
        'output': 'lists/easyprivacy_dnr.json',
        'max_rules': 10000,
        'id_offset': 20000,
    },
}

RESOURCE_TYPES = [
    'script', 'xmlhttprequest', 'image', 'sub_frame',
    'media', 'object', 'other', 'fetch',
]

ALL_RESOURCE_TYPES = [
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
    'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
]


def download_list(url: str) -> list[str]:
    print(f"  Downloading {url} ...")
    with urllib.request.urlopen(url, timeout=30) as r:
        text = r.read().decode('utf-8', errors='replace')
    lines = text.splitlines()
    print(f"  Downloaded {len(lines):,} lines")
    return lines


def parse_network_rule(line: str) -> dict | None:
    """
    Parse a uBO/EasyList network filter line into a DNR rule dict.
    Handles the most common patterns; skips complex regex/option rules.

    Supported patterns:
      ||example.com^              → block domain
      ||example.com/ads/*         → block path pattern
      @@||example.com^            → allow (exception) rule

    Returns None for unsupported/cosmetic/comment lines.
    """
    line = line.strip()

    # Skip comments, blank lines, cosmetic filters, scriptlets
    if not line or line.startswith('!') or line.startswith('['):
        return None
    if '##' in line or '#@#' in line or '#?#' in line:
        return None  # Cosmetic filter
    if line.startswith('#'):
        return None
    if 'script:inject' in line or '+js(' in line:
        return None  # Scriptlet

    is_exception = line.startswith('@@')
    if is_exception:
        line = line[2:]

    # Extract options
    options = {}
    if '$' in line:
        parts = line.rsplit('$', 1)
        line = parts[0]
        opts_str = parts[1]

        # Parse options
        for opt in opts_str.split(','):
            opt = opt.strip()
            if opt.startswith('domain='):
                pass  # Skip domain-specific rules for simplicity
            elif opt == 'third-party' or opt == '3p':
                options['domainType'] = 'thirdParty'
            elif opt == 'first-party' or opt == '1p':
                options['domainType'] = 'firstParty'
            elif opt in ('script', 'image', 'stylesheet', 'object',
                         'xmlhttprequest', 'subdocument', 'media', 'font',
                         'websocket', 'ping', 'other'):
                options.setdefault('resourceTypes', [])
                if opt == 'subdocument':
                    opt = 'sub_frame'
                if opt == 'xmlhttprequest':
                    pass  # keep as is, valid DNR type
                options['resourceTypes'].append(opt)
            elif opt.startswith('~'):
                pass  # Negated options — skip for simplicity

    # Skip pure regex rules (too complex for DNR urlFilter)
    if line.startswith('/') and line.endswith('/'):
        return None

    # Skip rules with unsupported characters
    if re.search(r'["\']', line):
        return None

    if not line:
        return None

    # Build condition
    condition = {}

    # URLFilter: convert || prefix to DNR format
    url_filter = line
    if url_filter.startswith('||'):
        # Already in correct format for DNR urlFilter
        pass
    elif url_filter.startswith('|'):
        url_filter = url_filter[1:]
    
    # DNR urlFilter uses the filter directly
    condition['urlFilter'] = url_filter

    if 'resourceTypes' in options:
        condition['resourceTypes'] = options['resourceTypes']
    else:
        condition['resourceTypes'] = RESOURCE_TYPES

    if 'domainType' in options:
        condition['domainType'] = options['domainType']

    action = {'type': 'allow' if is_exception else 'block'}

    return {'condition': condition, 'action': action}


def compile_list(lines: list[str], id_offset: int, max_rules: int) -> list[dict]:
    rules = []
    rule_id = id_offset
    skipped = 0

    for line in lines:
        if len(rules) >= max_rules:
            break

        parsed = parse_network_rule(line)
        if parsed is None:
            skipped += 1
            continue

        parsed['id'] = rule_id
        parsed['priority'] = 2 if parsed['action']['type'] == 'allow' else 1
        rules.append(parsed)
        rule_id += 1

    print(f"  Compiled {len(rules):,} rules (skipped {skipped:,} unsupported lines)")
    return rules


def write_rules(rules: list[dict], output_path: str):
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w') as f:
        json.dump(rules, f, indent=2)
    size_kb = path.stat().st_size / 1024
    print(f"  Written to {output_path} ({size_kb:.0f} KB)")


def main():
    root = Path(__file__).parent.parent

    for name, config in LISTS.items():
        print(f"\n{'='*50}")
        print(f"Processing {name}")
        print('='*50)

        try:
            lines = download_list(config['url'])
        except Exception as e:
            print(f"  ERROR downloading {name}: {e}")
            print("  Keeping existing stub file.")
            continue

        rules = compile_list(lines, config['id_offset'], config['max_rules'])
        output = root / config['output']
        write_rules(rules, str(output))

    print("\nDone. Reload the extension in chrome://extensions to apply new rules.")


if __name__ == '__main__':
    main()
