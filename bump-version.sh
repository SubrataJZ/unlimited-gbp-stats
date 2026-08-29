#!/bin/bash

VERSION=$1

if [ -z "$VERSION" ]; then
  echo "Usage: ./bump-version.sh 1.25.0"
  exit 1
fi

# Update manifest.json version
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" unlimited-gbp-stats/manifest.json

# Update updates.xml version and codebase URL
sed -i "s/version='[^']*'/version='$VERSION'/" updates.xml
sed -i "s|download/v[^/]*/|download/v${VERSION}/|" updates.xml

echo "✓ Version bumped to $VERSION"
echo ""
echo "Next steps:"
echo "1. git add unlimited-gbp-stats/manifest.json updates.xml"
echo "2. git commit -m 'Release v$VERSION'"
echo "3. git push origin claude/festive-noether-44z9oi"
echo "4. Create GitHub Release with tag v$VERSION"
echo "5. Upload extension.zip to the release"
echo ""
echo "Users will auto-update in background within 24 hours!"
