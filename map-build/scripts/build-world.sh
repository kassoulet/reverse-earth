#!/usr/bin/env bash
#
# Build a south-up world.pmtiles archive.
#
# Production (planet snapshot on a machine with enough RAM/disk):
#   npm run map:build -- --pbf /data/planet-260101.osm.pbf --heap 48g
#
# Small end-to-end smoke build (downloads a Monaco extract):
#   npm run map:build -- --area monaco --maxzoom 10
#
# Planetiler 0.10.2 + Java 25 are pinned. The input .osm.pbf is never deleted.
# The latitude inversion happens after tile generation, in flip_world.py, so
# every source (OSM, ocean polygons, Natural Earth) is mirrored consistently.
# The default native z10 archive is checked against the budget; if it is too
# large, the same MBTiles is re-flipped at z9 automatically.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$ROOT/map-build/.work"
CACHE="$ROOT/map-build/.cache"
CONFIG="$ROOT/map-build/configuration/planetiler.properties"
TRANSFORM="$ROOT/map-build/transformations/flip_world.py"
SIZE_CHECK="$ROOT/map-build/scripts/check-size.mjs"

PLANETILER_VERSION="0.10.2"
PLANETILER_URL="https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar"
PLANETILER_SHA256="f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d"

PBF=""
AREA=""
MAXZOOM="10"
MAXZOOM_EXPLICIT=0
HEAP=""
THREADS=""
OUTPUT="$ROOT/public/data/world.pmtiles"
KEEP_INTERMEDIATE=0

usage() {
  cat <<'EOF'
Usage:
  map-build/scripts/build-world.sh --pbf <planet.osm.pbf> [options]
  map-build/scripts/build-world.sh --area <geofabrik-name> [options]

Options:
  --pbf <path>          Input OSM PBF. Never modified or deleted.
  --area <name>         Let Planetiler download a Geofabrik extract (e.g. monaco).
  --maxzoom <0-14>      Native max zoom. Default 10, with an automatic z9
                        fallback if the archive exceeds the size budget.
  --output <path>       Output .pmtiles. Default public/data/world.pmtiles.
  --heap <size>         JVM -Xmx value, e.g. 48g. Use roughly 0.5x the PBF size.
  --threads <n>         Planetiler worker threads. Default: all cores.
  --keep-intermediate   Keep the Planetiler MBTiles and temp directory.
  -h, --help            Show this help.

Environment:
  PLANETILER_JAR        Use an existing jar instead of downloading the pinned one.
  PYTHON                Python interpreter with map-build/requirements.txt installed.
  PLANETILER_ARGS       Extra Planetiler flags (simple whitespace-separated flags).

Setup for the transform:
  python3 -m venv map-build/.venv
  map-build/.venv/bin/pip install -r map-build/requirements.txt
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pbf)
      [[ $# -ge 2 ]] || die "--pbf needs a path"
      PBF="$2"
      shift 2
      ;;
    --area)
      [[ $# -ge 2 ]] || die "--area needs a name"
      AREA="$2"
      shift 2
      ;;
    --maxzoom)
      [[ $# -ge 2 ]] || die "--maxzoom needs a number"
      MAXZOOM="$2"
      MAXZOOM_EXPLICIT=1
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || die "--output needs a path"
      OUTPUT="$2"
      shift 2
      ;;
    --heap)
      [[ $# -ge 2 ]] || die "--heap needs a value"
      HEAP="$2"
      shift 2
      ;;
    --threads)
      [[ $# -ge 2 ]] || die "--threads needs a number"
      THREADS="$2"
      shift 2
      ;;
    --keep-intermediate)
      KEEP_INTERMEDIATE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done

if [[ -n "$PBF" && -n "$AREA" ]]; then
  die "use either --pbf or --area, not both"
fi
if [[ -z "$PBF" && -z "$AREA" ]]; then
  usage
  die "provide --pbf <planet.osm.pbf> (production) or --area <name> (smoke test)"
fi
if ! [[ "$MAXZOOM" =~ ^[0-9]+$ ]] || (( MAXZOOM < 0 || MAXZOOM > 14 )); then
  die "--maxzoom must be an integer between 0 and 14"
fi

if [[ -n "$PBF" ]]; then
  [[ -f "$PBF" ]] || die "input PBF not found: $PBF"
  PBF="$(cd "$(dirname "$PBF")" && pwd)/$(basename "$PBF")"
  # The published world archive contract requires native z0-z9. A lower
  # --maxzoom is useful for smoke extracts, not for a deployable world build.
  if (( MAXZOOM < 9 )); then
    die "native zooms 0-9 are mandatory for a production world build; use --maxzoom 9 or 10"
  fi
fi

if ! command -v java >/dev/null 2>&1; then
  die "Java 25+ is required (Planetiler 0.10.x). Install a JDK and retry."
fi
JAVA_MAJOR="$(java -version 2>&1 | sed -n 's/.*version "\([0-9][0-9]*\).*/\1/p' | head -n1)"
if [[ -z "$JAVA_MAJOR" ]] || (( JAVA_MAJOR < 25 )); then
  die "Java 25+ is required; found: $(java -version 2>&1 | head -n1)"
fi
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is required for the deployment size check"
fi

mkdir -p "$WORK/tmp" "$CACHE" "$(dirname "$OUTPUT")"
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"

# Keep the input PBF untouched, but warn about the disk Planetiler will need.
if [[ -n "$PBF" ]]; then
  PBF_BYTES="$(stat -c%s "$PBF" 2>/dev/null || stat -f%z "$PBF")"
  FREE_KB="$(df -Pk "$WORK" | awk 'NR==2 {print $4}')"
  FREE_BYTES=$(( FREE_KB * 1024 ))
  NEED_BYTES=$(( PBF_BYTES * 5 ))
  if (( FREE_BYTES < NEED_BYTES )); then
    echo "warning: Planetiler usually needs 5-10x the PBF size in free disk space." >&2
    echo "         input=${PBF_BYTES} bytes, free=${FREE_BYTES} bytes at $WORK" >&2
  fi
fi

# Pin and verify Planetiler unless a custom jar was supplied.
PLANETILER_JAR="${PLANETILER_JAR:-$CACHE/planetiler-${PLANETILER_VERSION}.jar}"
if [[ ! -f "$PLANETILER_JAR" ]]; then
  echo "Downloading Planetiler ${PLANETILER_VERSION}…"
  curl -fL --retry 3 --retry-delay 2 -o "$PLANETILER_JAR.part" "$PLANETILER_URL"
  mv "$PLANETILER_JAR.part" "$PLANETILER_JAR"
fi
if [[ "$PLANETILER_JAR" == "$CACHE/planetiler-${PLANETILER_VERSION}.jar" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    echo "${PLANETILER_SHA256}  ${PLANETILER_JAR}" | sha256sum -c - >/dev/null
  else
    echo "${PLANETILER_SHA256}  ${PLANETILER_JAR}" | shasum -a 256 -c - >/dev/null
  fi
fi

PYTHON_BIN="${PYTHON:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  if [[ -x "$ROOT/map-build/.venv/bin/python" ]]; then
    PYTHON_BIN="$ROOT/map-build/.venv/bin/python"
  else
    PYTHON_BIN="python3"
  fi
fi
if ! "$PYTHON_BIN" -c "import pmtiles, mapbox_vector_tile, shapely" >/dev/null 2>&1; then
  cat >&2 <<EOF
error: the Python transform dependencies are missing for $PYTHON_BIN.

  python3 -m venv map-build/.venv
  map-build/.venv/bin/pip install -r map-build/requirements.txt

Then run this command again.
EOF
  exit 1
fi

MBTILES="$WORK/world.mbtiles"
TMP_OUTPUT="$OUTPUT.tmp"
rm -f "$MBTILES" "$TMP_OUTPUT"

echo
echo "Planetiler ${PLANETILER_VERSION}"
echo "  input:     ${PBF:-Geofabrik area '$AREA'}"
echo "  zooms:     0-${MAXZOOM}"
echo "  mbtiles:   $MBTILES"
echo "  output:    $OUTPUT"
echo "  work dir:  $WORK"
echo

JAVA_CMD=(java)
if [[ -n "$HEAP" ]]; then
  JAVA_CMD+=("-Xmx$HEAP")
fi
JAVA_CMD+=(
  -jar "$PLANETILER_JAR"
  --config="$CONFIG"
  --minzoom=0
  --maxzoom="$MAXZOOM"
  --output="$MBTILES"
  --force
  --download
  --tmpdir="$WORK/tmp"
)
if [[ -n "$PBF" ]]; then
  JAVA_CMD+=(--osm-path="$PBF")
else
  JAVA_CMD+=(--area="$AREA")
fi
if [[ -n "$THREADS" ]]; then
  JAVA_CMD+=(--threads="$THREADS")
fi
if [[ -n "${PLANETILER_ARGS:-}" ]]; then
  # Deliberately split: these are simple Planetiler flags, e.g.
  # PLANETILER_ARGS="--water-polygons-url=... --natural-earth-url=..."
  # shellcheck disable=SC2206
  JAVA_CMD+=(${PLANETILER_ARGS})
fi

# Run from the ignored work directory so Planetiler's default data/sources
# downloads never land in the repository root.
(
  cd "$WORK"
  "${JAVA_CMD[@]}"
)

flip_archive() {
  local maxzoom="$1"
  echo
  echo "Inverting latitude in every MVT tile (native z0-${maxzoom})…"
  PYTHONHASHSEED=0 "$PYTHON_BIN" "$TRANSFORM" \
    --input "$MBTILES" \
    --output "$TMP_OUTPUT" \
    --maxzoom "$maxzoom" \
    --force
}

flip_archive "$MAXZOOM"

echo
# A default build first tries z10. If the finished archive is over budget, the
# MBTiles intermediate still has z0-z9, so retry the flip at z9 rather than
# making the user throw away the Planetiler run. An explicit --maxzoom is
# respected and fails the gate instead of silently changing the request.
if ! node "$SIZE_CHECK" --archive "$TMP_OUTPUT"; then
  if [[ "$MAXZOOM_EXPLICIT" -eq 0 && "$MAXZOOM" -gt 9 ]]; then
    echo
    echo "Native z${MAXZOOM} is over the storage budget; retrying at z9."
    MAXZOOM=9
    flip_archive 9
    node "$SIZE_CHECK" --archive "$TMP_OUTPUT"
  else
    exit 1
  fi
fi

mv "$TMP_OUTPUT" "$OUTPUT"

OUTPUT_BYTES="$(stat -c%s "$OUTPUT" 2>/dev/null || stat -f%z "$OUTPUT")"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUTPUT" > "$WORK/world.pmtiles.sha256" 2>/dev/null || true
else
  shasum -a 256 "$OUTPUT" > "$WORK/world.pmtiles.sha256" 2>/dev/null || true
fi
echo
printf 'Final archive: %s bytes (%.1f MB)\n' "$OUTPUT_BYTES" "$(awk -v b="$OUTPUT_BYTES" 'BEGIN {print b/1000000}')"
if [[ -s "$WORK/world.pmtiles.sha256" ]]; then
  cat "$WORK/world.pmtiles.sha256"
fi

if [[ "$KEEP_INTERMEDIATE" -eq 0 ]]; then
  rm -f "$MBTILES"
  rm -rf "$WORK/tmp"
  echo "Removed intermediate MBTiles and temp files (use --keep-intermediate to keep them)."
fi

echo
echo "Next: npm run build && npm run size:check"
