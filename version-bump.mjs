import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// Validate that targetVersion is defined and matches pure SemVer x.y.z
if (!targetVersion) {
	console.error("version-bump: npm_package_version is not set");
	process.exit(1);
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(targetVersion)) {
	console.error(
		`version-bump: npm_package_version "${targetVersion}" is not a valid SemVer (x.y.z)`,
	);
	process.exit(1);
}

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
}

// keep package-lock.json version in sync
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
packageLock.version = targetVersion;
if (packageLock.packages?.[""]) {
	packageLock.packages[""].version = targetVersion;
}
writeFileSync("package-lock.json", JSON.stringify(packageLock, null, 2));
