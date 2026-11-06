#!/usr/bin/env bash
set -euo pipefail
# Version is deliberate; upgrades require review. Never execute a remote install script.
version=0.69.3
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
base="https://github.com/aquasecurity/trivy/releases/download/v$version"
archive="trivy_${version}_Linux-64bit.tar.gz"
curl --fail --silent --show-error --location "$base/$archive" -o "$work/$archive"
(cd "$work"; echo "1816b632dfe529869c740c0913e36bd1629cb7688bd5634f4a858c1d57c88b75  $archive" | sha256sum --check; tar -xzf "$archive" trivy)
mkdir -p "$HOME/.local/bin"
install "$work/trivy" "$HOME/.local/bin/trivy"
echo "$HOME/.local/bin" >> "$GITHUB_PATH"
