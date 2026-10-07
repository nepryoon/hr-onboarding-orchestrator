#!/usr/bin/env bash
# Copies the demo into the portfolio site repository (same relative layout).
# Usage: scripts/sync-to-site.sh [path-to-site-repo]
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
SITE="${1:-$SRC/../neuromorphic-inference-lab-site}"

mkdir -p "$SITE/config/onboarding" "$SITE/functions/api/onboarding/systems" "$SITE/demos/onboarding-orchestrator" "$SITE/test"
cp "$SRC"/config/onboarding/*.js "$SITE/config/onboarding/"
cp "$SRC"/functions/api/onboarding/run.js "$SRC"/functions/api/onboarding/resume.js "$SITE/functions/api/onboarding/"
cp "$SRC/functions/api/onboarding/systems/[[path]].js" "$SITE/functions/api/onboarding/systems/"
cp "$SRC"/demos/onboarding-orchestrator/* "$SITE/demos/onboarding-orchestrator/"
cp "$SRC"/test/onboarding-*.js "$SITE/test/"
echo "Synced into $SITE"
