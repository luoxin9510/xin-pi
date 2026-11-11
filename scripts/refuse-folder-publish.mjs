#!/usr/bin/env node
// prepublishOnly of packages/xpi-coding-agent: the workspace folder is not what npm users get. Its library entry needs
// the xpi-* workspace packages, which are not published. Publish the self-contained tarball instead.
console.error(
	"Do not publish packages/xpi-coding-agent directly. From the repository root run:\n" +
		"  npm run xpi:pack\n" +
		"  npm publish ./dist-pack/xpi-coding-agent-<version>.tgz --access public",
);
process.exit(1);
