#!/usr/bin/env python3
"""Fail a desktop release early when signing or updater configuration is inconsistent.

Reads desktop/tauri.conf.json and the signing secrets from the environment (only their presence
is reported, never their values). Exits 1 on any inconsistency. A release without signing
secrets is allowed but reported as an "unsigned preview"; under GitHub Actions the result is
written to $GITHUB_OUTPUT as `signed=true|false` and `unsigned=<comma separated list>`.

Usage: python3 desktop/release_preflight.py [--allow-missing-updater-key] [--config PATH]
"""
import argparse
import base64
import binascii
import hashlib
import json
import os
import pathlib
import re
import sys

APPLE_CERT = ('APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY')
APPLE_NOTARY = ('APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID')
WINDOWS = ('WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD')


class ConfigError(ValueError):
    pass


def _minisign_line(value, name):
    """Tauri stores a minisign key file base64-encoded; return the decoded key line bytes."""
    try:
        text = base64.b64decode(value.strip(), validate=True).decode()
        lines = text.splitlines()
        if len(lines) < 2 or not lines[0].startswith('untrusted comment:'):
            raise ValueError
        return base64.b64decode(lines[1].strip(), validate=True)
    except (ValueError, binascii.Error, UnicodeDecodeError):
        raise ConfigError(f'{name} is not a base64-encoded minisign key file (placeholder or wrong value?)')


def parse_pubkey(value):
    raw = _minisign_line(value, 'plugins.updater.pubkey')
    if len(raw) != 42 or raw[:2] != b'Ed':
        raise ConfigError('plugins.updater.pubkey is not an Ed25519 minisign public key')
    return raw[2:10], raw[10:]


def _scrypt_params(opslimit, memlimit):
    # Same derivation as libsodium/rust-minisign (raw_scrypt_params).
    opslimit = max(32768, opslimit)
    r, n_log2 = 8, 1
    max_n = opslimit // (r * 4) if opslimit < memlimit // 32 else memlimit // (r * 128)
    while n_log2 < 63 and (1 << n_log2) <= max_n // 2:
        n_log2 += 1
    if opslimit < memlimit // 32:
        p = 1
    else:
        p = min(0x3FFFFFFF, (opslimit // 4) // (1 << n_log2)) // r
    if n_log2 > 20:
        raise ConfigError('TAURI_SIGNING_PRIVATE_KEY uses scrypt parameters that are too high')
    return 1 << n_log2, r, p


def parse_private_key(value, password):
    """Decrypt a minisign secret key and return (key id, Ed25519 public key)."""
    raw = _minisign_line(value, 'TAURI_SIGNING_PRIVATE_KEY')
    if len(raw) != 158 or raw[:2] != b'Ed' or raw[4:6] != b'B2' or raw[2:4] not in (b'Sc', b'\0\0'):
        raise ConfigError('TAURI_SIGNING_PRIVATE_KEY is not an Ed25519 minisign secret key')
    secret = raw[54:]
    if raw[2:4] == b'Sc':
        n, r, p = _scrypt_params(int.from_bytes(raw[38:46], 'little'), int.from_bytes(raw[46:54], 'little'))
        stream = hashlib.scrypt(password.encode(), salt=raw[6:38], n=n, r=r, p=p,
                                maxmem=256 * n * r + (1 << 20), dklen=len(secret))
        secret = bytes(a ^ b for a, b in zip(secret, stream))
    key_id, ed_secret, checksum = secret[:8], secret[8:72], secret[72:]
    if hashlib.blake2b(raw[:2] + key_id + ed_secret, digest_size=32).digest() != checksum:
        raise ConfigError('TAURI_SIGNING_PRIVATE_KEY_PASSWORD is missing or wrong for TAURI_SIGNING_PRIVATE_KEY')
    return key_id, ed_secret[32:]


def check(config, env, allow_missing_updater_key=False):
    """Return (errors, warnings, unsigned parts). `env` maps names to secret values."""
    has = lambda name: bool(env.get(name))
    errors, warnings, unsigned = [], [], []
    updater = config.get('plugins', {}).get('updater', {})
    pubkey = (updater.get('pubkey') or '').strip()

    public = None
    if pubkey:
        try:
            public = parse_pubkey(pubkey)
        except ConfigError as error:
            errors.append(str(error))
    elif config.get('bundle', {}).get('createUpdaterArtifacts'):
        errors.append('bundle.createUpdaterArtifacts is enabled but plugins.updater.pubkey is empty')

    if has('TAURI_SIGNING_PRIVATE_KEY'):
        if not pubkey:
            errors.append('TAURI_SIGNING_PRIVATE_KEY is set but plugins.updater.pubkey in desktop/tauri.conf.json '
                          'is empty: commit the matching public key or remove the secret')
        try:
            private = parse_private_key(env['TAURI_SIGNING_PRIVATE_KEY'], env.get('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', ''))
            if public and private != public:
                errors.append('TAURI_SIGNING_PRIVATE_KEY does not match plugins.updater.pubkey: installed apps '
                              'would reject every update signed with it')
        except ConfigError as error:
            errors.append(str(error))
    elif pubkey:
        message = ('plugins.updater.pubkey is set, so built apps check for updates, but the '
                   'TAURI_SIGNING_PRIVATE_KEY secret is missing: the release would ship no signed latest.json')
        (warnings if allow_missing_updater_key else errors).append(message)
        unsigned.append('updater')
    else:
        unsigned.append('updater')

    present = [name for name in APPLE_CERT + APPLE_NOTARY if has(name)]
    if present:
        missing = [name for name in APPLE_CERT + APPLE_NOTARY if not has(name)]
        if missing:
            errors.append('macOS signing is partially configured; also set ' + ', '.join(missing)
                          + ' (a Developer ID signature without notarization is still blocked by Gatekeeper)')
        else:
            team = re.search(r'\(([A-Z0-9]{10})\)\s*$', env['APPLE_SIGNING_IDENTITY'])
            if team and team.group(1) != env['APPLE_TEAM_ID'].strip():
                errors.append('APPLE_TEAM_ID does not match the team ID in APPLE_SIGNING_IDENTITY')
    else:
        unsigned.append('macOS')

    windows = [name for name in WINDOWS if has(name)]
    if windows and len(windows) != len(WINDOWS):
        errors.append('Windows signing is partially configured; set both ' + ' and '.join(WINDOWS))
    elif not windows:
        unsigned.append('Windows')
    return errors, warnings, unsigned


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--config', default=pathlib.Path(__file__).with_name('tauri.conf.json'), type=pathlib.Path)
    parser.add_argument('--allow-missing-updater-key', action='store_true',
                        help='downgrade a missing TAURI_SIGNING_PRIVATE_KEY to a warning (pull request builds)')
    args = parser.parse_args(argv)
    errors, warnings, unsigned = check(json.loads(args.config.read_text()), os.environ, args.allow_missing_updater_key)

    actions = os.environ.get('GITHUB_ACTIONS') == 'true'
    for kind, messages in (('error', errors), ('warning', warnings)):
        for message in messages:
            print(f'::{kind}::{message}' if actions else f'{kind}: {message}', file=sys.stderr)
    if errors:
        print(f'Release preflight failed with {len(errors)} error(s).', file=sys.stderr)
        return 1
    status = 'signed release' if not unsigned else 'UNSIGNED PREVIEW (not signed: ' + ', '.join(unsigned) + ')'
    print(f'Release preflight passed: {status}')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f"signed={'false' if unsigned else 'true'}\nunsigned={','.join(unsigned)}\n")
    return 0


if __name__ == '__main__':
    sys.exit(main())
