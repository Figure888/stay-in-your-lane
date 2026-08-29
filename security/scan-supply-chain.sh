#!/data/data/com.termux/files/usr/bin/bash
# Supply-chain scan for the Shai-Hulud / Mini Shai-Hulud worm family.
#
#   bash security/scan-supply-chain.sh
#
# Checks your lockfile against the package families hit in 2026, looks for
# install hooks that could execute on npm install, and flags credential files
# a stealer would target. Read-only — changes nothing.

cd "$(dirname "$0")/.." || exit 1
echo "=== supply-chain scan: $(date) ==="
echo

# Package families compromised in the 2026 waves. These are common transitive
# dependencies — you can have them without ever asking for them.
FAMILIES="keyv cacheable flat-cache file-entry-cache cache-manager node-gyp axios mastra easy-day-js @antv @tanstack"

echo "--- 1. compromised package families in your tree ---"
FOUND=0
for p in $FAMILIES; do
  if [ -f package-lock.json ] && grep -q "\"node_modules/$p\"" package-lock.json 2>/dev/null; then
    VER=$(node -e "
      const l=require('./package-lock.json');
      const k=Object.keys(l.packages||{}).filter(x=>x==='node_modules/$p');
      console.log(k.map(x=>l.packages[x].version).join(', ')||'?');
    " 2>/dev/null)
    echo "  PRESENT: $p@$VER  <-- verify this version"
    FOUND=1
  fi
done
[ $FOUND -eq 0 ] && echo "  none of the known-affected families are in your lockfile"
echo

echo "--- 2. packages with install hooks (the execution vector) ---"
if [ -d node_modules ]; then
  find node_modules -maxdepth 3 -name package.json -not -path "*/node_modules/*/node_modules/*" 2>/dev/null \
    | while read -r f; do
        node -e "
          try {
            const p = require('$PWD/$f');
            const s = p.scripts || {};
            const hooks = ['preinstall','install','postinstall'].filter(h => s[h]);
            if (hooks.length) console.log('  ' + p.name + '@' + p.version + ' -> ' + hooks.join(','));
          } catch (e) {}
        " 2>/dev/null
      done | sort -u
else
  echo "  node_modules not present"
fi
echo

echo "--- 3. credential files a stealer would target ---"
for f in ~/.npmrc ~/.lanepoker-env .env .env.local .vercel/project.json ~/.config/gh/hosts.yml ~/.aws/credentials; do
  [ -e "$f" ] && echo "  EXISTS: $f"
done
echo

echo "--- 4. anything in .gitignore that shouldn't be committed ---"
git status --porcelain --ignored 2>/dev/null | grep '^!!' | grep -E '\.env|\.npmrc|credentials' | head
echo

echo "--- 5. npm audit ---"
npm audit --omit=dev 2>&1 | tail -15
echo
echo "=== done ==="
