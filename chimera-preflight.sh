#!/usr/bin/env bash
# CHIMERA preflight — checks your machine is ready before you start building.
# Safe to run: it only reads, it never installs or changes anything.
# Usage:  bash chimera-preflight.sh

set -uo pipefail

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'

PASS=0; WARN=0; FAIL=0
FIXES=()

ok()   { echo "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
warn() { echo "  ${YELLOW}!${NC} $1"; WARN=$((WARN+1)); [ $# -gt 1 ] && FIXES+=("$2"); }
bad()  { echo "  ${RED}✗${NC} $1"; FAIL=$((FAIL+1)); [ $# -gt 1 ] && FIXES+=("$2"); }
head2(){ echo; echo "${BOLD}${BLUE}$1${NC}"; }

echo
echo "${BOLD}CHIMERA preflight check${NC}"
echo "Nothing here modifies your system."

# ── System ────────────────────────────────────────────────────────────
head2 "System"

if [ -r /etc/os-release ]; then
  . /etc/os-release
  ok "OS: ${PRETTY_NAME:-unknown}"
else
  warn "Could not read /etc/os-release"
fi

SESSION="${XDG_SESSION_TYPE:-unknown}"
case "$SESSION" in
  x11)     ok "Display server: X11 — good, native control will work here later" ;;
  wayland) warn "Display server: Wayland — Tier 2 input injection is blocked on Wayland. Fine for now; log into an X11 session when you reach M8" ;;
  *)       warn "Display server: unknown ($SESSION)" ;;
esac

ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
  ok "Architecture: $ARCH"
else
  warn "Architecture: $ARCH — some prebuilt native modules may need compiling from source"
fi

RAM_GB=$(awk '/MemTotal/ {printf "%.1f", $2/1048576}' /proc/meminfo 2>/dev/null)
if [ -n "${RAM_GB:-}" ]; then
  if awk "BEGIN{exit !($RAM_GB >= 7.5)}"; then
    ok "RAM: ${RAM_GB} GB"
  elif awk "BEGIN{exit !($RAM_GB >= 3.5)}"; then
    warn "RAM: ${RAM_GB} GB — workable, but Electron builds will be slow. 8 GB+ recommended"
  else
    bad "RAM: ${RAM_GB} GB — likely too little for comfortable Electron development"
  fi
fi

DISK_GB=$(df -BG --output=avail "$HOME" 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "${DISK_GB:-}" ]; then
  if [ "$DISK_GB" -ge 25 ]; then
    ok "Free disk in \$HOME: ${DISK_GB} GB"
  elif [ "$DISK_GB" -ge 10 ]; then
    warn "Free disk in \$HOME: ${DISK_GB} GB — node_modules and Electron builds are hungry. 25 GB+ is comfortable"
  else
    bad "Free disk in \$HOME: ${DISK_GB} GB — too tight to build Electron"
  fi
fi

# ── Core tooling ──────────────────────────────────────────────────────
head2 "Core tooling"

if command -v node >/dev/null 2>&1; then
  NODE_V=$(node --version | tr -d 'v')
  NODE_MAJOR=${NODE_V%%.*}
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    ok "Node.js: v$NODE_V"
  elif [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    warn "Node.js: v$NODE_V — works, but v20 LTS or newer is the safer target" \
         "nvm install --lts && nvm alias default lts/*"
  else
    bad "Node.js: v$NODE_V — too old" \
        "nvm install --lts && nvm alias default lts/*"
  fi

  if command -v nvm >/dev/null 2>&1 || [ -s "$HOME/.nvm/nvm.sh" ]; then
    ok "Node installed via nvm — easy to switch versions later"
  else
    NODE_PATH_LOC=$(command -v node)
    case "$NODE_PATH_LOC" in
      /usr/bin/*|/bin/*)
        warn "Node came from apt ($NODE_PATH_LOC) — apt versions go stale and global installs need sudo. nvm is the smoother path" \
             "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash   # then restart terminal, then: nvm install --lts" ;;
      *) ok "Node location: $NODE_PATH_LOC" ;;
    esac
  fi
else
  bad "Node.js: not installed" \
      "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash   # then restart terminal, then: nvm install --lts"
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm: v$(npm --version)"
else
  bad "npm: not installed (comes with Node)"
fi

if command -v git >/dev/null 2>&1; then
  ok "git: $(git --version | awk '{print $3}')"
  if git config --get user.email >/dev/null 2>&1 && git config --get user.name >/dev/null 2>&1; then
    ok "git identity: $(git config --get user.name) <$(git config --get user.email)>"
  else
    warn "git identity not set — commits will fail" \
         "git config --global user.name \"Hammad\" && git config --global user.email \"you@example.com\""
  fi
else
  bad "git: not installed" "sudo apt install -y git"
fi

if command -v claude >/dev/null 2>&1; then
  ok "Claude Code: $(claude --version 2>/dev/null | head -1)"
else
  bad "Claude Code: not installed" \
      "npm install -g @anthropic-ai/claude-code"
fi

# ── Native build dependencies ─────────────────────────────────────────
head2 "Native build dependencies"

for pair in "gcc:build-essential" "g++:build-essential" "make:build-essential" "python3:python3" "pkg-config:pkg-config"; do
  cmd=${pair%%:*}; pkg=${pair##*:}
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd present"
  else
    bad "$cmd missing" "sudo apt install -y $pkg"
  fi
done

if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists libsecret-1 2>/dev/null; then
  ok "libsecret-1 dev headers present (credential vault)"
else
  bad "libsecret-1 dev headers missing — the credential vault won't build" \
      "sudo apt install -y libsecret-1-dev"
fi

if command -v fakeroot >/dev/null 2>&1; then
  ok "fakeroot present (needed to package .deb installers)"
else
  warn "fakeroot missing — needed later to build Linux installers" "sudo apt install -y fakeroot"
fi

# ── Secret service ────────────────────────────────────────────────────
head2 "Secret service (where API keys get stored)"

if command -v gnome-keyring-daemon >/dev/null 2>&1; then
  ok "gnome-keyring installed"
else
  bad "gnome-keyring not installed" "sudo apt install -y gnome-keyring"
fi

SECRETS_UP=""
if command -v dbus-send >/dev/null 2>&1; then
  SECRETS_UP=$(dbus-send --session --dest=org.freedesktop.DBus --type=method_call \
    --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>/dev/null \
    | grep -c 'org.freedesktop.secrets')
fi

if [ "${SECRETS_UP:-0}" -gt 0 ] 2>/dev/null; then
  ok "Secret service is running on D-Bus"
else
  warn "Secret service not answering on D-Bus. On XFCE the keyring daemon often isn't started by default — if key storage fails silently at M0, this is why" \
       "Install 'seahorse', open Passwords and Keys, create a default 'Login' keyring, then log out and back in"
fi

# ── Optional but useful ───────────────────────────────────────────────
head2 "Optional"

command -v curl >/dev/null 2>&1 && ok "curl present" || warn "curl missing" "sudo apt install -y curl"
command -v gh   >/dev/null 2>&1 && ok "GitHub CLI present" || warn "GitHub CLI missing — handy for CI and releases, not required" "sudo apt install -y gh"
command -v docker >/dev/null 2>&1 && ok "Docker present (optional stronger sandbox)" || warn "Docker not installed — optional, CHIMERA uses a lighter jail by default"

if curl -sS --max-time 6 https://registry.npmjs.org/ -o /dev/null 2>/dev/null; then
  ok "Can reach the npm registry"
else
  warn "Could not reach the npm registry — check your connection or proxy"
fi

# ── Project files ─────────────────────────────────────────────────────
head2 "Project files"

if [ -f CLAUDE.md ]; then ok "CLAUDE.md found"; else bad "CLAUDE.md not found in this folder" "Run this script from inside your chimera/ folder"; fi
if [ -f docs/MASTER_PLAN.md ]; then ok "docs/MASTER_PLAN.md found"; else bad "docs/MASTER_PLAN.md missing" "Rename CHIMERA_MASTER_PLAN.md to docs/MASTER_PLAN.md — CLAUDE.md points at that path"; fi
if [ -f docs/WORKFLOW_SCHEMA.md ]; then ok "docs/WORKFLOW_SCHEMA.md found"; else bad "docs/WORKFLOW_SCHEMA.md missing" "Move it into docs/"; fi
if [ -d .git ]; then ok "git repository initialised"; else warn "not a git repo yet — you want version control from commit one" "git init"; fi

# ── Summary ───────────────────────────────────────────────────────────
echo
echo "${BOLD}────────────────────────────────────────${NC}"
echo "${GREEN}$PASS passed${NC}   ${YELLOW}$WARN warnings${NC}   ${RED}$FAIL blockers${NC}"

if [ ${#FIXES[@]} -gt 0 ]; then
  echo
  echo "${BOLD}Suggested fixes${NC}"
  printf '  %s\n' "${FIXES[@]}"
fi

echo
if [ "$FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then
  echo "${GREEN}${BOLD}Ready. Start Claude Code and paste your session 1 prompt.${NC}"
elif [ "$FAIL" -eq 0 ]; then
  echo "${YELLOW}${BOLD}No blockers. The warnings are worth clearing but won't stop you starting.${NC}"
else
  echo "${RED}${BOLD}Fix the blockers above, then run this again.${NC}"
fi
echo
