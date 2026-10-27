"""A private MariaDB instance for local runs, with its data inside the project.

    python localdb.py start    # first time: creates .db/data, the tft database and user
    python localdb.py stop

Uses an existing MariaDB installation's binaries without touching its own
service or data: no admin rights or root password needed. Set MARIADB_BIN to
the folder holding mariadbd(.exe) if it isn't on PATH.
"""

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pymysql

ROOT = Path(__file__).resolve().parent
DATA = ROOT / ".db" / "data"
PORT = 3307
ROOT_PASSWORD = "tft-root"  # local-only instance bound to 127.0.0.1
DB, USER, PASSWORD = "tft", "tft", "tft-local"


def binary(name: str) -> str:
    folder = os.environ.get("MARIADB_BIN")
    candidates = [Path(folder) / f"{name}.exe", Path(folder) / name] if folder else []
    for c in candidates:
        if c.exists():
            return str(c)
    found = shutil.which(name)
    if not found:
        sys.exit(f"{name} not found; install MariaDB or set MARIADB_BIN to its bin folder")
    return found


def start() -> None:
    if not DATA.exists():
        DATA.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([binary("mariadb-install-db"), f"--datadir={DATA}", f"--password={ROOT_PASSWORD}"], check=True)
    flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS if os.name == "nt" else 0
    subprocess.Popen(
        [binary("mariadbd"), f"--datadir={DATA}", f"--port={PORT}", "--bind-address=127.0.0.1", "--skip-name-resolve"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags, start_new_session=os.name != "nt",
    )
    for _ in range(50):
        try:
            conn = pymysql.connect(host="127.0.0.1", port=PORT, user="root", password=ROOT_PASSWORD)
            break
        except pymysql.err.OperationalError:
            time.sleep(0.2)
    else:
        sys.exit("the server didn't come up; check .db/data/*.err")
    with conn.cursor() as cur:
        cur.execute(f"CREATE DATABASE IF NOT EXISTS {DB}")
        cur.execute(f"CREATE USER IF NOT EXISTS '{USER}'@'127.0.0.1' IDENTIFIED BY '{PASSWORD}'")
        cur.execute(f"GRANT ALL PRIVILEGES ON {DB}.* TO '{USER}'@'127.0.0.1'")
    conn.close()
    print(f"database {DB} ready on 127.0.0.1:{PORT}")


def stop() -> None:
    subprocess.run([binary("mariadb-admin"), "-h", "127.0.0.1", f"-P{PORT}", "-u", "root", f"-p{ROOT_PASSWORD}", "shutdown"], check=False)
    print("stopped")


if __name__ == "__main__":
    {"start": start, "stop": stop}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: print(__doc__))()
