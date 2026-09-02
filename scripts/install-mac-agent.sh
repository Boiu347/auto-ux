#!/bin/bash
set -euo pipefail

API_BASE_URL=${1:-}
ASSET_BASE_URL="${API_BASE_URL%/}/api/devices/assets"
AGENT_SOURCE_URL="$ASSET_BASE_URL/mac-agent.mjs"
SOURCE_ARCHIVE_URL="$ASSET_BASE_URL/baidu-cloud-one-click-config.tar.gz"
INSTALL_DIR="$HOME/Library/Application Support/AutoUX"
AGENT_PATH="$INSTALL_DIR/mac-agent.mjs"
LOG_DIR="$HOME/Library/Logs/AutoUX"
PLIST_PATH="$HOME/Library/LaunchAgents/com.auto-ux.mac-agent.plist"
LABEL="com.auto-ux.mac-agent"
CONFIG_PATH="${AUTO_UX_AGENT_CONFIG:-$HOME/.config/auto-ux/agent.json}"
MANAGED_CODEX_PATH="$HOME/.codex/packages/standalone/current/codex"
CODEX_INSTALLER_URL="https://chatgpt.com/codex/install.sh"

if [[ $(uname -s) != "Darwin" ]]; then
  echo "当前安装器只支持 macOS。" >&2
  exit 1
fi
if [[ ! $API_BASE_URL =~ ^https://[^[:space:]]+$ ]] \
  && [[ ! $API_BASE_URL =~ ^http://(118\.196\.147\.13|localhost|127\.0\.0\.1)(:[0-9]+)?(/[^[:space:]]*)?$ ]]; then
  echo "缺少有效的网站地址；HTTP 仅允许当前生产 IP 或本机地址。" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js 20 或更高版本，请先安装 Node.js。" >&2
  exit 1
fi
NODE_PATH=$(command -v node)
NODE_MAJOR=$($NODE_PATH -p 'Number(process.versions.node.split(".")[0])')
if (( NODE_MAJOR < 20 )); then
  echo "Node.js 版本过低，需要 20 或更高版本。" >&2
  exit 1
fi

if [[ ! -f $CONFIG_PATH ]]; then
  echo "未找到 Mac 助手配对配置；请使用网站生成的完整安装命令。" >&2
  exit 1
fi
if ! DEVICE_TOKEN=$("$NODE_PATH" -e '
  const fs = require("node:fs");
  const [path, expected] = process.argv.slice(1);
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  const normalize = (value) => String(value).replace(/\/+$/, "");
  const current = normalize(config.apiBaseUrl);
  const target = normalize(expected);
  const legacyUpgrade = current === "http://118.196.147.13/auto-ux"
    && target === "https://wowdata.guanghexinzhi.cn/auto-ux";
  if (!/^device_token:[a-f0-9]{64}$/.test(config.deviceToken)
      || (current !== target && !legacyUpgrade)) process.exit(1);
  process.stdout.write(config.deviceToken);
' "$CONFIG_PATH" "$API_BASE_URL"); then
  echo "现有配对不属于当前网站；请从网站重新生成配对码。" >&2
  exit 1
fi

download_public_file() {
  local source_url=$1
  local destination=$2
  curl --fail --silent --show-error --location \
    --retry 4 --retry-delay 2 --connect-timeout 10 --max-time 120 \
    "$source_url" -o "$destination"
}

download_asset() {
  local source_url=$1
  local destination=$2
  curl --fail --silent --show-error --location \
    --retry 4 --retry-delay 2 --connect-timeout 10 --max-time 120 \
    --header "Authorization: Bearer $DEVICE_TOKEN" \
    "$source_url" -o "$destination"
}

TEMP_SOURCE=$(mktemp -d "${TMPDIR:-/tmp}/auto-ux-install.XXXXXX")
trap 'rm -rf "$TEMP_SOURCE"' EXIT

if [[ ! -x $MANAGED_CODEX_PATH ]]; then
  CODEX_INSTALLER_PATH="$TEMP_SOURCE/codex-install.sh"
  if ! download_public_file "$CODEX_INSTALLER_URL" "$CODEX_INSTALLER_PATH"; then
    echo "Codex 本地任务组件下载失败，请检查网络后重试。" >&2
    exit 1
  fi
  CODEX_NON_INTERACTIVE=1 /bin/sh "$CODEX_INSTALLER_PATH"
fi
if [[ ! -x $MANAGED_CODEX_PATH ]] || ! "$MANAGED_CODEX_PATH" app-server --help >/dev/null 2>&1; then
  echo "当前 Codex 版本不支持结构化任务投递，请升级 Codex。" >&2
  exit 1
fi
if ! "$MANAGED_CODEX_PATH" app-server daemon bootstrap >/dev/null 2>&1; then
  echo "无法初始化 Codex 本地任务服务。" >&2
  exit 1
fi
if ! "$MANAGED_CODEX_PATH" app-server daemon start >/dev/null 2>&1; then
  echo "无法启动 Codex 本地任务服务。" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$LOG_DIR" "$(dirname "$PLIST_PATH")"
TEMP_AGENT="$AGENT_PATH.download"
if ! download_asset "$AGENT_SOURCE_URL" "$TEMP_AGENT"; then
  echo "Mac 助手下载失败，请检查生产站点连接后重试。" >&2
  exit 1
fi
chmod 700 "$TEMP_AGENT"
mv "$TEMP_AGENT" "$AGENT_PATH"

SOURCE_ARCHIVE="$TEMP_SOURCE/baidu-cloud-one-click-config.tar.gz"
if ! download_asset "$SOURCE_ARCHIVE_URL" "$SOURCE_ARCHIVE"; then
  echo "百度云一键配置 Skill 下载失败，请检查生产站点连接后重试。" >&2
  exit 1
fi
tar -xzf "$SOURCE_ARCHIVE" -C "$TEMP_SOURCE"
SKILL_SOURCE="$TEMP_SOURCE/baidu-cloud-one-click-config"
SKILL_DIR="$HOME/.codex/skills/baidu-cloud-one-click-config"
if [[ ! -f "$SKILL_SOURCE/SKILL.md" ]]; then
  echo "下载的 Skill 不完整。" >&2
  exit 1
fi
mkdir -p "$SKILL_DIR"
cp -R "$SKILL_SOURCE/." "$SKILL_DIR/"
chmod 700 "$SKILL_DIR/scripts/"*.py

"$NODE_PATH" -e '
  const fs = require("node:fs");
  const [path, apiBaseUrl] = process.argv.slice(1);
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  config.apiBaseUrl = String(apiBaseUrl).replace(/\/+$/, "");
  const temporary = `${path}.upgrade`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, path);
  fs.chmodSync(path, 0o600);
' "$CONFIG_PATH" "$API_BASE_URL"
echo "已复用现有 Mac 助手配对。"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

NODE_XML=$(xml_escape "$NODE_PATH")
AGENT_XML=$(xml_escape "$AGENT_PATH")
CODEX_XML=$(xml_escape "$MANAGED_CODEX_PATH")
OUT_XML=$(xml_escape "$LOG_DIR/agent.log")
ERR_XML=$(xml_escape "$LOG_DIR/agent.error.log")

PLIST_CONTENT="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_XML</string><string>$AGENT_XML</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>AUTO_UX_CODEX_PATH</key><string>$CODEX_XML</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$OUT_XML</string>
  <key>StandardErrorPath</key><string>$ERR_XML</string>
</dict>
</plist>"

printf '%s\n' "$PLIST_CONTENT" > "$PLIST_PATH"
chmod 600 "$PLIST_PATH"
launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
AGENT_LOADED=0
for _ in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$UID" "$PLIST_PATH" >/dev/null 2>&1; then
    AGENT_LOADED=1
    break
  fi
  sleep 1
done
if [[ $AGENT_LOADED != 1 ]]; then
  echo "无法加载 Auto UX Mac 助手，请检查 LaunchAgent 日志。" >&2
  exit 1
fi
launchctl kickstart -k "gui/$UID/$LABEL"

echo "Auto UX Mac 助手已安装并启动。"
echo "百度云一键配置 Skill 已安装到 Codex。"
echo "后续任务会直接发送到 Codex，不使用剪贴板，也不需要辅助功能权限。"
