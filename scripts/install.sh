#!/usr/bin/env sh
# Oh My Agy (oma) one-line installer for Linux and macOS.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/liansishen/oh-my-agy/main/scripts/install.sh | sh
#
# Optional environment variables:
#   OMA_REPO          GitHub repo (default: liansishen/oh-my-agy)
#   OMA_VERSION       Release tag to install (default: latest)
#   OMA_INSTALL_DIR   Destination bin directory (default: $HOME/.local/bin)
#   OMA_SKIP_PLUGIN   Set to 1 to skip installing the Tern oma-reopen plugin

set -eu

REPO="${OMA_REPO:-liansishen/oh-my-agy}"
VERSION="${OMA_VERSION:-latest}"
INSTALL_DIR="${OMA_INSTALL_DIR:-$HOME/.local/bin}"
SKIP_PLUGIN="${OMA_SKIP_PLUGIN:-0}"

say() {
  printf '%s\n' "$*"
}

err() {
  printf 'oma install error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "required command not found: $1"
}

detect_os() {
  case "$(uname -s)" in
    Linux*)  printf 'linux' ;;
    Darwin*) printf 'darwin' ;;
    *)       err "unsupported OS: $(uname -s). On Windows use scripts/install.ps1" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)   printf 'x64' ;;
    aarch64|arm64)  printf 'arm64' ;;
    *)              err "unsupported CPU architecture: $(uname -m)" ;;
  esac
}

resolve_latest_tag() {
  api_url="https://api.github.com/repos/$REPO/releases/latest"
  tag=""
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    tag="$(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$api_url" 2>/dev/null \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)"
  else
    tag="$(curl -fsSL "$api_url" 2>/dev/null \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)"
  fi

  if [ -z "$tag" ]; then
    # Fallback via redirect URL if GitHub REST API is rate-limited
    final_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
    tag="$(printf '%s' "$final_url" | sed -n 's|.*/releases/tag/\([^/?#]*\).*|\1|p')"
  fi

  [ -n "$tag" ] || err "failed to resolve latest release tag for https://github.com/$REPO"
  printf '%s' "$tag"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print tolower($NF)}'
  else
    printf ''
  fi
}

main() {
  need_cmd curl
  need_cmd uname

  os="$(detect_os)"
  arch="$(detect_arch)"
  asset="oma-${os}-${arch}"

  if [ "$VERSION" = "latest" ]; then
    tag="$(resolve_latest_tag)"
  else
    case "$VERSION" in
      v*|V*) tag="v${VERSION#?}" ;;
      *)     tag="v$VERSION" ;;
    esac
  fi

  base_url="https://github.com/$REPO/releases/download/$tag"
  tmp_dir="$(mktemp -d 2>/dev/null || mktemp -d -t oma-install)"
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM

  say "Installing oma $tag ($asset) from https://github.com/$REPO ..."
  bin_tmp="$tmp_dir/$asset"
  curl -fL --progress-bar "$base_url/$asset" -o "$bin_tmp" || err "failed to download $base_url/$asset"

  sums_tmp="$tmp_dir/SHA256SUMS.txt"
  curl -fsSL "$base_url/SHA256SUMS.txt" -o "$sums_tmp" || err "failed to download required $base_url/SHA256SUMS.txt"
  # Portable across GNU awk, BSD awk, and older mawk (no `{64}` interval regex, exact full filename match)
  expected="$(awk -v f="$asset" '
    {
      line = $0
      sub(/\r$/, "", line)
      sub(/^[ \t]+/, "", line)
      if (line == "" || substr(line, 1, 1) == "#") next
      hash = line
      sub(/[ \t].*$/, "", hash)
      hash = tolower(hash)
      if (length(hash) != 64 || hash !~ /^[0-9a-f]+$/) next
      name = substr(line, 65)
      if (name !~ /^[ \t]+/) next
      sub(/^[ \t]+/, "", name)
      sub(/^\*/, "", name)
      sub(/^\.\//, "", name)
      if (name == f) {
        print hash
        exit
      }
    }
  ' "$sums_tmp")"
  [ -n "$expected" ] || err "SHA256SUMS.txt does not contain a valid checksum entry for $asset"
  actual="$(sha256_file "$bin_tmp")"
  [ -n "$actual" ] || err "no SHA256 utility found (need sha256sum, shasum, or openssl)"
  if [ "$actual" != "$expected" ]; then
    err "SHA256 mismatch for $asset (expected $expected, got $actual)"
  fi
  say "Verified SHA256 ($actual)"

  mkdir -p "$INSTALL_DIR"
  chmod +x "$bin_tmp"
  dest="$INSTALL_DIR/oma"
  staging="$INSTALL_DIR/.oma.install.$$"
  cp "$bin_tmp" "$staging"
  chmod +x "$staging"
  mv -f "$staging" "$dest"

  # Mirror omp layout on root-managed servers: symlink /usr/local/bin/oma when writable
  if [ "$(id -u)" -eq 0 ] && [ -d /usr/local/bin ] && [ "$INSTALL_DIR" != "/usr/local/bin" ]; then
    ln -sf "$dest" /usr/local/bin/oma
    say "Linked /usr/local/bin/oma -> $dest"
  fi

  # Optional: install Tern oma-reopen plugin when tern CLI is available
  if [ "$SKIP_PLUGIN" != "1" ] && command -v tern >/dev/null 2>&1; then
    plugin_dir="$tmp_dir/oma-reopen"
    mkdir -p "$plugin_dir"
    raw_base="https://raw.githubusercontent.com/$REPO/$tag/plugins/oma-reopen"
    if curl -fsSL "$raw_base/plugin.toml" -o "$plugin_dir/plugin.toml" 2>/dev/null \
       && curl -fsSL "$raw_base/host.luau" -o "$plugin_dir/host.luau" 2>/dev/null; then
      if tern plugin install "$plugin_dir" >/dev/null 2>&1; then
        say "Installed Tern plugin: oma-reopen"
      fi
    fi
  fi

  say ""
  say "Installed oma to $dest"
  "$dest" --version || true

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      if [ ! -e /usr/local/bin/oma ]; then
        say ""
        say "Add $INSTALL_DIR to your PATH:"
        say "  export PATH=\"$INSTALL_DIR:\$PATH\""
      fi
      ;;
  esac
}

main "$@"
