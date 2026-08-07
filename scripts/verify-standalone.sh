#!/usr/bin/env bash
# Verifikasi ujung ke ujung terhadap backend MANDIRI.
#
# Pasangan dari `scripts/e2e.sh`, yang menuntut tumpukan Docker. Berkas ini
# hanya menuntut `npm run dev:standalone` — PostgreSQL dalam proses dan Redis
# dalam memori. Gunanya satu: seluruh produk dapat diverifikasi di satu mesin
# tanpa Docker, tanpa akun, dan tanpa biaya.
#
# Kode verifikasi dibaca dari keluaran proses, yang dalam mode mandiri memang
# mencetaknya. Di produksi kode itu berangkat lewat outbox ke SMTP dan tidak
# pernah muncul di log mana pun.
set -uo pipefail

API=${API:-http://127.0.0.1:3000}
LOG=${LOG:-/tmp/kz-sa.log}
PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  ✗ %s — %s\n' "$1" "${2:-}"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "harap $3, dapat $2"; fi; }
sec() { printf '\n== %s ==\n' "$1"; }

# Menelusuri JSON lewat jalur berpisah titik. Tanpa `eval` — jalur yang
# disisipkan ke dalam string Python lewat shell akan bertabrakan kutipnya, dan
# itulah yang membuat versi pertama skrip ini gagal mengekstrak seluruh nilai.
json() {
  python -c "
import json, sys
value = json.load(sys.stdin)
for part in sys.argv[1].split('.'):
    if part == '':
        continue
    value = value[int(part)] if part.isdigit() else value[part]
print(value)
" "$1" 2>/dev/null
}

EMAIL="sa$(date +%s%N | tail -c 8)@contoh.id"
SANDI="kantongz-sandi-kuat"

sec "Kesehatan"
is "/livez"  "$(curl -s -o /dev/null -w '%{http_code}' $API/livez)"  "200"
is "/readyz" "$(curl -s -o /dev/null -w '%{http_code}' $API/readyz)" "200"
curl -s $API/healthz | grep -q '"outbox"' && ok "kedalaman outbox dilaporkan" || bad "outbox"

sec "OpenAPI"
curl -s $API/openapi.json | grep -q '"openapi":"3.1.0"' && ok "dokumen disajikan" || bad "openapi"
curl -s $API/.well-known/jwks.json | grep -q '"d":' && bad "kunci privat bocor" || ok "kunci privat tidak ikut"

sec "Pendaftaran"
REG=$(curl -s -X POST $API/v1/auth/register -H 'content-type: application/json' \
  -d "{\"fullName\":\"Uji Mandiri\",\"email\":\"$EMAIL\",\"password\":\"$SANDI\",\"device\":{\"deviceId\":\"sa-device-01\",\"platform\":\"web\"}}")
TICKET=$(echo "$REG" | json 'data.ticket')
[ -n "$TICKET" ] && ok "tiket diterbitkan" || bad "tiket" "$REG"

# Mode mandiri mencetak kodenya; produksi tidak pernah.
CODE=$(grep -o 'kode [0-9]\{6\}' "$LOG" | tail -1 | awk '{print $2}')
[ -n "$CODE" ] && ok "kode tersalurkan" || bad "kode tidak ditemukan di keluaran"

sec "Verifikasi & sesi"
VER=$(curl -s -X POST $API/v1/auth/verify -H 'content-type: application/json' \
  -d "{\"ticket\":\"$TICKET\",\"code\":\"$CODE\",\"device\":{\"deviceId\":\"sa-device-01\",\"platform\":\"web\"}}")
AT=$(echo "$VER" | json 'data.tokens.accessToken')
RT=$(echo "$VER" | json 'data.tokens.refreshToken')
[ -n "$AT" ] && ok "sesi diterbitkan" || bad "sesi" "$VER"
AUTH=(-H "authorization: Bearer $AT")

sec "Otorisasi"
is "/v1/accounts tanpa token" "$(curl -s -o /dev/null -w '%{http_code}' $API/v1/accounts)" "401"
is "/v1/insights tanpa token" "$(curl -s -o /dev/null -w '%{http_code}' $API/v1/insights)" "401"
is "/v1/assistant/summary tanpa token" "$(curl -s -o /dev/null -w '%{http_code}' $API/v1/assistant/summary)" "401"
is "/v1/receipts/scan tanpa token" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/v1/receipts/scan -H 'content-type: image/png' --data-binary $'\x89PNG')" "401"

sec "Buku besar"
A=$(curl -s "${AUTH[@]}" -X POST $API/v1/accounts -H 'content-type: application/json' \
  -d '{"name":"Bank","kind":"bank","openingBalance":10000000}')
AID=$(echo "$A" | json 'data.id')
[ -n "$AID" ] && ok "dompet dibuat" || bad "dompet" "$A"

CID=$(curl -s "${AUTH[@]}" $API/v1/categories | python -c "
import json,sys
for c in json.load(sys.stdin)['data']:
    if c['name'] == 'Makan & Minum': print(c['id']); break
" 2>/dev/null)
[ -n "$CID" ] && ok "kategori bawaan tertanam" || bad "kategori"

NOW=$(date +%s)000
is "catat pengeluaran" "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST $API/v1/transactions \
  -H 'content-type: application/json' \
  -d "{\"accountId\":\"$AID\",\"categoryId\":\"$CID\",\"kind\":\"expense\",\"amount\":250000,\"occurredAt\":$NOW,\"merchant\":\"Warung Padang\"}")" "201"

BAL=$(curl -s "${AUTH[@]}" $API/v1/accounts | json 'data.0.balance')
is "saldo 10.000.000 − 250.000" "$BAL" "9750000"

sec "Wawasan (deterministik)"
INS=$(curl -s "${AUTH[@]}" $API/v1/insights)
echo "$INS" | grep -q '"projection"' && ok "proyeksi arus kas hadir" || bad "proyeksi"
echo "$INS" | grep -q '"reliable":false' && ok "menyatakan datanya belum cukup" || bad "reliable"
curl -s "${AUTH[@]}" $API/v1/insights/suggestions | grep -q '"data"' && ok "usulan kategori" || bad "usulan"

sec "Asisten (tanpa kredensial awan)"
SUM=$(curl -s "${AUTH[@]}" $API/v1/assistant/summary)
echo "$SUM" | grep -q '"narrativeSource"' && ok "ringkasan terbit" || bad "ringkasan" "$SUM"
echo "$SUM" | grep -qE '"narrativeSource":"(template|model)"' && ok "sumber narasi dinyatakan" || bad "narrativeSource"

SIM=$(curl -s "${AUTH[@]}" -X POST $API/v1/assistant/simulate -H 'content-type: application/json' \
  -d '{"monthlyCommitment":1200000,"months":24}')
echo "$SIM" | grep -qE '"verdict":"(aman|ketat|tidak_aman)"' && ok "simulasi menjawab" || bad "simulasi" "$SIM"

sec "Snap-Struk"
is "menolak berkas bukan gambar" "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST $API/v1/receipts/scan \
  -H 'content-type: image/png' --data-binary 'bukan gambar sama sekali')" "422"

sec "Rotasi & keluar"
R=$(curl -s -X POST $API/v1/auth/refresh -H 'content-type: application/json' \
  -d "{\"refreshToken\":\"$RT\",\"device\":{\"deviceId\":\"sa-device-01\",\"platform\":\"web\"}}")
NRT=$(echo "$R" | json 'data.refreshToken')
[ -n "$NRT" ] && [ "$NRT" != "$RT" ] && ok "token dirotasi" || bad "rotasi" "$R"

is "keluar" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/v1/auth/sign-out \
  -H 'content-type: application/json' -d "{\"refreshToken\":\"$NRT\"}")" "200"
is "refresh sesudah keluar" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/v1/auth/refresh \
  -H 'content-type: application/json' \
  -d "{\"refreshToken\":\"$NRT\",\"device\":{\"deviceId\":\"sa-device-01\",\"platform\":\"web\"}}")" "401"

sec "Penguncian"
for _ in 1 2 3 4 5; do
  curl -s -o /dev/null -X POST $API/v1/auth/sign-in -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"salah-terus\",\"device\":{\"deviceId\":\"sa-device-01\",\"platform\":\"web\"}}"
done
is "sandi BENAR tetap ditolak saat terkunci" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/v1/auth/sign-in \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$SANDI\",\"device\":{\"deviceId\":\"sa-device-01\",\"platform\":\"web\"}}")" "429"

printf '\n────────────────────────\n  LULUS %d   GAGAL %d\n────────────────────────\n' "$PASS" "$FAIL"
exit $((FAIL > 0 ? 1 : 0))
