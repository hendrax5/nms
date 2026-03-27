FROM python:3.11-slim

WORKDIR /app

# Install dependencies needed for pysnmp
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    python3-dev \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*
    
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Expose Syslog UDP (514) and SNMP Trap UDP (162)
EXPOSE 514/udp
EXPOSE 162/udp

CMD ["python", "main.py"]
