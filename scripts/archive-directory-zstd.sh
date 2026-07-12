#!/bin/sh
set -eu

usage() {
  echo "usage: archive-directory-zstd.sh <source-directory> <archive-directory>" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
source_dir=${1%/}
archive_dir=${2%/}
[ -d "$source_dir" ] || { echo "source directory missing: $source_dir" >&2; exit 1; }
[ ! -L "$source_dir" ] || { echo "refusing symlink source: $source_dir" >&2; exit 1; }

source_parent=$(dirname "$source_dir")
source_name=$(basename "$source_dir")
mkdir -p "$archive_dir"
archive_dir=$(cd "$archive_dir" && pwd -P)
source_parent=$(cd "$source_parent" && pwd -P)
source_dir="$source_parent/$source_name"

case "$archive_dir/" in
  "$source_dir/"*) echo "archive directory must be outside source" >&2; exit 1 ;;
esac

archive="$archive_dir/$source_name.tar.zst"
manifest="$archive.sha256"
[ ! -e "$archive" ] && [ ! -e "$manifest" ] \
  || { echo "archive already exists: $archive" >&2; exit 1; }

tmp="$archive.tmp-$$"
trap 'rm -f "$tmp" "$tmp.sha256"' EXIT HUP INT TERM

tar --zstd -cf "$tmp" -C "$source_parent" "$source_name"
zstd -q -t "$tmp"
tar --zstd -tf "$tmp" >/dev/null
sha256sum "$tmp" > "$tmp.sha256"

mv "$tmp" "$archive"
sed "s#  $tmp\$#  $(basename "$archive")#" "$tmp.sha256" > "$manifest"
rm -f "$tmp.sha256"
trap - EXIT HUP INT TERM

(cd "$archive_dir" && sha256sum -c "$(basename "$manifest")")
tar --zstd -tf "$archive" >/dev/null

original_bytes=$(du -sk "$source_dir" | awk '{print $1 * 1024}')
if archive_bytes=$(stat -c '%s' "$archive" 2>/dev/null); then
  :
else
  archive_bytes=$(stat -f '%z' "$archive")
fi
rm -rf "$source_dir"

echo "archived=$source_dir"
echo "archive=$archive"
echo "originalBytes=$original_bytes"
echo "archiveBytes=$archive_bytes"
echo "releasedBytes=$((original_bytes-archive_bytes))"
