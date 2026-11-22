#!/bin/bash
mkdir -p temp auth_session
echo "Memeriksa sintaks index.js..."
if ! node -c index.js; then
  echo "Error sintaks ditemukan di index.js!"
  exit 1
fi

while true; do
  echo "Menjalankan Ochild Bot AI..."
  node index.js
  echo "Bot terhenti. Menjalankan ulang dalam 3 detik..."
  sleep 3
done
