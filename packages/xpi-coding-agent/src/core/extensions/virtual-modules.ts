import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
import * as bundledPiAgentCore from "xpi-agent-core";
import * as bundledPiAiModels from "xpi-ai/models";
import * as bundledPiAiOauth from "xpi-ai/oauth";
import * as bundledPiAiProviders from "xpi-ai/providers/all";
import * as bundledPiTui from "xpi-tui";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from xpi-coding-agent.
import * as bundledPiCodingAgent from "../../index.ts";
import * as bundledPiAiExtensionView from "./pi-ai-extension-view.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"xpi-agent-core": bundledPiAgentCore,
	"xpi-tui": bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint) plus TypeBox's Type, Static and TSchema:
	// existing extensions using the old global API and pi-ai's former TypeBox
	// re-exports keep working.
	"xpi-ai": bundledPiAiExtensionView,
	"xpi-ai/compat": bundledPiAiExtensionView,
	"xpi-ai/models": bundledPiAiModels,
	"xpi-ai/oauth": bundledPiAiOauth,
	"xpi-ai/providers/all": bundledPiAiProviders,
	"xpi-coding-agent": bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	"@mariozechner/pi-tui": bundledPiTui,
	"@mariozechner/pi-ai": bundledPiAiExtensionView,
	"@mariozechner/pi-ai/compat": bundledPiAiExtensionView,
	"@mariozechner/pi-ai/models": bundledPiAiModels,
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};
