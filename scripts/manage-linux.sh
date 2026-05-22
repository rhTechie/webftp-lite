#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
LOG_DIR="${PROJECT_DIR}/runtime"
PID_FILE="${LOG_DIR}/webftp.pid"
LOG_FILE="${LOG_DIR}/webftp.log"
ENV_FILE="${PROJECT_DIR}/.env"

log() {
  printf '[manage] %s\n' "$*"
}

fail() {
  printf '[manage] 错误: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法:
  bash scripts/manage-linux.sh start
  bash scripts/manage-linux.sh stop
  bash scripts/manage-linux.sh restart
  bash scripts/manage-linux.sh status

说明:
  start   后台启动 WebFTP 服务，并写入 PID 文件
  stop    根据 PID 文件停止服务
  restart 重启服务
  status  查看当前服务状态
EOF
}

ensure_project_files() {
  [ -f "${PROJECT_DIR}/server.js" ] || fail "未找到 server.js"
  [ -f "${PROJECT_DIR}/package.json" ] || fail "未找到 package.json"
}

ensure_runtime_dir() {
  mkdir -p "${LOG_DIR}"
}

ensure_node_available() {
  command -v node >/dev/null 2>&1 || fail "未检测到 node，请先执行 bash scripts/setup-linux.sh"
  [ -d "${PROJECT_DIR}/node_modules" ] || fail "未检测到 node_modules，请先执行 bash scripts/setup-linux.sh"
}

get_configured_port() {
  local port=""

  if [ -f "${ENV_FILE}" ]; then
    port="$(awk -F= '/^PORT=/{print $2}' "${ENV_FILE}" | tail -n 1 | tr -d '[:space:]')"
  fi

  if [ -z "${port}" ]; then
    port="3000"
  fi

  printf '%s\n' "${port}"
}

print_access_urls() {
  local port interface_name address found=0
  port="$(get_configured_port)"

  printf '本机访问地址:\n'
  printf -- '- http://localhost:%s\n' "${port}"
  printf '局域网访问地址:\n'

  if command -v ip >/dev/null 2>&1; then
    while read -r interface_name address; do
      [ -n "${interface_name}" ] || continue
      [ -n "${address}" ] || continue
      found=1
      printf -- '- %s: http://%s:%s\n' "${interface_name}" "${address}" "${port}"
    done < <(ip -o -4 addr show up scope global | awk '{split($4, ip, "/"); print $2, ip[1]}')
  fi

  if [ "${found}" -eq 0 ]; then
    printf -- '- 未检测到可用的 IPv4 地址，请手动检查网络配置\n'
  fi
}

find_project_pid() {
  local proc_dir pid cwd cmdline
  local node_pid=""
  local fallback_pid=""

  for proc_dir in /proc/[0-9]*; do
    pid="${proc_dir##*/}"

    if [ ! -r "${proc_dir}/cmdline" ] || [ ! -L "${proc_dir}/cwd" ]; then
      continue
    fi

    cwd="$(readlink -f "${proc_dir}/cwd" 2>/dev/null || true)"
    if [ "${cwd}" != "${PROJECT_DIR}" ]; then
      continue
    fi

    cmdline="$(tr '\0' ' ' < "${proc_dir}/cmdline" 2>/dev/null || true)"
    case "${cmdline}" in
      *"node server.js"*|*"node ./server.js"*)
        node_pid="${pid}"
        ;;
      *"sh -c node server.js"*|*"npm start"*)
        if [ -z "${fallback_pid}" ]; then
          fallback_pid="${pid}"
        fi
        ;;
    esac
  done

  if [ -n "${node_pid}" ]; then
    printf '%s\n' "${node_pid}"
    return 0
  fi

  if [ -n "${fallback_pid}" ]; then
    printf '%s\n' "${fallback_pid}"
    return 0
  fi

  return 1
}

get_pid_from_file() {
  if [ ! -f "${PID_FILE}" ]; then
    return 1
  fi

  local pid
  pid="$(cat "${PID_FILE}")"

  if [ -z "${pid}" ]; then
    return 1
  fi

  printf '%s\n' "${pid}"
}

is_running() {
  local pid="$1"
  kill -0 "${pid}" 2>/dev/null
}

cleanup_stale_pid() {
  local pid
  if ! pid="$(get_pid_from_file)"; then
    return
  fi

  if ! is_running "${pid}"; then
    rm -f "${PID_FILE}"
  fi
}

get_active_pid() {
  local pid

  cleanup_stale_pid

  if pid="$(find_project_pid)"; then
    ensure_runtime_dir
    printf '%s\n' "${pid}" > "${PID_FILE}"
    printf '%s\n' "${pid}"
    return 0
  fi

  if pid="$(get_pid_from_file)" && is_running "${pid}"; then
    printf '%s\n' "${pid}"
    return 0
  fi

  return 1
}

start_service() {
  ensure_project_files
  ensure_node_available
  ensure_runtime_dir

  local pid
  if pid="$(get_active_pid)"; then
    log "服务已在运行，PID: ${pid}"
    log "日志文件: ${LOG_FILE}"
    print_access_urls
    return
  fi

  if command -v setsid >/dev/null 2>&1; then
    env PROJECT_DIR="${PROJECT_DIR}" PID_FILE="${PID_FILE}" LOG_FILE="${LOG_FILE}" \
      setsid bash -c '
        cd "${PROJECT_DIR}"
        echo $$ > "${PID_FILE}"
        exec node server.js >> "${LOG_FILE}" 2>&1
      ' </dev/null >/dev/null 2>&1 &
  else
    env PROJECT_DIR="${PROJECT_DIR}" PID_FILE="${PID_FILE}" LOG_FILE="${LOG_FILE}" \
      nohup bash -c '
        cd "${PROJECT_DIR}"
        echo $$ > "${PID_FILE}"
        exec node server.js >> "${LOG_FILE}" 2>&1
      ' </dev/null >/dev/null 2>&1 &
  fi

  sleep 1

  pid="$(get_active_pid)" || fail "启动失败，未检测到运行中的服务进程"
  if ! is_running "${pid}"; then
    rm -f "${PID_FILE}"
    fail "服务启动失败，请检查日志: ${LOG_FILE}"
  fi

  log "服务已启动，PID: ${pid}"
  log "日志文件: ${LOG_FILE}"
  print_access_urls
}

stop_service() {
  local pid
  if ! pid="$(get_active_pid)"; then
    log "服务当前未运行"
    return
  fi

  kill "${pid}"

  for _ in $(seq 1 10); do
    if ! is_running "${pid}"; then
      rm -f "${PID_FILE}"
      log "服务已停止"
      return
    fi
    sleep 1
  done

  kill -9 "${pid}" 2>/dev/null || true
  rm -f "${PID_FILE}"
  log "服务已强制停止"
}

status_service() {
  local pid
  if ! pid="$(get_active_pid)"; then
    log "服务当前未运行"
    return
  fi

  log "服务运行中，PID: ${pid}"
  log "日志文件: ${LOG_FILE}"
  print_access_urls
}

main() {
  case "${1:-}" in
    start)
      start_service
      ;;
    stop)
      stop_service
      ;;
    restart)
      stop_service
      start_service
      ;;
    status)
      status_service
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      fail "未知命令: ${1:-<空>}，可用命令为 start|stop|restart|status"
      ;;
  esac
}

main "${1:-}"
