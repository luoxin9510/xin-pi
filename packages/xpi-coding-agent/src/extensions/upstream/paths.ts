// Path mapping between upstream pi and xin-pi: upstream `packages/<x>` is ours `packages/xpi-<y>`.

/** Upstream package directory -> our directory name. */
export const PACKAGE_MAP: Record<string, string> = {
	ai: "xpi-ai",
	agent: "xpi-agent-core",
	tui: "xpi-tui",
	"coding-agent": "xpi-coding-agent",
	codemode: "xpi-codemode",
	mcp: "xpi-mcp",
	schema: "xpi-schema",
	telemetry: "xpi-telemetry",
	evals: "xpi-evals",
};

/** Packages that xin-pi deleted (apps/* are removed too). */
export const REMOVED_PACKAGES = new Set(["chord", "durable", "env"]);

export interface Mapped {
	/** The path in xin-pi; unset when the file lives in something xin-pi removed. */
	path?: string;
	removed?: boolean;
}

export function mapUpstreamPath(path: string): Mapped {
	const m = /^packages\/([^/]+)\/(.*)$/.exec(path);
	if (m) {
		const [, pkg, rest] = m;
		if (REMOVED_PACKAGES.has(pkg)) return { removed: true };
		const ours = PACKAGE_MAP[pkg];
		if (ours) return { path: `packages/${ours}/${rest}` };
		return { path };
	}
	if (path.startsWith("apps/")) return { removed: true };
	return { path };
}

/** The label for an upstream path, annotated with where it lands in xin-pi. */
export function describeUpstreamPath(path: string): string {
	const m = mapUpstreamPath(path);
	if (m.removed) return `${path} (removed in xin-pi)`;
	if (m.path && m.path !== path) return `${path} -> ${m.path}`;
	return path;
}

/** Group key of one of OUR paths: its package, app, or top-level entry. */
export function groupOf(path: string): string {
	const m = /^(packages|apps)\/([^/]+)\//.exec(path);
	if (m) return `${m[1]}/${m[2]}`;
	return path.includes("/") ? `${path.split("/")[0]}/` : "(root files)";
}
