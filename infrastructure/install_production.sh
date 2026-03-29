#!/bin/bash
# ==============================================================================
# Nexus NMS V1.0 Enterprise - Production Installation Script 🚀
# ==============================================================================
# This script will securely generate randomly protected credentials 
# and assemble the .env.production file for your Linux bare-metal or VM!
# ==============================================================================

echo "============================================================"
echo "    Memulai Pemasangan Nexus NMS v1.0 (Production Mode)     "
echo "============================================================"

# Cek prasyarat (Docker & OpenSSL)
if ! command -v docker &> /dev/null; then
    echo "[!] Docker Engine tidak ditemukan! Silakan instal Docker terlebih dahulu."
    exit 1
fi
if ! command -v openssl &> /dev/null; then
    echo "[!] OpenSSL tidak ditemukan! Sistem gagal meracik Kunci Otentikasi."
    exit 1
fi

ENV_FILE=".env.production"

# Hapus credential lama jika ada
if [ -f "$ENV_FILE" ]; then
    read -p "[?] File $ENV_FILE sudah ada. Timpa ulang dengan sandi baru? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "[-] Menggunakan $ENV_FILE yang sudah eksis. Melompat ke tahap eksekusi Docker..."
        docker compose -f docker-compose.prod.yml --env-file $ENV_FILE up -d
        exit 0
    fi
fi

echo "[+] Meracik sandi rahasia mematikan untuk PostgreSQL, Keycloak, dan RabbitMQ..."

# Meminta IP Publik atau Domain dari Pengguna
echo ""
echo "------------------------------------------------------------"
read -p "[?] Masukkan IP Publik Remote atau Domain Server INI (contoh: 192.168.1.100 atau nms.corp.com): " INPUT_DOMAIN
SERVER_DOMAIN=$(echo "$INPUT_DOMAIN" | tr -d '\r' | xargs)
if [ -z "$SERVER_DOMAIN" ]; then
    SERVER_DOMAIN="localhost"
    echo "[-] Domain kosong. Jatuh kembali menggunakan 'localhost'."
fi
echo "------------------------------------------------------------"

# Generate sandi 16 karakter acak
POSTGRES_PASS=$(openssl rand -hex 16)
KEYCLOAK_ADMIN_PASS=$(openssl rand -hex 12)
RABBITMQ_PASS=$(openssl rand -hex 16)
GRAFANA_ADMIN_PASS=$(openssl rand -hex 12)
SECRET_KEY=$(openssl rand -hex 32)
ALGORITHM="HS256"
ACCESS_TOKEN_EXPIRE_MINUTES="1440"

# Membuat file .env.production
cat <<EOF > $ENV_FILE
# Nexus NMS Production Environment Secrets
# Dibuat otomatis pada: $(date)

# === Postgres Primary Inventory (Device Manager DB) ===
POSTGRES_USER=nexus_admin
POSTGRES_PASSWORD=${POSTGRES_PASS}
POSTGRES_DB=nms_db
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
DATABASE_URL=postgresql://nexus_admin:${POSTGRES_PASS}@postgres:5432/nms_db

# === TimescaleDB (Metrics & Logs) ===
TIMESCALEDB_USER=metrics_user
TIMESCALEDB_PASSWORD=${POSTGRES_PASS}
TIMESCALEDB_DB=nms_metrics
TIMESCALEDB_HOST=timescaledb
TIMESCALEDB_PORT=5432
TIMESCALEDB_URL=postgresql://metrics_user:${POSTGRES_PASS}@timescaledb:5432/nms_metrics

# === Keycloak IAM (OAuth 2.0 Identity Provider) ===
KC_BOOTSTRAP_ADMIN_USERNAME=nexus_commander
KC_BOOTSTRAP_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASS}
KC_DB=postgres
KC_DB_URL=jdbc:postgresql://postgres:5432/nms_db
KC_DB_USERNAME=nexus_admin
KC_DB_PASSWORD=${POSTGRES_PASS}
KC_HOSTNAME_URL=http://${SERVER_DOMAIN}/auth
KC_HOSTNAME_ADMIN_URL=http://${SERVER_DOMAIN}/auth
KC_HOSTNAME_STRICT=false
GF_SERVER_ROOT_URL=http://${SERVER_DOMAIN}/grafana/

# === RabbitMQ (Message Broker & Event Bus) ===
RABBITMQ_DEFAULT_USER=nexus_mq
RABBITMQ_DEFAULT_PASS=${RABBITMQ_PASS}
RABBITMQ_URL=amqp://nexus_mq:${RABBITMQ_PASS}@rabbitmq:5672/

# === Grafana (Observability Dashboard) ===
GF_SERVER_ROOT_URL=http://${SERVER_DOMAIN}/grafana/
GF_SECURITY_ADMIN_USER=nexus_grafana
GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASS}
GF_DATABASE_TYPE=postgres
GF_DATABASE_HOST=postgres:5432
GF_DATABASE_NAME=nms_db
GF_DATABASE_USER=nexus_admin
GF_DATABASE_PASSWORD=${POSTGRES_PASS}

# === FastAPI Backend Security ===
SECRET_KEY=${SECRET_KEY}
ALGORITHM=${ALGORITHM}
ACCESS_TOKEN_EXPIRE_MINUTES=${ACCESS_TOKEN_EXPIRE_MINUTES}

EOF

# Hapus CRLF Windows jika ada
sed -i 's/\r$//' $ENV_FILE 2>/dev/null || true

echo "[+] Berkas .env.production telah berhasil disegel."
echo "------------------------------------------------------------"
echo "  [INFORMASI AKUN PENTING - HARAP SIMPAN]"
echo "  🔹 Keycloak Admin Username : nexus_commander"
echo "  🔹 Keycloak Admin Password : $KEYCLOAK_ADMIN_PASS"
echo "  🔹 Grafana Admin Username  : nexus_grafana"
echo "  🔹 Grafana Admin Password  : $GRAFANA_ADMIN_PASS"
echo "------------------------------------------------------------"

echo "[+] Menyiapkan Traefik / NGINX Network dan meledakkan wadah kontainer produksi..."
echo "Menjalankan perintah: docker compose -f docker-compose.prod.yml --env-file $ENV_FILE up -d --build"
docker compose -f docker-compose.prod.yml --env-file $ENV_FILE up -d --build

echo "============================================================"
echo " ✅ NEXUS NMS v1.0 ENTERPRISE SUKSES DITAHTAKAN! "
echo "     Akses aplikasi di ujung laras Web (Port 80/443)."
echo "============================================================"
