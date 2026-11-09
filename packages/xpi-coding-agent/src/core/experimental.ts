export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.XPI_EXPERIMENTAL === "1";
}
