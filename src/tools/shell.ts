export function getPlatformShellCommand(
  command: string,
): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      file: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", command],
    };
  }

  const shellPath = process.env["SHELL"] || "/bin/sh";
  return {
    file: shellPath,
    args: ["-lc", command],
  };
}
