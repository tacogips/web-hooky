"""Allows ``python -m webhooky`` alongside the installed ``webhooky`` script."""

from .cli import main

raise SystemExit(main())
