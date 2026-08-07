#!/usr/bin/env bash
#
# Cadangan basis data produksi.
#
# `pg_dump` format CUSTOM (-Fc), bukan SQL polos. Tiga alasan, dan yang ketiga
# yang paling sering menyelamatkan:
#   1. Terkompresi sendiri.
#   2. `pg_restore` dapat memulihkan SEBAGIAN — satu tabel, tanpa yang lain.
#   3. Ia menyimpan urutan dependensi, jadi pemulihan tidak gagal karena
#      foreign key yang tabelnya belum ada.
#
#   ./deploy/backup.sh [env-file]

set -euo pipefail

# MSYS_NO_PATHCONV mematikan penerjemahan jalur Git Bash.
#
# Tanpa ini, `/backup/x.dump` diubah menjadi `C:/Program Files/Git/backup/x.dump`
# SEBELUM sampai ke kontainer, dan pg_dump gagal dengan "No such file or
# directory" yang menunjuk jalur yang tidak pernah diminta siapa pun.
# Variabel ini tidak berarti apa-apa di Linux dan macOS, jadi aman disetel
# di mana saja.
export MSYS_NO_PATHCONV=1

ENV_FILE="${1:-.env.prod}"
COMPOSE="docker compose --env-file ${ENV_FILE} -f docker-compose.prod.yml"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="/backup/kantongz-${STAMP}.dump"

# Nilai diambil dengan grep, BUKAN dengan `. "$ENV_FILE"`.
#
# Berkas .env BUKAN skrip shell. Kunci PEM di dalamnya memuat spasi dan
# tanda baca yang tidak dikutip, dan menyumbernya menghasilkan:
#
#   .env.prod: line 48: PRIVATE: command not found
#
# Hanya dua nilai yang dibutuhkan di sini, dan keduanya sederhana.
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }
POSTGRES_USER="$(envval POSTGRES_USER)"
POSTGRES_DB="$(envval POSTGRES_DB)"

printf 'Mencadangkan ke %s\n' "$OUT"

$COMPOSE exec -T postgres pg_dump \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --format=custom --compress=9 --file="$OUT"

# Verifikasi SEGERA. Cadangan yang tidak dapat dibaca adalah berkas, bukan
# cadangan — dan satu-satunya waktu untuk mengetahuinya adalah SEKARANG,
# bukan saat pemulihan sungguhan sedang dibutuhkan.
if $COMPOSE exec -T postgres pg_restore --list "$OUT" > /dev/null 2>&1; then
  size="$($COMPOSE exec -T postgres stat -c %s "$OUT" | tr -d '[:space:]')"
  printf 'OK  %s byte, isi terbaca\n' "$size"
else
  printf 'GAGAL cadangan tidak dapat dibaca pg_restore\n' >&2
  exit 1
fi

# Retensi: simpan 14 terakhir. Tanpa ini disk penuh, dan disk penuh
# menghentikan Postgres sebelum menghentikan apa pun yang lain.
$COMPOSE exec -T postgres sh -c \
  'ls -1t /backup/kantongz-*.dump 2>/dev/null | tail -n +15 | xargs -r rm --'

printf 'Cadangan tersimpan di volume ./deploy/backup\n'
