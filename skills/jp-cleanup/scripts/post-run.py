#!/usr/bin/env python3
"""Portable end-of-skill hook; safe no-op until private storage is configured."""
from pathlib import Path
import runpy
import sys

if __name__ == '__main__':
    script = Path(__file__).with_name('storage.py')
    sys.argv = [str(script), 'post-run']
    runpy.run_path(str(script), run_name='__main__')
