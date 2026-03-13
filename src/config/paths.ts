import { homedir } from "node:os";
import path from "node:path";

export function getConfigFilePath(fileName: string): string {
  return getConfigDirectoryPath(fileName);
}

export function getConfigDirectoryPath(...pathSegments: string[]): string {
  return path.join(getConfigRootPath(), ...pathSegments);
}

function getConfigRootPath(): string {
  const overrideDir = process.env.SUPERRUN_CONFIG_DIR?.trim();
  if (overrideDir) {
    return overrideDir;
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      return path.join(appData, "SuperRun");
    }
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, "superrun");
  }

  const home = homedir().trim();
  if (!home) {
    throw new Error("Unable to determine the home directory for config files.");
  }

  return path.join(home, ".config", "superrun");
}
