#!/usr/bin/env bash
# Verifikasi ujung ke ujung terhadap tumpukan kontainer.
# Setiap langkah menegaskan SATU aturan; kegagalan mana pun menghentikan skrip.
set -uo pipefail

WEB=http://127.0.0.1:3100
API=http://127.0.0.1:3000
# Jalur RELATIF, bukan `mktemp`.
#
# `MSYS_NO_PATHCONV=1` di atas — yang dibutuhkan agar jalur di dalam kontainer
# tidak diterjemahkan — juga mematikan penerjemahan untuk curl.exe, dan curl
# adalah biner WINDOWS. Ia menerima `/tmp/tmp.AbC` apa adanya, mencoba menulis
# ke `C:\tmp\tmp.AbC`, dan diam-diam tidak menulis apa pun. Berkas header yang
# selalu kosong itulah yang membuat SELURUH sesi tampak gagal.
#
# Jalur relatif dipahami curl mana pun, di sistem mana pun.
HDR='./.e2e-headers.tmp'
COOKIE=''
PASS=0
FAIL=0

# ── KUKI DISIMPAN SENDIRI, BUKAN LEWAT TOPLES curl ─────────────────────
#
# Skrip ini dulu memakai `curl -c/-b` dan gagal pada 23 penegasan sekaligus,
# seluruhnya berakar pada satu baris: kuki `kz_rt` tidak pernah tersimpan.
#
# SEBABNYA BUKAN PRODUKNYA. BFF menyetel kuki dengan atribut `Secure`, dan
# curl MENOLAK menyimpan kuki `Secure` yang tiba lewat `http://` — tanpa
# pengecualian. Peramban justru memberi `localhost` pengecualian "asal
# tepercaya" dan menyimpannya.
#
# Dibuktikan di peramban sungguhan terhadap susunan yang sama: daftar →
# verifikasi → `POST /api/auth/refresh` menjawab **200** dengan access token
# RS256 yang HANYA bisa datang dari kuki httpOnly itu. Alur masuknya utuh.
#
# Jadi toplesnya yang salah, bukan produknya — dan gerbang yang merah karena
# perkakasnya melatih orang mengabaikan gerbang. Kuki kini dibaca dari header
# respons dan dikirim balik sendiri, yang juga menguji LEBIH banyak: atributnya
# ditegaskan satu per satu alih-alih dipercayakan pada toples.
serap() {
  local pairs
  pairs=$(sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p' "$HDR" | tr -d '\r' | tr '\n' ';' | sed 's/;$//')
  [ -n "$pairs" ] && COOKIE="$pairs"
  return 0
}

ok()   { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✗ %s — %s\n' "$1" "${2:-}"; }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "harap $3, dapat $2"; fi; }

sec() { printf '\n== %s ==\n' "$1"; }

# Kode verifikasi diambil dari baris outbox — persis yang akan dibaca pekerja
# pengiriman. Kolomnya di-hash argon2id di `tickets`, jadi outbox adalah
# satu-satunya tempat kode masih terbaca, dan hanya sampai pekerja menerbitkannya.
kode() {
  docker compose --env-file .env.docker exec -T postgres \
    psql -qtAX -U kantongz -d kantongz \
    -c "SELECT payload->>'code' FROM outbox WHERE idempotency_key = '$1' LIMIT 1" 2>/dev/null | tr -d '\r' | tr -d ' '
}

EMAIL="e2e$(date +%s%N | tail -c 8)@contoh.id"
SANDI="kantongz-sandi-kuat"

# Kesiapan ditunggu sebelum apa pun ditegaskan. `/readyz` yang menjawab 503 di
# jendela boot BUKAN cacat — itu justru perilaku yang benar, dan penyeimbang
# beban pun menunggu hal yang sama sebelum mengirim lalu lintas.
printf 'menunggu kesiapan'
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' $API/readyz)" = "200" ] && break
  printf '.'; sleep 1
done
printf '
'

sec "Infrastruktur"
is "postgres sehat" "$(docker compose --env-file .env.docker ps postgres --format '{{.Health}}')" "healthy"
is "redis sehat"    "$(docker compose --env-file .env.docker ps redis    --format '{{.Health}}')" "healthy"
is "api sehat"      "$(docker compose --env-file .env.docker ps api      --format '{{.Health}}')" "healthy"
is "web sehat"      "$(docker compose --env-file .env.docker ps web      --format '{{.Health}}')" "healthy"
is "/livez"  "$(curl -s -o /dev/null -w '%{http_code}' $API/livez)"  "200"
is "/readyz" "$(curl -s -o /dev/null -w '%{http_code}' $API/readyz)" "200"

HEALTH=$(curl -s $API/healthz)
echo "$HEALTH" | grep -q '"postgres","ok":true' && ok "healthz: postgres" || bad "healthz: postgres"
echo "$HEALTH" | grep -q '"redis","ok":true'    && ok "healthz: redis"    || bad "healthz: redis"
echo "$HEALTH" | grep -q '"outbox"'             && ok "healthz: kedalaman outbox dilaporkan" || bad "healthz: outbox"

sec "JWKS"
JWKS=$(curl -s $API/.well-known/jwks.json)
echo "$JWKS" | grep -q '"kty":"RSA"' && ok "kunci publik diterbitkan" || bad "jwks"
echo "$JWKS" | grep -q '"d":'        && bad "kunci PRIVAT bocor di jwks" || ok "kunci privat tidak ikut"

sec "Pendaftaran (lewat BFF)"
REG=$(curl -s -D "$HDR" -X POST "$WEB/api/auth/register" -H 'content-type: application/json' \
  -d "{\"fullName\":\"Uji Kontainer\",\"email\":\"$EMAIL\",\"password\":\"$SANDI\"}")
serap
TICKET=$(echo "$REG" | sed -n 's/.*"ticket":"\([^"]*\)".*/\1/p')
[ -n "$TICKET" ] && ok "tiket diterbitkan" || bad "tiket" "$REG"
echo "$REG" | grep -q '"maskedEmail"' && ok "email disamarkan" || bad "maskedEmail"

CODE=$(kode "verify:$TICKET")
[ -n "$CODE" ] && ok "outbox memuat kode verifikasi" || bad "outbox kosong"

sec "Verifikasi & sesi"
VER=$(curl -s -D "$HDR" -H "cookie: $COOKIE" -X POST "$WEB/api/auth/verify" -H 'content-type: application/json' \
  -d "{\"ticket\":\"$TICKET\",\"code\":\"$CODE\"}")
SETC=$(grep -i '^set-cookie:' "$HDR" | tr -d '\r')
serap
echo "$VER" | grep -q '"accessToken"' && ok "sesi diterbitkan" || bad "sesi" "$VER"
[ "$(echo "$VER" | grep -c refreshToken)" = "0" ] && ok "refresh token TIDAK ada di badan" || bad "refresh token bocor ke klien"

# Atribut ditegaskan SATU PER SATU pada header aslinya. Toples curl hanya bisa
# menjawab "ada atau tidak"; ini menjawab "dengan perlindungan apa".
echo "$SETC" | grep -q 'kz_rt='                    && ok "kuki kz_rt diterbitkan"   || bad "kuki kz_rt" "$SETC"
[ "$(echo "$SETC" | grep -ci 'HttpOnly')" -ge 2 ]  && ok "kedua kuki HttpOnly"      || bad "kuki tidak HttpOnly" "$SETC"
[ "$(echo "$SETC" | grep -ci 'Secure')" -ge 2 ]    && ok "kedua kuki Secure"        || bad "kuki tidak Secure" "$SETC"
[ "$(echo "$SETC" | grep -ci 'SameSite=lax')" -ge 2 ] && ok "kedua kuki SameSite=Lax" || bad "kuki tanpa SameSite" "$SETC"
RT_VAL=$(echo "$SETC" | sed -n 's/.*kz_rt=\([^;]*\).*/\1/p' | head -1)
if [ -z "$RT_VAL" ]; then
  bad "nilai kz_rt tidak terbaca dari header" "$SETC"
elif echo "$VER" | grep -qF "$RT_VAL"; then
  bad "nilai refresh token muncul di badan respons"
else
  ok "nilai kuki tidak digemakan ke badan"
fi

sec "Penyegaran token"
R=$(curl -s -D "$HDR" -H "cookie: $COOKIE" -X POST "$WEB/api/auth/refresh" -H 'content-type: application/json' -d '{}')
serap
AT=$(echo "$R" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
[ -n "$AT" ] && ok "disegarkan hanya dengan kuki" || bad "refresh" "$R"
AUTH=(-H "authorization: Bearer $AT")

sec "Otorisasi"
is "/v1/accounts tanpa token" "$(curl -s -o /dev/null -w '%{http_code}' $API/v1/accounts)" "401"
is "/v1/me token asing" "$(curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer palsu' $API/v1/auth/me)" "401"
ME=$(curl -s "${AUTH[@]}" $API/v1/auth/me)
echo "$ME" | grep -q "$EMAIL" && ok "/v1/auth/me mengembalikan pengguna" || bad "me" "$ME"

sec "Dompet"
A1=$(curl -s "${AUTH[@]}" -X POST $API/v1/accounts -H 'content-type: application/json' \
  -d '{"name":"Bank","kind":"bank","openingBalance":10000000}')
AID=$(echo "$A1" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
A2=$(curl -s "${AUTH[@]}" -X POST $API/v1/accounts -H 'content-type: application/json' \
  -d '{"name":"Kas","kind":"cash","openingBalance":500000}')
BID=$(echo "$A2" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$AID" ] && [ -n "$BID" ] && ok "dua dompet dibuat" || bad "dompet"
echo "$A1" | grep -q '"balance":10000000' && ok "saldo awal dihitung" || bad "saldo awal"

sec "Kategori"
CATS=$(curl -s "${AUTH[@]}" $API/v1/categories)
CID=$(echo "$CATS" | sed -n 's/.*{"id":"\(cat_[^"]*\)","name":"Makan & Minum".*/\1/p')
[ -n "$CID" ] && ok "kategori bawaan tertanam" || bad "kategori bawaan"

sec "Transaksi"
is "pengeluaran" "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST $API/v1/transactions -H 'content-type: application/json' \
  -d "{\"accountId\":\"$AID\",\"categoryId\":\"$CID\",\"kind\":\"expense\",\"amount\":250000,\"occurredAt\":$(date +%s)000,\"merchant\":\"Warung\"}")" "201"
is "pemasukan" "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST $API/v1/transactions -H 'content-type: application/json' \
  -d "{\"accountId\":\"$AID\",\"kind\":\"income\",\"amount\":7500000,\"occurredAt\":$(date +%s)000}")" "201"
is "transfer" "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST $API/v1/transactions -H 'content-type: application/json' \
  -d "{\"accountId\":\"$AID\",\"counterAccountId\":\"$BID\",\"kind\":\"transfer\",\"amount\":1000000,\"occurredAt\":$(date +%s)000}")" "201"
is "jumlah nol ditolak" "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST $API/v1/transactions -H 'content-type: application/json' \
  -d "{\"accountId\":\"$AID\",\"kind\":\"expense\",\"amount\":0,\"occurredAt\":$(date +%s)000}")" "422"
is "transfer ke diri sendiri ditolak" "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -X POST $API/v1/transactions -H 'content-type: application/json' \
  -d "{\"accountId\":\"$AID\",\"counterAccountId\":\"$AID\",\"kind\":\"transfer\",\"amount\":1000,\"occurredAt\":$(date +%s)000}")" "422"

BAL=$(curl -s "${AUTH[@]}" $API/v1/accounts)
echo "$BAL" | grep -q '"name":"Bank","kind":"bank","currency":"IDR","openingBalance":10000000,"balance":16250000' \
  && ok "saldo Bank = 10.000.000 − 250.000 + 7.500.000 − 1.000.000" || bad "saldo Bank" "$(echo "$BAL" | head -c 200)"
echo "$BAL" | grep -q '"name":"Kas","kind":"cash","currency":"IDR","openingBalance":500000,"balance":1500000' \
  && ok "saldo Kas = 500.000 + 1.000.000" || bad "saldo Kas"

sec "Anggaran"
BG=$(curl -s "${AUTH[@]}" -X POST $API/v1/budgets -H 'content-type: application/json' \
  -d "{\"categoryId\":\"$CID\",\"period\":\"monthly\",\"amount\":2000000}")
echo "$BG" | grep -q '"spent":250000' && ok "terpakai dihitung dari transaksi" || bad "anggaran spent" "$BG"

sec "Tujuan"
G=$(curl -s "${AUTH[@]}" -X POST $API/v1/goals -H 'content-type: application/json' \
  -d '{"name":"Dana Darurat","targetAmount":1000000}')
GID=$(echo "$G" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
G2=$(curl -s "${AUTH[@]}" -X POST "$API/v1/goals/$GID/contribute" -H 'content-type: application/json' -d '{"amount":1000000}')
echo "$G2" | grep -q '"achieved":true' && ok "tujuan tercapai saat target terpenuhi" || bad "tujuan" "$G2"
G3=$(curl -s "${AUTH[@]}" -X POST "$API/v1/goals/$GID/contribute" -H 'content-type: application/json' -d '{"amount":-2000000}')
echo "$G3" | grep -q '"savedAmount":0' && ok "tabungan tidak pernah negatif" || bad "tujuan negatif" "$G3"

sec "Analitik & Dasbor"
CF=$(curl -s "${AUTH[@]}" "$API/v1/analytics/cashflow?days=30")
echo "$CF" | grep -q '"bucket"' && ok "arus kas berkelompok per hari" || bad "cashflow" "$CF"
D=$(curl -s "${AUTH[@]}" $API/v1/dashboard)
echo "$D" | grep -q '"netWorth":17750000' && ok "kekayaan bersih 17.750.000" || bad "netWorth" "$(echo "$D" | head -c 160)"
echo "$D" | grep -q '"monthIncome":7500000' && ok "pemasukan bulan ini" || bad "monthIncome"
echo "$D" | grep -q '"monthExpense":250000' && ok "transfer TIDAK dihitung sebagai pengeluaran" || bad "monthExpense"
echo "$D" | grep -q '"categoryName":"Makan & Minum"' && ok "kategori teratas" || bad "topCategories"

sec "Laporan"
NOW=$(date +%s)000
RP=$(curl -s "${AUTH[@]}" "$API/v1/transactions?limit=100&from=1&to=$NOW")
[ "$(echo "$RP" | grep -o '"id":"trx_' | wc -l)" = "3" ] && ok "laporan memuat 3 transaksi" || bad "laporan"

sec "Pemulihan sandi"
F=$(curl -s -X POST "$WEB/api/auth/password/forgot" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\"}")
FT=$(echo "$F" | sed -n 's/.*"ticket":"\([^"]*\)".*/\1/p')
FC=$(kode "reset:$FT")
[ -n "$FC" ] && ok "kode pemulihan masuk outbox" || bad "outbox reset"
# Alamat unik per jalan: kuota pemulihan adalah 5 per jam PER ALAMAT (§12), dan
# alamat tetap akan kehabisan kuota setelah lima kali skrip ini dijalankan.
HANTU=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WEB/api/auth/password/forgot" -H 'content-type: application/json' -d "{\"email\":\"hantu-$(date +%s%N | tail -c 9)@contoh.id\"}")
is "email asing tetap 200 (tanpa enumerasi)" "$HANTU" "200"

sec "Penguncian"
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -X POST "$WEB/api/auth/sign-in" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"salah-terus\"}"
done
LOCK=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WEB/api/auth/sign-in" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$SANDI\"}")
is "sandi BENAR tetap ditolak saat terkunci" "$LOCK" "429"

sec "Keluar"
is "sign-out" "$(curl -s -D "$HDR" -H "cookie: $COOKIE" -o /dev/null -w '%{http_code}' -X POST "$WEB/api/auth/sign-out" -H 'content-type: application/json' -d '{}')" "200"
serap  # sign-out MENGOSONGKAN kz_rt; kuki kosong itu yang harus dikirim balik
is "refresh sesudah keluar" "$(curl -s -H "cookie: $COOKIE" -o /dev/null -w '%{http_code}' -X POST "$WEB/api/auth/refresh" -H 'content-type: application/json' -d '{}')" "401"

sec "CORS"
# Kebijakan ini HANYA ditegakkan peramban; curl mengabaikannya. Yang diperiksa
# di sini adalah apakah header-nya benar-benar dikirim — tanpanya panggilan
# buku besar dari peramban diblokir sebelum sempat berangkat.
CH=$(curl -s -D- -o /dev/null -H 'origin: http://localhost:3100' $API/v1/accounts | tr -d '
')
echo "$CH" | grep -qi 'access-control-allow-origin: http://localhost:3100' && ok "asal web diizinkan" || bad "CORS asal web"
CA=$(curl -s -D- -o /dev/null -H 'origin: https://penyerang.contoh' $API/v1/accounts | tr -d '
')
echo "$CA" | grep -qi 'access-control-allow-origin' && bad "asal asing diizinkan" || ok "asal asing ditolak"
PF=$(curl -s -D- -o /dev/null -X OPTIONS $API/v1/transactions   -H 'origin: http://localhost:3100' -H 'access-control-request-method: POST'   -H 'access-control-request-headers: authorization,content-type' | tr -d '
')
echo "$PF" | grep -qi 'access-control-allow-headers:.*authorization' && ok "preflight mengizinkan authorization" || bad "preflight"

sec "Frontend"
for p in / /masuk /daftar /pulihkan; do
  is "halaman $p" "$(curl -s -o /dev/null -w '%{http_code}' "$WEB$p")" "200"
done
curl -s -D- -o /dev/null "$WEB/masuk" | grep -qi 'x-frame-options: DENY' && ok "header X-Frame-Options" || bad "X-Frame-Options"

printf '\n────────────────────────\n  LULUS %d   GAGAL %d\n────────────────────────\n' "$PASS" "$FAIL"
rm -f "$HDR"
exit $((FAIL > 0 ? 1 : 0))
