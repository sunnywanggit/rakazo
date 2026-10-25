import path from "node:path";

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export function localAgentLaunchAgent(options: {
  node: string;
  tsx: string;
  entry: string;
  config: string;
  directory: string;
}) {
  if (
    Object.values(options).some(
      (value) =>
        !path.isAbsolute(value) || [...value].some((character) => character.charCodeAt(0) < 32),
    )
  )
    throw new Error("Launch agent paths must be absolute");
  const args = [options.node, options.tsx, options.entry, "--config", options.config];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.rakazo.local-agent</string>
<key>ProgramArguments</key><array>${args.map((value) => `<string>${xml(value)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(options.directory)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(`${path.dirname(options.node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>20</integer>
<key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
}
