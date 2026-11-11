import { type Static, type TSchemaOptions, Type } from "typebox";
import { ModelThinkingLevelSchema } from "./pi-ai-schemas.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";

function nonNegativeSafeInteger(options: { default?: number } = {}) {
	return Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, ...options });
}

function timeoutSetting(options?: TSchemaOptions) {
	return Type.Union([Type.Number({ minimum: 0 }), Type.Literal("disabled")], options);
}

const CompactionModelOverrideSchema = Type.Object({
	reserveTokens: Type.Optional(nonNegativeSafeInteger()),
	keepRecentTokens: Type.Optional(nonNegativeSafeInteger()),
});

const CompactionPruneSettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.compaction.prune.enabled })),
	protectTokens: Type.Optional(nonNegativeSafeInteger({ default: SETTINGS_DEFAULTS.compaction.prune.protectTokens })),
	minSavingsTokens: Type.Optional(
		nonNegativeSafeInteger({ default: SETTINGS_DEFAULTS.compaction.prune.minSavingsTokens }),
	),
});

const CompactionSettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.compaction.enabled })),
	reserveTokens: Type.Optional(nonNegativeSafeInteger({ default: SETTINGS_DEFAULTS.compaction.reserveTokens })),
	keepRecentTokens: Type.Optional(nonNegativeSafeInteger({ default: SETTINGS_DEFAULTS.compaction.keepRecentTokens })),
	prune: Type.Optional(CompactionPruneSettingsSchema),
	modelOverrides: Type.Optional(
		Type.Record(Type.String(), CompactionModelOverrideSchema, {
			description: 'Per-model overrides keyed by exact "provider/modelId" strings.',
		}),
	),
});

const BranchSummarySettingsSchema = Type.Object({
	reserveTokens: Type.Optional(
		Type.Number({
			description: "Tokens reserved for the prompt and LLM response.",
			default: SETTINGS_DEFAULTS.branchSummary.reserveTokens,
		}),
	),
	skipPrompt: Type.Optional(
		Type.Boolean({
			description: 'When true, skips the "Summarize branch?" prompt and defaults to no summary.',
			default: SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		}),
	),
});

const ProviderRetrySettingsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Number({ description: "SDK or provider request timeout in milliseconds." })),
	maxRetries: Type.Optional(Type.Number({ description: "SDK or provider retry attempts." })),
	maxRetryDelayMs: Type.Optional(
		Type.Number({
			description: "Maximum server-requested delay before failing.",
			default: SETTINGS_DEFAULTS.retry.provider.maxRetryDelayMs,
		}),
	),
});

const RetrySettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.retry.enabled })),
	maxRetries: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxRetries })),
	baseDelayMs: Type.Optional(
		Type.Number({
			description: "Exponential backoff base delay in milliseconds: 2s, 4s, 8s.",
			default: SETTINGS_DEFAULTS.retry.baseDelayMs,
		}),
	),
	maxAgentDelayMs: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxAgentDelayMs })),
	provider: Type.Optional(ProviderRetrySettingsSchema),
	maxDelayMs: Type.Optional(
		Type.Number({
			description: "Legacy retry delay setting. Use provider.maxRetryDelayMs instead.",
			deprecated: true,
		}),
	),
});

const TerminalSettingsSchema = Type.Object({
	showImages: Type.Optional(
		Type.Boolean({
			description: "Show images when the terminal supports them.",
			default: SETTINGS_DEFAULTS.terminal.showImages,
		}),
	),
	imageWidthCells: Type.Optional(
		Type.Number({
			description: "Preferred inline image width in terminal cells.",
			default: SETTINGS_DEFAULTS.terminal.imageWidthCells,
		}),
	),
	clearOnShrink: Type.Optional(
		Type.Boolean({
			description: "Clear empty rows when content shrinks.",
			default: SETTINGS_DEFAULTS.terminal.clearOnShrink,
		}),
	),
	showTerminalProgress: Type.Optional(
		Type.Boolean({
			description: "Show OSC 9;4 terminal progress indicators.",
			default: SETTINGS_DEFAULTS.terminal.showTerminalProgress,
		}),
	),
	hyperlinks: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
	images: Type.Optional(
		Type.Union([Type.Literal("kitty"), Type.Literal("iterm2"), Type.Literal("auto"), Type.Literal(false)]),
	),
	trueColor: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
});

const ImageSettingsSchema = Type.Object({
	autoResize: Type.Optional(
		Type.Boolean({
			description: "Resize images to 2000x2000 maximum for better model compatibility.",
			default: SETTINGS_DEFAULTS.images.autoResize,
		}),
	),
	blockImages: Type.Optional(
		Type.Boolean({
			description: "When true, prevents all images from being sent to LLM providers.",
			default: SETTINGS_DEFAULTS.images.blockImages,
		}),
	),
});

function thinkingBudgetsSettings(options?: TSchemaOptions) {
	return Type.Object(
		{
			minimal: Type.Optional(Type.Number()),
			low: Type.Optional(Type.Number()),
			medium: Type.Optional(Type.Number()),
			high: Type.Optional(Type.Number()),
		},
		options,
	);
}

const ThinkingBudgetsSettingsSchema = thinkingBudgetsSettings();

const MarkdownSettingsSchema = Type.Object({
	codeBlockIndent: Type.Optional(Type.String({ default: SETTINGS_DEFAULTS.markdown.codeBlockIndent })),
	mermaid: Type.Optional(
		Type.Union([Type.Literal("off"), Type.Literal("final"), Type.Literal("streaming")], {
			default: SETTINGS_DEFAULTS.markdown.mermaid,
		}),
	),
});

const WarningSettingsSchema = Type.Object({
	anthropicExtraUsage: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.warnings.anthropicExtraUsage })),
});

function codemodeMode(options?: TSchemaOptions) {
	return Type.Union([Type.Literal("on"), Type.Literal("only")], options);
}

const CodemodeModeSchema = codemodeMode();

const CodemodeSettingsSchema = Type.Object({
	mode: Type.Optional(
		codemodeMode({
			description:
				'How codemode presents tools. "on" keeps direct tools declared and annotates tools callable from scripts; codemode lists only tools without direct exposure. "only" lists every script-callable tool in codemode and does not declare active direct tools.',
			default: SETTINGS_DEFAULTS.codemode.mode,
		}),
	),
	inlineBudget: Type.Optional(
		Type.Number({
			minimum: 0,
			description: "Estimated tokens available for inline codemode tool declarations.",
			default: SETTINGS_DEFAULTS.codemode.inlineBudget,
		}),
	),
});

const PackageSourceSchema = Type.Union(
	[
		Type.String({ description: "Load all resources from the package." }),
		Type.Object({
			source: Type.String(),
			autoload: Type.Optional(
				Type.Boolean({ description: "When false, start empty and only apply explicit resource patterns." }),
			),
			extensions: Type.Optional(Type.Array(Type.String())),
			skills: Type.Optional(Type.Array(Type.String())),
			prompts: Type.Optional(Type.Array(Type.String())),
			themes: Type.Optional(Type.Array(Type.String())),
		}),
	],
	{
		description:
			"Package source for npm or git packages. Use the string form to load all resources or the object form to filter resources.",
	},
);

const StringArraySchema = Type.Array(Type.String());
const SkillsInputSchema = Type.Union(
	[
		StringArraySchema,
		Type.Object(
			{
				enableSkillCommands: Type.Optional(Type.Boolean()),
				customDirectories: Type.Optional(StringArraySchema),
			},
			{ deprecated: true },
		),
	],
	{ description: "Local skill file paths or directories." },
);

// The built-in subagent extension's block. The extension validates it itself (src/extensions/subagent/config.ts);
// this is for the published schema, so editors complete and check it. Defaults are stated in the descriptions because
// the extension applies them.
const SubagentSettingsSchema = Type.Object(
	{
		models: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description:
					'Model aliases for subagents, alias to "provider/model". Merged over the defaults for opus, sonnet, haiku and fable.',
			}),
		),
		defaultModel: Type.Optional(
			Type.String({
				description:
					'Model of an agent that names none: an alias or "provider/model"; "inherit" follows the session model. Default "haiku".',
			}),
		),
		toolMap: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Claude Code tool name to xpi tool name, merged over the built-in map.",
			}),
		),
		maxConcurrent: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"Running subagents per xpi process; more calls queue. The first session's value holds for the process. Default 20.",
			}),
		),
		maxAgentsPerScript: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Agents one script run may start; the next Agent call throws. Default 1000.",
			}),
		),
		childCodemode: Type.Optional(
			Type.Union([Type.Literal("only"), Type.Literal("inherit")], {
				description:
					'"only" (default): subagents see only the codemode tool and call their tools from scripts. "inherit": direct tools.',
			}),
		),
		backgroundScripts: Type.Optional(
			Type.Boolean({
				description:
					"A script that starts an Agent moves to the background. false: it waits for its agents. Default true.",
			}),
		),
		fork: Type.Optional(Type.Boolean({ description: 'The "fork" agent type and /subtask. Default true.' })),
		staggerStart: Type.Optional(
			Type.Boolean({
				description:
					"Siblings with the same prompt prefix wait (at most 5 s) for the first one's response to begin, then read its cached prompt. Default false.",
			}),
		),
		shutdownGraceMs: Type.Optional(
			Type.Number({
				minimum: 0,
				description: "How long a stopped subagent may take to shut down before it is killed. Default 10000.",
			}),
		),
		panelLingerMs: Type.Optional(
			Type.Number({
				minimum: 0,
				description: "How long a finished subagent stays in the panel. Default 30000.",
			}),
		),
		piCommand: Type.Optional(
			Type.String({
				description: "Command that starts a subagent. Unset: the build this process runs.",
			}),
		),
	},
	{ additionalProperties: true, description: "Settings of the built-in subagent extension." },
);

const RelayThinkingLevel = () =>
	Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)));

// The built-in relay extension's block (src/extensions/relay/config.ts validates it). Defaults are in the descriptions.
const RelaySettingsSchema = Type.Object(
	{
		lead: Type.Optional(
			Type.String({
				description:
					'The model that explores, plans and reviews, as "provider/model". Default "anthropic/claude-opus-5-5".',
			}),
		),
		worker: Type.Optional(
			Type.String({
				description: 'The model that builds, as "provider/model". Default "anthropic/claude-haiku-5-5".',
			}),
		),
		leadThinking: Type.Optional(
			Type.Object(
				{
					plan: Type.Optional(RelayThinkingLevel()),
					review: Type.Optional(RelayThinkingLevel()),
				},
				{
					description:
						'The lead\'s thinking level before the first handover ("plan", default "high") and after a hand back ("review", default "medium").',
				},
			),
		),
		workerThinking: Type.Optional(RelayThinkingLevel()),
		maxRounds: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"Times failed acceptance commands go back to the worker before the lead is woken regardless. Default 3.",
			}),
		),
		acceptanceTimeoutMs: Type.Optional(
			Type.Integer({ minimum: 1000, description: "Time limit of one acceptance command. Default 600000." }),
		),
		diffChars: Type.Optional(
			Type.Integer({
				minimum: 0,
				description: "How much of the diff goes into the hand-back record. Default 20000.",
			}),
		),
		objective: Type.Optional(
			Type.String({
				description:
					"What the user optimizes for, told to the lead, which decides with it whether to hand over. Default: a correct result for as few lead tokens as possible; worker tokens are not counted.",
			}),
		),
		workerRecord: Type.Optional(
			Type.String({
				description: "What is known about the worker's ability, told to the lead. Unset: nothing is said.",
			}),
		),
		minuteCost: Type.Optional(
			Type.Number({
				minimum: 0,
				description:
					"What one minute of the user's waiting is worth, in dollars of tokens, told to the lead next to the objective. Unset: time is not part of the objective.",
			}),
		),
	},
	{ additionalProperties: true, description: "Settings of the built-in relay extension (the relay/auto model)." },
);

const CommitSettingsSchema = Type.Object(
	{
		model: Type.Optional(
			Type.String({
				description:
					'Model that drafts the message of /commit: an alias from the `models` setting, "provider/model", or "inherit" for the session model.',
				default: SETTINGS_DEFAULTS.commit.model,
			}),
		),
	},
	{ additionalProperties: true, description: "Settings of the built-in commit extension (/commit)." },
);

// xpi roost's block (background sessions). xpi-roost validates it itself (its lib/config.ts: a bad value is skipped)
// and its daemon reads the user's section from <agent dir>/settings.json; this is for the published schema. Defaults are
// in the descriptions. A project's settings cannot set the four environment keys (inheritEnv, envAllowList,
// envDenyList, workspaceEnv): a cloned repository must not choose which of the user's environment reaches its sessions.
const RoostPresetSchema = Type.Object(
	{
		model: Type.Optional(Type.String({ description: 'Model of a new session, as "provider/model".' })),
		thinking: Type.Optional(Type.String({ description: "Thinking level of a new session." })),
		dir: Type.Optional(
			Type.String({ description: "Directory of a new session, relative to the hub's (never above it)." }),
		),
	},
	{ additionalProperties: true },
);

const RoostSettingsSchema = Type.Object(
	{
		leftArrowOpensAgents: Type.Optional(
			Type.Boolean({ description: "The left arrow on an empty editor opens the hub. Default true." }),
		),
		reapIdleMinutes: Type.Optional(
			Type.Number({
				exclusiveMinimum: 0,
				description:
					"A background session idle, unattached and unpinned this long is stopped (it can be started again). Default 60.",
			}),
		),
		cleanupDays: Type.Optional(
			Type.Number({
				minimum: 0,
				maximum: 3650,
				description: "Records of sessions that ended this many days ago are removed; 0 keeps them. Default 30.",
			}),
		),
		dispatchModel: Type.Optional(
			Type.String({ description: 'Model of a new background session, "provider/model".' }),
		),
		dispatchThinking: Type.Optional(Type.String({ description: "Thinking level of a new background session." })),
		inheritEnv: Type.Optional(
			Type.Boolean({
				description:
					"A session starts with the launching shell's environment (less envDenyList); false: envAllowList only. User settings only. Default true.",
			}),
		),
		envAllowList: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Variables carried even when inheritEnv is off or envDenyList names them. User settings only. Default [].",
			}),
		),
		envDenyList: Type.Optional(
			Type.Array(Type.String(), {
				description: 'Variables never carried; "PREFIX*" names a prefix. User settings only. Default [].',
			}),
		),
		workspaceEnv: Type.Optional(
			Type.Union([Type.Literal("shell"), Type.Literal("direnv"), Type.Literal("off")], {
				description:
					'The session directory\'s own environment on top: its shell\'s cd hooks ("shell"), direnv only, or "off". User settings only. Default "shell".',
			}),
		),
		groupBy: Type.Optional(
			Type.Union([Type.Literal("state"), Type.Literal("directory")], {
				description: 'How the hub groups sessions. Default "state".',
			}),
		),
		fullscreen: Type.Optional(
			Type.Boolean({
				description: "The hub covers the whole terminal (false: below the conversation). Default true.",
			}),
		),
		rowDetails: Type.Optional(
			Type.Boolean({ description: "Each row of the hub shows its model and context use. Default true." }),
		),
		notify: Type.Optional(
			Type.Union(
				[
					Type.Literal("auto"),
					Type.Literal("osc9"),
					Type.Literal("osc777"),
					Type.Literal("bell"),
					Type.Literal("off"),
				],
				{ description: 'How the hub makes the terminal notify. Default "auto".' },
			),
		),
		presets: Type.Optional(
			Type.Record(Type.String(), RoostPresetSchema, {
				description:
					"Saved choices for new sessions, by name (the user's and a project's merged, a project's winning).",
			}),
		),
	},
	{ additionalProperties: true, description: "Settings of xpi roost (background sessions and the hub)." },
);

export const SettingsSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON Schema reference." })),
		lastChangelogVersion: Type.Optional(Type.String()),
		extensionChangelogVersions: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Last seen changelog version per extension package.",
			}),
		),
		defaultProvider: Type.Optional(Type.String()),
		defaultModel: Type.Optional(Type.String()),
		defaultThinkingLevel: Type.Optional(ModelThinkingLevelSchema),
		modelThinkingLevels: Type.Optional(
			Type.Record(Type.String(), ModelThinkingLevelSchema, {
				description: 'Per-model default thinking level overrides keyed by "provider/modelId".',
			}),
		),
		transport: Type.Optional(
			Type.Union(
				[Type.Literal("auto"), Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("websocket-cached")],
				{ default: SETTINGS_DEFAULTS.transport },
			),
		),
		sessionShareDestination: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("gist"), Type.Literal("radius")], {
				description:
					'Destination used by /share. "auto" uses Radius when authenticated and otherwise creates a GitHub gist.',
				default: SETTINGS_DEFAULTS.sessionShareDestination,
			}),
		),
		steeringMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.steeringMode,
			}),
		),
		followUpMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.followUpMode,
			}),
		),
		theme: Type.Optional(Type.String()),
		compaction: Type.Optional(CompactionSettingsSchema),
		branchSummary: Type.Optional(BranchSummarySettingsSchema),
		retry: Type.Optional(RetrySettingsSchema),
		hideThinkingBlock: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.hideThinkingBlock })),
		staleEditGuard: Type.Optional(
			Type.Boolean({
				description:
					"Make edit and write fail on a file that was not read in this session or changed since it was read.",
				default: SETTINGS_DEFAULTS.staleEditGuard,
			}),
		),
		showCacheMissNotices: Type.Optional(
			Type.Boolean({
				description: "Show cache cost and provider recovery notices.",
				default: SETTINGS_DEFAULTS.showCacheMissNotices,
			}),
		),
		externalEditor: Type.Optional(
			Type.String({ description: "Command for Ctrl+G external editor; takes precedence over VISUAL and EDITOR." }),
		),
		shellPath: Type.Optional(
			Type.String({
				description: "Custom shell path, for example for Cygwin on Windows, with support for leading ~ expansion.",
			}),
		),
		quietStartup: Type.Optional(
			Type.Union([Type.Boolean(), Type.Literal("header")], {
				description: 'When true, hide all startup output. When "header", keep only the startup header.',
				default: SETTINGS_DEFAULTS.quietStartup,
			}),
		),
		defaultProjectTrust: Type.Optional(
			Type.Union([Type.Literal("ask"), Type.Literal("always"), Type.Literal("never")], {
				description: "Global setting only.",
				default: SETTINGS_DEFAULTS.defaultProjectTrust,
			}),
		),
		shellCommandPrefix: Type.Optional(
			Type.String({ description: "Prefix prepended to every bash command, for example to enable shell aliases." }),
		),
		npmCommand: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Command used for npm package lookup and installation, in argv form such as ["mise", "exec", "node@20", "--", "npm"].',
			}),
		),
		selfUpdateCommand: Type.Optional(
			Type.Array(Type.String(), {
				minItems: 1,
				description:
					'Command `pi update` runs to update Pi itself, in argv form such as ["mise", "use", "-g", "npm:{packageName}@{version}"]. Placeholders: {packageName}, {version}, {installSpec}. XPI_SELF_UPDATE_COMMAND takes precedence. Global setting only.',
			}),
		),
		collapseChangelog: Type.Optional(
			Type.Boolean({
				description: "Show the condensed changelog after update; use /changelog for the full changelog.",
				default: SETTINGS_DEFAULTS.collapseChangelog,
			}),
		),
		enableInstallTelemetry: Type.Optional(
			Type.Boolean({
				description: "Send an anonymous version and update ping after changelog-detected updates.",
				default: SETTINGS_DEFAULTS.enableInstallTelemetry,
			}),
		),
		enableAnalytics: Type.Optional(
			Type.Boolean({
				description: "Opt in to analytics data sharing.",
				default: SETTINGS_DEFAULTS.enableAnalytics,
			}),
		),
		trackingId: Type.Optional(
			Type.String({ description: "Analytics tracking identifier, generated when analytics is enabled." }),
		),
		packages: Type.Optional(
			Type.Array(PackageSourceSchema, {
				description: "npm or git package sources, as strings or objects with resource filtering.",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Type.String(), { description: "Local extension file paths or directories." }),
		),
		deviceId: Type.Optional(
			Type.String({
				description: "Stable installation UUID, generated when authentication first needs it. Global only.",
			}),
		),
		skills: Type.Optional(SkillsInputSchema),
		prompts: Type.Optional(
			Type.Array(Type.String(), { description: "Local prompt template file paths or directories." }),
		),
		themes: Type.Optional(Type.Array(Type.String(), { description: "Local theme file paths or directories." })),
		enableSkillCommands: Type.Optional(
			Type.Boolean({
				description: "Register skills as /skill:name commands.",
				default: SETTINGS_DEFAULTS.enableSkillCommands,
			}),
		),
		terminal: Type.Optional(TerminalSettingsSchema),
		images: Type.Optional(ImageSettingsSchema),
		enabledModels: Type.Optional(
			Type.Array(Type.String(), {
				description: "Model patterns for cycling, in the same format as the --models CLI flag.",
			}),
		),
		models: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description:
					'Model aliases shared by extensions (ctx.complete) and subagents, alias to a model reference such as "provider/id". subagent.models wins for subagents.',
			}),
		),
		defaultTools: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Initial tool selection. Plain names replace the inherited selection; +name and -name entries add or remove tools.",
			}),
		),
		doubleEscapeAction: Type.Optional(
			Type.Union([Type.Literal("fork"), Type.Literal("tree"), Type.Literal("none")], {
				description: "Action for double-escape with an empty editor.",
				default: SETTINGS_DEFAULTS.doubleEscapeAction,
			}),
		),
		treeFilterMode: Type.Optional(
			Type.Union(
				[
					Type.Literal("default"),
					Type.Literal("no-tools"),
					Type.Literal("user-only"),
					Type.Literal("labeled-only"),
					Type.Literal("all"),
				],
				{
					description: "Default filter when opening /tree.",
					default: SETTINGS_DEFAULTS.treeFilterMode,
				},
			),
		),
		thinkingBudgets: Type.Optional(
			thinkingBudgetsSettings({
				description: "Custom token budgets for thinking levels.",
			}),
		),
		editorPaddingX: Type.Optional(
			Type.Number({
				description: "Horizontal padding for the input editor.",
				default: SETTINGS_DEFAULTS.editorPaddingX,
			}),
		),
		outputPad: Type.Optional(
			Type.Union([Type.Literal(0), Type.Literal(1)], {
				description: "Horizontal padding for transcript content.",
				default: SETTINGS_DEFAULTS.outputPad,
			}),
		),
		autocompleteMaxVisible: Type.Optional(
			Type.Number({
				description: "Maximum visible items in the autocomplete dropdown.",
				default: SETTINGS_DEFAULTS.autocompleteMaxVisible,
			}),
		),
		showHardwareCursor: Type.Optional(
			Type.Boolean({ description: "Show the terminal cursor while still positioning it for IME." }),
		),
		markdown: Type.Optional(MarkdownSettingsSchema),
		warnings: Type.Optional(WarningSettingsSchema),
		codemode: Type.Optional(CodemodeSettingsSchema),
		sessionDir: Type.Optional(
			Type.String({
				description: "Custom session storage directory, in the same format as the --session-dir CLI flag.",
			}),
		),
		httpProxy: Type.Optional(
			Type.String({ description: "Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients." }),
		),
		httpIdleTimeoutMs: Type.Optional(
			timeoutSetting({
				description: 'HTTP header or body idle timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		cacheWarming: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("streaming"), Type.Literal("idle")], {
				description:
					'Cache-warming profile. "idle" also warms between agent runs. Global only because each refresh costs money.',
				default: SETTINGS_DEFAULTS.cacheWarming,
			}),
		),
		websocketConnectTimeoutMs: Type.Optional(
			timeoutSetting({
				description: 'WebSocket connect or open handshake timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		tuiMode: Type.Optional(
			Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")], {
				default: SETTINGS_DEFAULTS.tuiMode,
			}),
		),
		fullscreenExitOutput: Type.Optional(
			Type.Union([Type.Literal("transcript"), Type.Literal("resume-hint")], {
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenExitOutput,
			}),
		),
		fullscreenScrollbar: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("hidden")], {
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenScrollbar,
			}),
		),
		fullscreenCopyOnSelect: Type.Optional(
			Type.Boolean({
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenCopyOnSelect,
			}),
		),
		fullscreenWheelScrollLines: Type.Optional(
			Type.Union([Type.Number(), Type.Literal("auto")], {
				description: "Lines scrolled per wheel event in fullscreen mode; numeric values are clamped from 1 to 100.",
				default: SETTINGS_DEFAULTS.fullscreenWheelScrollLines,
			}),
		),
		queueMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				description: "Legacy setting migrated to steeringMode.",
				deprecated: true,
			}),
		),
		websockets: Type.Optional(
			Type.Boolean({ description: "Legacy setting migrated to transport.", deprecated: true }),
		),
		subagent: Type.Optional(SubagentSettingsSchema),
		relay: Type.Optional(RelaySettingsSchema),
		commit: Type.Optional(CommitSettingsSchema),
		roost: Type.Optional(RoostSettingsSchema),
	},
	{ additionalProperties: true },
);

type SettingsInput = Static<typeof SettingsSchema>;

export interface CompactionModelOverride extends Static<typeof CompactionModelOverrideSchema> {}
export interface CompactionSettings extends Static<typeof CompactionSettingsSchema> {}
export interface BranchSummarySettings extends Static<typeof BranchSummarySettingsSchema> {}
export interface ProviderRetrySettings extends Static<typeof ProviderRetrySettingsSchema> {}
export interface RetrySettings extends Omit<Static<typeof RetrySettingsSchema>, "maxDelayMs"> {}
export interface TerminalSettings extends Static<typeof TerminalSettingsSchema> {}
export interface ImageSettings extends Static<typeof ImageSettingsSchema> {}
export interface ThinkingBudgetsSettings extends Static<typeof ThinkingBudgetsSettingsSchema> {}
export type MermaidRenderingMode = NonNullable<Static<typeof MarkdownSettingsSchema>["mermaid"]>;
export interface MarkdownSettings extends Static<typeof MarkdownSettingsSchema> {}
export interface WarningSettings extends Static<typeof WarningSettingsSchema> {}
export type CodemodeMode = Static<typeof CodemodeModeSchema>;
export interface CodemodeSettings extends Static<typeof CodemodeSettingsSchema> {}
export type DefaultProjectTrust = NonNullable<SettingsInput["defaultProjectTrust"]>;
export type QuietStartup = NonNullable<SettingsInput["quietStartup"]>;
export type TransportSetting = NonNullable<SettingsInput["transport"]>;
export type SessionShareDestination = NonNullable<SettingsInput["sessionShareDestination"]>;
export type PackageSource = Static<typeof PackageSourceSchema>;
export type FullscreenExitOutput = NonNullable<SettingsInput["fullscreenExitOutput"]>;
export type TuiMode = NonNullable<SettingsInput["tuiMode"]>;
export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;
export interface Settings extends Omit<SettingsInput, "queueMode" | "retry" | "skills" | "websockets"> {
	retry?: RetrySettings;
	skills?: string[];
}
