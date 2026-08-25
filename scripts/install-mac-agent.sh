#!/bin/bash
set -euo pipefail

API_BASE_URL=${1:-}
PAIRING_CODE=${2:-}
ASSET_BASE_URL="${API_BASE_URL%/}/downloads"
AGENT_SOURCE_URL="$ASSET_BASE_URL/mac-agent.mjs"
SOURCE_ARCHIVE_URL="$ASSET_BASE_URL/baidu-cloud-one-click-config.tar.gz"
INSTALL_DIR="$HOME/Library/Application Support/AutoUX"
AGENT_PATH="$INSTALL_DIR/mac-agent.mjs"
LOG_DIR="$HOME/Library/Logs/AutoUX"
PLIST_PATH="$HOME/Library/LaunchAgents/com.auto-ux.mac-agent.plist"
LABEL="com.auto-ux.mac-agent"

if [[ $(uname -s) != "Darwin" ]]; then
  echo "当前安装器只支持 macOS。" >&2
  exit 1
fi
if [[ ! $API_BASE_URL =~ ^https://[^[:space:]]+$ ]] \
  && [[ ! $API_BASE_URL =~ ^http://(118\.196\.147\.13|localhost|127\.0\.0\.1)(:[0-9]+)?(/[^[:space:]]*)?$ ]]; then
  echo "缺少有效的网站地址；HTTP 仅允许当前生产 IP 或本机地址。" >&2
  exit 1
fi
if [[ ! $PAIRING_CODE =~ ^[A-Fa-f0-9]{8}$ ]]; then
  echo "配对码必须是 8 位十六进制字符。" >&2
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

download_file() {
  local source_url=$1
  local destination=$2
  curl --fail --silent --show-error --location \
    --retry 4 --retry-delay 2 --connect-timeout 10 --max-time 120 \
    "$source_url" -o "$destination"
}

mkdir -p "$INSTALL_DIR" "$LOG_DIR" "$(dirname "$PLIST_PATH")"
TEMP_AGENT="$AGENT_PATH.download"
if ! download_file "$AGENT_SOURCE_URL" "$TEMP_AGENT"; then
  echo "Mac 助手下载失败，请检查生产站点连接后重试。" >&2
  exit 1
fi
chmod 700 "$TEMP_AGENT"
mv "$TEMP_AGENT" "$AGENT_PATH"

TEMP_SOURCE=$(mktemp -d "${TMPDIR:-/tmp}/auto-ux-skill.XXXXXX")
trap 'rm -rf "$TEMP_SOURCE"' EXIT
SOURCE_ARCHIVE="$TEMP_SOURCE/baidu-cloud-one-click-config.tar.gz"
if ! download_file "$SOURCE_ARCHIVE_URL" "$SOURCE_ARCHIVE"; then
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

"$NODE_PATH" "$AGENT_PATH" pair "$API_BASE_URL" "${PAIRING_CODE^^}"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

NODE_XML=$(xml_escape "$NODE_PATH")
AGENT_XML=$(xml_escape "$AGENT_PATH")
OUT_XML=$(xml_escape "$LOG_DIR/agent.log")
ERR_XML=$(xml_escape "$LOG_DIR/agent.error.log")

PLIST_CONTENT="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_XML</string><string>$AGENT_XML</string><string>run</string></array>
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
launchctl bootstrap "gui/$UID" "$PLIST_PATH"
launchctl kickstart -k "gui/$UID/$LABEL"

echo "Auto UX Mac 助手已安装并启动。"
echo "百度云一键配置 Skill 已安装到 Codex。"
echo "首次自动发送时，请在 系统设置 → 隐私与安全性 → 辅助功能 中允许 Node.js 控制键盘。"
