#!/bin/sh
# ==============================================================================
# Kindle AttentionBoard - Client Daemon for Jailbroken Kindle
#
# Tile-diff client:
#   1. Fetch /dash/manifest (band rects + pixel hashes).
#   2. Compare with the hashes from the previous cycle (cached in /tmp).
#   3. Download only what changed:
#        - a few bands  -> fetch each band, compose with `fbink -b`, then
#                          refresh just those rectangles with `fbink -s`
#        - most bands   -> fetch the full /dash.png and draw it once
#   4. Full flashing refresh every FULL_FLASH_EVERY cycles to clear ghosting.
#
# Optional argument:
#   1 | 2 | 3  -> switch the server's active tab, then keep mirroring it
#   next       -> cycle to the next tab
# ==============================================================================

SERVER_IP="${ATTENTIONBOARD_SERVER_IP:-192.168.1.4}"
SERVER_PORT="${ATTENTIONBOARD_SERVER_PORT:-8787}"
BASE_URL="http://${SERVER_IP}:${SERVER_PORT}"

INTERVAL_SECONDS="${INTERVAL_SECONDS:-60}"
FULL_FLASH_EVERY="${FULL_FLASH_EVERY:-30}"
# GL16: 16-level grayscale, faster than GC16, much cleaner than A2 on images.
WAVEFORM="${WAVEFORM:-GL16}"

STATE_DIR="/tmp"
MANIFEST="${STATE_DIR}/attentionboard.manifest"
CACHE="${STATE_DIR}/attentionboard.hashes"
NEW_CACHE="${STATE_DIR}/attentionboard.hashes.new"
DIRTY_LIST="${STATE_DIR}/attentionboard.dirty.list"
DIRTY_RECTS="${STATE_DIR}/attentionboard.dirty.rects"
TILE_IMAGE="${STATE_DIR}/attentionboard-tile.png"
FULL_IMAGE="${STATE_DIR}/attentionboard.png"
PID_FILE="${STATE_DIR}/attentionboard.pid"
LOG_FILE="${ATTENTIONBOARD_LOG:-/mnt/us/attentionboard.log}"
LOG_MAX_LINES=400

# Find FBInk binary
if [ -x "/mnt/us/libkh/bin/fbink" ]; then
    FBINK="/mnt/us/libkh/bin/fbink"
elif [ -x "/mnt/us/koreader/fbink" ]; then
    FBINK="/mnt/us/koreader/fbink"
else
    FBINK="fbink"
fi

log() {
    echo "[AttentionBoard $(date '+%H:%M:%S')] $*" >> "$LOG_FILE"
}

rotate_log() {
    if [ -f "$LOG_FILE" ]; then
        LINES=$(wc -l < "$LOG_FILE" 2>/dev/null | tr -d ' ')
        if [ -n "$LINES" ] && [ "$LINES" -gt "$LOG_MAX_LINES" ]; then
            tail -n 200 "$LOG_FILE" > "${LOG_FILE}.tmp" 2>/dev/null && mv "${LOG_FILE}.tmp" "$LOG_FILE"
        fi
    fi
}

# Optional tab switch. Do this before the single-instance check so an already
# running daemon can be re-pointed at another tab from SSH.
if [ "$1" = "1" ] || [ "$1" = "2" ] || [ "$1" = "3" ]; then
    curl -sf -m 10 -X POST "${BASE_URL}/api/tab?tab=$1" >/dev/null 2>&1 \
        || wget -q -T 10 -O - "${BASE_URL}/api/tab?tab=$1" >/dev/null 2>&1
elif [ "$1" = "next" ]; then
    curl -sf -m 10 -X POST "${BASE_URL}/api/tab/next" >/dev/null 2>&1 \
        || wget -q -T 10 -O - "${BASE_URL}/api/tab/next" >/dev/null 2>&1
fi

# Single instance
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        log "Already running (PID $OLD_PID); exiting."
        exit 0
    fi
fi
echo "$$" > "$PID_FILE"
trap 'rm -f "$PID_FILE"' 0 1 2 15

# Detect batch support once: `-b/--norefresh` lets us compose many bands into
# one refresh. Without it we always draw the full image instead.
BATCH=0
if "$FBINK" --help 2>&1 | grep -q 'norefresh'; then
    BATCH=1
fi

log "Started (PID $$) target ${BASE_URL} batch=${BATCH} interval=${INTERVAL_SECONDS}s"

# Wait briefly for KUAL menu to close before drawing to framebuffer
sleep 2

"$FBINK" -q -c -m "AttentionBoard: Connecting to Mac..." -y -2 >> "$LOG_FILE" 2>&1

fetch() {
    # fetch <url> <outfile>
    if command -v curl >/dev/null 2>&1; then
        curl -sf -m 20 "$1" -o "$2"
        return $?
    elif [ -x "/usr/bin/curl" ]; then
        /usr/bin/curl -sf -m 20 "$1" -o "$2"
        return $?
    elif command -v wget >/dev/null 2>&1; then
        wget -q -T 20 -O "$2" "$1"
        return $?
    elif [ -x "/usr/bin/wget" ]; then
        /usr/bin/wget -q -T 20 -O "$2" "$1"
        return $?
    fi
    return 127
}

draw_full_image() {
    if fetch "${BASE_URL}/dash.png" "$FULL_IMAGE" && [ -s "$FULL_IMAGE" ]; then
        "$FBINK" -q -c -g "file=${FULL_IMAGE},w=-1,h=-1,halign=CENTER,valign=CENTER" -W "$WAVEFORM" >> "$LOG_FILE" 2>&1
        return $?
    fi
    return 1
}

refresh_rects() {
    # Repaint only the rectangles that were actually composed.
    while read -r rx ry rw rh; do
        "$FBINK" -q -s "top=${ry},left=${rx},width=${rw},height=${rh}" -W "$WAVEFORM" >> "$LOG_FILE" 2>&1
    done < "$DIRTY_RECTS"
}

CYCLE=0
FAILS=0
FIRST_DRAW=1

while true; do
    CYCLE=$((CYCLE + 1))
    rotate_log

    # Kindle may silently drop this across sleep/wake; re-assert it cheaply.
    lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null

    # ---- 1. Manifest ------------------------------------------------------
    rm -f "$MANIFEST"
    if ! fetch "${BASE_URL}/dash/manifest" "$MANIFEST" \
        || [ ! -s "$MANIFEST" ] \
        || ! head -n 1 "$MANIFEST" 2>/dev/null | grep -q '^SIZE '; then
        FAILS=$((FAILS + 1))
        log "Manifest fetch failed (${FAILS} consecutive). Retrying in ${INTERVAL_SECONDS}s."
        # Keep the last good frame on screen; surface an error only after a
        # real outage, and only once per streak.
        if [ "$FAILS" -eq 3 ]; then
            "$FBINK" -q -m "AttentionBoard: waiting for Mac (${SERVER_IP})..." -y -2 >> "$LOG_FILE" 2>&1
        fi
        sleep "$INTERVAL_SECONDS"
        continue
    fi
    FAILS=0

    # ---- 2. Diff -----------------------------------------------------------
    rm -f "$NEW_CACHE"
    : > "$DIRTY_LIST"
    TOTAL=0
    CHANGED=0

    while read -r idx x y w h hash; do
        case "$idx" in
            ''|'#'*|SIZE|FRAME|COUNT) continue ;;
        esac
        [ -n "$hash" ] || continue
        TOTAL=$((TOTAL + 1))

        OLD_HASH=$(grep "^${idx} " "$CACHE" 2>/dev/null | cut -d' ' -f2)
        if [ "$OLD_HASH" = "$hash" ]; then
            echo "$idx $hash" >> "$NEW_CACHE"
        else
            echo "$idx $x $y $w $h $hash" >> "$DIRTY_LIST"
            CHANGED=$((CHANGED + 1))
        fi
    done < "$MANIFEST"

    if [ "$TOTAL" -eq 0 ]; then
        log "Manifest contained no tiles; skipping."
        sleep "$INTERVAL_SECONDS"
        continue
    fi

    # ---- 3. Draw -----------------------------------------------------------
    DID_FULL=0

    if [ "$CHANGED" -gt 0 ] && { [ "$BATCH" = "0" ] || [ "$FIRST_DRAW" = "1" ] || [ $((CHANGED * 2)) -ge "$TOTAL" ]; }; then
        # Everything (or most of it) changed: one full image is cheaper than
        # N downloads plus N fbink invocations.
        if draw_full_image; then
            while read -r idx x y w h hash; do
                echo "$idx $hash" >> "$NEW_CACHE"
            done < "$DIRTY_LIST"
            DID_FULL=1
            FIRST_DRAW=0
        else
            log "Full image draw failed."
        fi
    elif [ "$CHANGED" -gt 0 ]; then
        # Only a few bands changed: download them and compose in place.
        : > "$DIRTY_RECTS"
        DRAWN=0
        while read -r idx x y w h hash; do
            if fetch "${BASE_URL}/dash/tile?i=${idx}" "$TILE_IMAGE" && [ -s "$TILE_IMAGE" ]; then
                if "$FBINK" -q -b -g "file=${TILE_IMAGE},x=${x},y=${y}" >> "$LOG_FILE" 2>&1; then
                    echo "$x $y $w $h" >> "$DIRTY_RECTS"
                    echo "$idx $hash" >> "$NEW_CACHE"
                    DRAWN=$((DRAWN + 1))
                else
                    log "fbink failed writing tile ${idx}"
                fi
            else
                # Do not cache a band we could not fetch, so it retries.
                log "Tile ${idx} download failed."
            fi
        done < "$DIRTY_LIST"

        if [ "$BATCH" = "1" ] && [ "$DRAWN" -gt 0 ]; then
            refresh_rects
        fi
        [ "$FIRST_DRAW" = "1" ] && FIRST_DRAW=0
    fi

    if [ -s "$NEW_CACHE" ]; then
        mv "$NEW_CACHE" "$CACHE"
    fi

    # Periodic full flash: wipes accumulated ghosting without re-downloading.
    if [ "$DID_FULL" = "0" ] && [ $((CYCLE % FULL_FLASH_EVERY)) -eq 0 ]; then
        "$FBINK" -q -f -s >> "$LOG_FILE" 2>&1
    fi

    log "Cycle #${CYCLE}: ${CHANGED}/${TOTAL} bands updated."
    sleep "$INTERVAL_SECONDS"
done
