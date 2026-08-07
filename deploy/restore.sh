#!/usr/bin/env bash
#
# Pemulihan basis data produksi.
#
# MENGHANCURKAN data yang ada. Skrip menuntut konfirmasi yang diketik penuh —
# bukan "y" — karena perintah pemulihan yang dijalankan di terminal yang salah
# adalah cara kehilangan produksi, bukan menyelamatkannya.
#
#   ./deploy/restore.sh <berkas.dump> [env-file]

set -euo pipefail

# MSYS_NO_PATHCONV mematikan penerjemahan jalur Git Bash.
#
# Tanpa ini, `/backup/x.dump` diubah menjadi `C:/Program Files/Git/backup/x.dump`
# SEBELUM sampai ke kontainer, dan pg_dump gagal dengan "No such file or
# directory" yang menunjuk jalur yang tidak pernah diminta siapa pun.
# Variabel ini tidak berarti apa-apa di Linux dan macOS, jadi aman disetel
# di mana saja.
export MSYS_NO_PATHCONV=1

DUMP="${1:?berkas dump wajib — mis. kantongz-20260808T041500Z.dump}"
ENV_FILE="${2:-.env.prod}"
COMPOSE="docker compose --env-file ${ENV_FILE} -f docker-compose.prod.yml"

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

printf '\n\033[31mINI MENGHAPUS SELURUH ISI BASIS DATA "%s".\033[0m\n' "$POSTGRES_DB"
printf 'Sumber: %s\n\n' "$DUMP"
printf 'Ketik PULIHKAN untuk melanjutkan: '
read -r answer
[ "$answer" = "PULIHKAN" ] || { printf 'Dibatalkan.\n'; exit 1; }

# API dihentikan lebih dulu. Memulihkan di bawah tulisan yang masih berjalan
# menghasilkan basis data yang setengah lama setengah baru, dan tidak ada
# apa pun yang akan menandainya.
printf '\nMenghentikan API dan web…\n'
$COMPOSE stop api web

printf 'Memulihkan…\n'
$COMPOSE exec -T postgres pg_restore \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists --no-owner --no-privileges \
  "/backup/$(basename "$DUMP")"

printf 'Menyalakan ulang…\n'
$COMPOSE up -d api web

printf '\nMenunggu kesiapan…\n'
for _ in $(seq 1 60); do
  if $COMPOSE exec -T api node -e \
    "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    printf '\033[32mPemulihan selesai dan API siap.\033[0m\n'
    exit 0
  fi
  sleep 2
done

printf '\033[31mAPI tidak siap setelah pemulihan. Periksa log.\033[0m\n' >&2
exit 1
