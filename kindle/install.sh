#!/bin/bash
# ==============================================================================
# Helper to copy & install attentionboard.sh to a jailbroken Kindle via SSH
# ==============================================================================

if [ -z "$1" ]; then
    echo "Usage: ./kindle/install.sh <KINDLE_IP> [MAC_IP]"
    echo "Example: ./kindle/install.sh 192.168.1.50 192.168.1.25"
    exit 1
fi

KINDLE_IP="$1"
MAC_IP="$2"
SCRIPT_SRC="kindle/attentionboard.sh"

if [ -n "$MAC_IP" ]; then
    # Patch a temporary copy so the repository file stays clean.
    SCRIPT_SRC=$(mktemp /tmp/attentionboard.XXXXXX)
    sed "s|SERVER_IP=\".*\"|SERVER_IP=\"$MAC_IP\"|" kindle/attentionboard.sh > "$SCRIPT_SRC"
fi

echo "==> Deploying attentionboard.sh to Kindle ($KINDLE_IP)..."
scp "$SCRIPT_SRC" root@"$KINDLE_IP":/mnt/us/attentionboard.sh

if [ "$SCRIPT_SRC" != "kindle/attentionboard.sh" ]; then
    rm -f "$SCRIPT_SRC"
fi

echo "==> Setting permissions and running diagnostic check..."
ssh root@"$KINDLE_IP" "chmod +x /mnt/us/attentionboard.sh && fbink -v"

echo "==> Done! You can run it on Kindle with:"
echo "    ssh root@$KINDLE_IP '/mnt/us/attentionboard.sh > /dev/null 2>&1 &'"
