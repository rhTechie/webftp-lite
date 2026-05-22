#!/usr/bin/env bash

set -euo pipefail

MIN_NODE_MAJOR=14
TARGET_NODE_MAJOR=20
AUTO_START=0
PKG_MANAGER=""

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"

log() {
  printf '[setup] %s\n' "$*"
}

warn() {
  printf '[setup] 警告: %s\n' "$*" >&2
}

fail() {
  printf '[setup] 错误: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法:
  bash scripts/setup-linux.sh
  bash scripts/setup-linux.sh --start

说明:
  1. 检查当前系统是否为 Linux
  2. 检查 Node.js / npm 是否可用
  3. 缺失时自动通过系统包管理器安装
  4. 安装当前项目依赖到 node_modules/
  5. 自动生成 .env 配置文件（如果不存在）
  6. 可选: 通过 --start 安装完成后直接启动服务
EOF
}

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  fail "安装系统依赖需要 root 或 sudo 权限，请使用 root 账号运行或先安装 sudo"
}

require_linux() {
  if [ "$(uname -s)" != "Linux" ]; then
    fail "该脚本仅支持 Linux 环境"
  fi
}

detect_package_manager() {
  if [ -n "${PKG_MANAGER}" ]; then
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    PKG_MANAGER="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PKG_MANAGER="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PKG_MANAGER="yum"
  elif command -v zypper >/dev/null 2>&1; then
    PKG_MANAGER="zypper"
  elif command -v pacman >/dev/null 2>&1; then
    PKG_MANAGER="pacman"
  elif command -v apk >/dev/null 2>&1; then
    PKG_MANAGER="apk"
  else
    fail "未识别的 Linux 包管理器，当前脚本支持 apt/dnf/yum/zypper/pacman/apk"
  fi

  log "检测到系统包管理器: ${PKG_MANAGER}"
}

get_node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi

  node -p "parseInt(process.versions.node.split('.')[0], 10)" 2>/dev/null || echo 0
}

install_prerequisites() {
  detect_package_manager

  case "${PKG_MANAGER}" in
    apt)
      run_privileged env DEBIAN_FRONTEND=noninteractive apt-get update
      run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
      ;;
    dnf)
      run_privileged dnf install -y ca-certificates curl
      ;;
    yum)
      run_privileged yum install -y ca-certificates curl
      ;;
    zypper)
      run_privileged zypper --non-interactive install ca-certificates curl
      ;;
    pacman)
      run_privileged pacman -Sy --noconfirm --needed ca-certificates curl
      ;;
    apk)
      run_privileged apk add --no-cache ca-certificates curl
      ;;
  esac
}

install_node_from_repo() {
  detect_package_manager

  case "${PKG_MANAGER}" in
    apt)
      run_privileged env DEBIAN_FRONTEND=noninteractive apt-get update
      run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm
      ;;
    dnf)
      run_privileged dnf install -y nodejs npm
      ;;
    yum)
      run_privileged yum install -y nodejs npm
      ;;
    zypper)
      run_privileged zypper --non-interactive install nodejs npm
      ;;
    pacman)
      run_privileged pacman -Sy --noconfirm --needed nodejs npm
      ;;
    apk)
      run_privileged apk add --no-cache nodejs npm
      ;;
  esac
}

install_npm_only() {
  detect_package_manager

  case "${PKG_MANAGER}" in
    apt)
      run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y npm
      ;;
    dnf)
      run_privileged dnf install -y npm
      ;;
    yum)
      run_privileged yum install -y npm
      ;;
    zypper)
      run_privileged zypper --non-interactive install npm
      ;;
    pacman)
      run_privileged pacman -Sy --noconfirm --needed npm
      ;;
    apk)
      run_privileged apk add --no-cache npm
      ;;
  esac
}

install_nodesource_node() {
  detect_package_manager

  case "${PKG_MANAGER}" in
    apt|dnf|yum)
      ;;
    *)
      fail "当前发行版仓库中的 Node.js 版本过低，且脚本暂不支持在 ${PKG_MANAGER} 上自动切换到 NodeSource"
      ;;
  esac

  install_prerequisites

  local setup_script
  setup_script="$(mktemp)"

  if [ "${PKG_MANAGER}" = "apt" ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${TARGET_NODE_MAJOR}.x" -o "${setup_script}"
    run_privileged bash "${setup_script}"
    run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${TARGET_NODE_MAJOR}.x" -o "${setup_script}"
    run_privileged bash "${setup_script}"
    if [ "${PKG_MANAGER}" = "dnf" ]; then
      run_privileged dnf install -y nodejs
    else
      run_privileged yum install -y nodejs
    fi
  fi

  rm -f "${setup_script}"
}

ensure_node_and_npm() {
  local node_major
  node_major="$(get_node_major)"

  if [ "${node_major}" -lt "${MIN_NODE_MAJOR}" ]; then
    log "未检测到可用的 Node.js >= ${MIN_NODE_MAJOR}，开始安装"
    install_node_from_repo || true
    node_major="$(get_node_major)"
  fi

  if [ "${node_major}" -lt "${MIN_NODE_MAJOR}" ]; then
    warn "系统仓库中的 Node.js 版本仍低于要求，尝试安装 NodeSource ${TARGET_NODE_MAJOR}.x"
    install_nodesource_node
    node_major="$(get_node_major)"
  fi

  if [ "${node_major}" -lt "${MIN_NODE_MAJOR}" ]; then
    fail "Node.js 安装后版本仍低于 ${MIN_NODE_MAJOR}，请手动检查软件源"
  fi

  log "Node.js 版本: $(node -v)"

  if ! command -v npm >/dev/null 2>&1; then
    log "未检测到 npm，开始安装"
    install_npm_only
  fi

  if ! command -v npm >/dev/null 2>&1; then
    fail "npm 安装失败，请手动检查系统软件源"
  fi

  log "npm 版本: $(npm -v)"
}

install_project_dependencies() {
  cd "${PROJECT_DIR}"

  if [ ! -f package.json ]; then
    fail "当前目录不是有效的项目目录，未找到 package.json"
  fi

  log "开始安装项目依赖到 node_modules/"
  npm install --no-fund --no-audit
  log "项目依赖安装完成"
}

ensure_env_file() {
  cd "${PROJECT_DIR}"

  if [ -f .env ]; then
    log "检测到 .env，保留现有配置"
    return
  fi

  if [ ! -f .env.example ]; then
    fail "未找到 .env.example，无法生成默认配置文件"
  fi

  cp .env.example .env
  log "已生成默认配置文件: ${PROJECT_DIR}/.env"
}

main() {
  case "${1:-}" in
    "")
      ;;
    --start)
      AUTO_START=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数: $1"
      ;;
  esac

  require_linux

  log "项目目录: ${PROJECT_DIR}"
  ensure_node_and_npm
  install_project_dependencies
  ensure_env_file

  log "环境检查完成"
  printf '\n'
  printf '下一步:\n'
  printf '  修改 .env 中的配置项（如端口、默认 FTP 账号）\n'
  printf '  启动服务: bash scripts/manage-linux.sh start\n'
  printf '\n'

  if [ "${AUTO_START}" -eq 1 ]; then
    log "开始启动服务"
    cd "${PROJECT_DIR}"
    bash scripts/manage-linux.sh start
  fi
}

main "${1:-}"
