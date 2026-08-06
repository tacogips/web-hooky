"""The ``webhooky`` command line interface.

Every capability offered here is one call into this package, so anything
scriptable at the command line is equally available to a Python program.
Output is JSON on stdout; diagnostics go to stderr.

Exit codes: 0 success, 1 the request failed, 2 the command was invoked wrongly.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Sequence

from ._admin_cli import dispatch_admin
from ._clients import USER_AGENT, fetch_client
from ._env import UsageError, resolve_fetch_uuid
from ._output import emit, to_json
from ._parser import build_parser
from .errors import WebhookyError
from .stream import StreamOptions

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_USAGE = 2


def _records_get(args: argparse.Namespace) -> None:
    uuid = resolve_fetch_uuid(args.fetch_uuid)
    with fetch_client(args) as client:
        records = client.records(
            uuid,
            only_unfetched=args.only_unfetched,
            mark_fetched=not args.no_mark_fetched,
            from_=args.from_,
            to=args.to,
            limit=args.limit,
        )
    emit(records, pretty=args.pretty)


def _records_stream(args: argparse.Namespace) -> None:
    uuid = resolve_fetch_uuid(args.fetch_uuid)
    options = StreamOptions(
        reconnect=args.reconnect,
        query_credentials=args.query_credentials,
        max_records=args.max_records or None,
        # Progress goes to stderr so stdout stays a clean record stream.
        on_ready=lambda: print(f"webhooky: streaming {uuid}", file=sys.stderr),
        on_reconnect=lambda attempt, cause: print(
            f"webhooky: reconnect attempt {attempt} after: {cause}", file=sys.stderr
        ),
    )
    with fetch_client(args) as client:
        for record in client.stream(uuid, options):
            # One record per line, flushed as it arrives, so the stream
            # composes with `jq` and `head`.
            print(json.dumps(to_json(record)), flush=True)


def _dispatch(args: argparse.Namespace) -> None:
    group = getattr(args, "group", None)
    if group == "records":
        command = getattr(args, "records_command", None)
        if command == "get":
            _records_get(args)
        elif command == "stream":
            _records_stream(args)
        else:
            raise UsageError('expected "records get" or "records stream"')
        return
    if group == "admin":
        dispatch_admin(args)
        return
    raise UsageError(f"unknown command group {group!r}")


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point for the ``webhooky`` console script."""
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    if getattr(args, "version", False):
        print(USER_AGENT)
        return EXIT_OK
    if not getattr(args, "group", None):
        parser.print_help(sys.stderr)
        return EXIT_USAGE

    try:
        _dispatch(args)
    except UsageError as exc:
        print(f"webhooky: {exc}", file=sys.stderr)
        print('Run "webhooky --help" for usage.', file=sys.stderr)
        return EXIT_USAGE
    except WebhookyError as exc:
        payload = {
            "error": {"status": exc.status, "kind": exc.kind, "message": exc.message}
        }
        print(json.dumps(payload), file=sys.stderr)
        return EXIT_FAILURE
    except KeyboardInterrupt:
        # Ctrl-C during a stream is a normal way to stop.
        return EXIT_OK
    except BrokenPipeError:
        # `webhooky records stream | head` closes stdout under us; that is the
        # pipeline working, not a failure.
        return EXIT_OK
    return EXIT_OK


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
