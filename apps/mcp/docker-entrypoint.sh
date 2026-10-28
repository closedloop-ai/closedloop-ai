#!/bin/sh
# Derive V8's old-space ceiling from the memory this container was actually
# granted, so the ECS task definition's `memory` stays the ONE place the number
# is configured (12-factor: config comes from the environment, not a second
# copy baked into the image or the source).
#
# Left alone, V8 self-sizes the old space to roughly half of what it detects —
# a 2048 MiB task aborted at ~1030 MB with half its allocation untouched, which
# is how ISS-8264 turned a session-retention bug into a hard crash instead of
# back-pressure.
#
# Reserve, rather than a flat percentage: non-heap RSS (tsx holding TypeScript
# sources and source maps, Prisma, native buffers) measured ~400 MB in prod and
# is roughly constant, so subtracting a fixed reserve tracks reality better than
# scaling it. Undershooting is safe; overshooting trades a clean V8 abort for a
# kernel OOM-kill, which is strictly worse.
set -eu

NON_HEAP_RESERVE_MIB=512
MIN_HEAP_MIB=256
# cgroup v1 reports ~8 EiB when unbounded; anything past this is "no limit".
MAX_PLAUSIBLE_LIMIT_MIB=262144

# Overridable only so the branches below can be exercised against a fixture
# tree; nothing sets it in production, where it stays the real cgroup mount.
CGROUP_ROOT="${CGROUP_ROOT:-/sys/fs/cgroup}"

read_cgroup_limit_bytes() {
  if [ -r "$CGROUP_ROOT/memory.max" ]; then
    cat "$CGROUP_ROOT/memory.max"
  elif [ -r "$CGROUP_ROOT/memory/memory.limit_in_bytes" ]; then
    cat "$CGROUP_ROOT/memory/memory.limit_in_bytes"
  fi
}

# An explicit NODE_OPTIONS always wins — this computes a default, it does not
# override an operator who set one deliberately.
if [ -z "${NODE_OPTIONS:-}" ]; then
  limit_bytes="$(read_cgroup_limit_bytes || true)"

  case "${limit_bytes:-}" in
    '' | *[!0-9]*)
      # Unset, "max", or unparseable — leave V8's own default in place.
      ;;
    *)
      limit_mib=$((limit_bytes / 1024 / 1024))
      heap_mib=$((limit_mib - NON_HEAP_RESERVE_MIB))
      if [ "$limit_mib" -le "$MAX_PLAUSIBLE_LIMIT_MIB" ] &&
        [ "$heap_mib" -ge "$MIN_HEAP_MIB" ]; then
        NODE_OPTIONS="--max-old-space-size=${heap_mib}"
        export NODE_OPTIONS
        echo "[entrypoint] container limit ${limit_mib} MiB -> ${NODE_OPTIONS}"
      fi
      ;;
  esac
fi

exec "$@"
