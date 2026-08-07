#!/usr/bin/env bash
#
# Rollback ke citra versi sebelumnya.
#
# Menuju DIGEST, bukan tag. Tag dapat dipindahkan — `v1.0.0` yang didorong
# ulang menunjuk byte yang berbeda sambil terlihat sama. Digest tidak bisa,
# dan itulah satu-satunya jaminan bahwa yang dipulihkan benar-benar yang
# pernah berjalan.
#
#   ./deploy/rollback.sh <api-ref> <web-ref> [env-file]
#
# Contoh:
#   ./deploy/rollback.sh \
#     ghcr.io/owner/kantongz-api@sha256:abc... \
#     ghcr.io/owner/kantongz-web@sha256:def...

set -euo pipefail
export MSYS_NO_PATHCONV=1

API_REF="${1:?rujukan citra API wajib — utamakan @sha256:digest}"
WEB_REF="${2:?rujukan citra web wajib}"
ENV_FILE="${3:-.env.prod}"
COMPOSE="docker compose --env-file ${ENV_FILE} -f docker-compose.prod.yml"

printf '\nRollback ke:\n  api: %s\n  web: %s\n\n' "$API_REF" "$WEB_REF"

case "$API_REF" in
  *@sha256:*) ;;
  *) printf '\033[33mPERINGATAN: rujukan API memakai tag, bukan digest.\033[0m\n'
     printf 'Tag dapat dipindahkan; yang dipulihkan mungkin bukan yang pernah berjalan.\n\n' ;;
esac

printf 'Ketik ROLLBACK untuk melanjutkan: '
read -r answer
[ "$answer" = "ROLLBACK" ] || { printf 'Dibatalkan.\n'; exit 1; }

# Citra ditarik LEBIH DULU, sebelum apa pun dihentikan. Menarik setelah
# menghentikan berarti waktu henti mencakup waktu unduh — dan bila unduhnya
# gagal, tidak ada yang bisa dinyalakan kembali.
printf '\nMenarik citra…\n'
docker pull "$API_REF"
docker pull "$WEB_REF"

# CATATAN MIGRASI — baca sebelum menjalankan.
#
# Rollback ini mengembalikan KODE, bukan SKEMA. Bila rilis yang ditinggalkan
# menerapkan migrasi yang merusak kompatibilitas mundur, kode lama akan
# bertemu skema baru dan gagal dengan cara yang sulit dibaca.
#
# Migrasi di proyek ini bersifat aditif secara konvensi (kolom ditambah,
# tidak pernah dihapus di rilis yang sama), yang membuat rollback satu rilis
# aman. Rollback melewati beberapa rilis MENUNTUT pemeriksaan manual.
printf '\n\033[33mPeriksa: apakah ada migrasi antara versi ini dan yang berjalan?\033[0m\n'
printf 'Rollback mengembalikan kode, BUKAN skema.\n\n'

API_IMAGE="$API_REF" WEB_IMAGE="$WEB_REF" $COMPOSE up -d --no-deps api web

printf '\nMenunggu kesiapan…\n'
for _ in $(seq 1 60); do
  if $COMPOSE exec -T api node -e \
    "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    printf '\033[32mRollback selesai. API siap.\033[0m\n'
    printf 'Jalankan ./deploy/verify-prod.sh untuk verifikasi penuh.\n'
    exit 0
  fi
  sleep 2
done

printf '\033[31mAPI tidak siap setelah rollback. Periksa log:\033[0m\n' >&2
printf '  %s logs api --tail 50\n' "$COMPOSE" >&2
exit 1
