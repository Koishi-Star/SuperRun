import { homedir } from "node:os";
import path from "node:path";

export function getConfigFilePath(fileName: string): string {
  const overrideDir = process.env.SUPERRUN_CONFIG_DIR?.trim();
  if (overrideDir) {
    return path.join(overrideDir, fileName);
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      return path.join(appData, "SuperRun", fileName);
    }
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, "superrun", fileName);
  }

  const home = homedir().trim();
  if (!home) {
    throw new Error("Unable to determine the home directory for config files.");
  }

  return path.join(home, ".config", "superrun", fileName);
}
