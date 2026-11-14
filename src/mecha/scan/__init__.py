"""``mecha scan``: find AI API keys lying around in plaintext on this machine.

Offline and on demand only. Findings never carry a secret or the content of a line: only
where the key is (file, line or notebook cell, column), its redacted form and why that
place is or is not a risk. See SPEC.md, phase 6.
"""
