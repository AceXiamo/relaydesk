"""Keep one verified online SQLite backup per day on the Pier host."""
from datetime import date, timedelta
import os
from pathlib import Path
import sqlite3
from tempfile import NamedTemporaryFile


def backup():
    os.umask(0o077)
    directory = Path("/srv/backups/relaydesk")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    today = date.today()
    with NamedTemporaryFile(dir=directory, suffix=".tmp", delete=False) as tmp:
        path = Path(tmp.name)
    try:
        source = sqlite3.connect("file:/srv/apps/relaydesk/data/relaydesk.sqlite3?mode=ro", uri=True)
        target = sqlite3.connect(path)
        try:
            source.backup(target)
            if target.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RuntimeError("SQLite backup failed integrity check")
        finally:
            target.close()
            source.close()
        path.replace(directory / f"{today.isoformat()}.sqlite3")
    finally:
        path.unlink(missing_ok=True)
    for copy in directory.glob("????-??-??.sqlite3"):
        if date.fromisoformat(copy.stem) <= today - timedelta(days=7):
            copy.unlink()


if __name__ == "__main__":
    backup()
