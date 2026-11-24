
#!/bin/bash

set -u

cd "$(dirname "$0")" || exit 1

mkdir -p temp auth_session

echo "[START] Memeriksa sintaks index.js..."

if ! node --check index.js; then
    echo "[ERROR] Sintaks index.js tidak valid!"
    exit 1
fi

echo "[START] Menjalankan Ochild Bot AI..."

child_pid=""

shutdown() {
    echo "[STOP] Menghentikan bot..."
    if [ -n "$child_pid" ]; then
        kill -TERM "$child_pid" 2>/dev/null || true
        wait "$child_pid" 2>/dev/null || true
    fi
    exit 0
}

trap shutdown SIGTERM SIGINT

while true; do
    node index.js &
    child_pid=$!

    wait "$child_pid"
    status=$?
    child_pid=""

    echo "[WARNING] Bot berhenti dengan kode: $status"

    if [ "$status" -eq 0 ]; then
        echo "[STOP] Bot berhenti normal."
        exit 0
    fi

    echo "[RESTART] Mencoba menjalankan ulang dalam 5 detik..."
    sleep 5
done
