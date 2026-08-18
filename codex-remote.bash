# Source this file from Bash after setting CODEX_APP_SERVER_SOCKET.

if [[ -z ${CODEX_APP_SERVER_SOCKET:-} ]]; then
    printf 'Set CODEX_APP_SERVER_SOCKET before sourcing codex-remote.bash.\n' >&2
    return 2
fi

if [[ -z ${CODEX_LOCAL_BIN:-} ]]; then
    CODEX_LOCAL_BIN=$(type -P codex 2>/dev/null || true)
fi
CODEX_LOCAL_BIN=$(readlink -f -- "$CODEX_LOCAL_BIN" 2>/dev/null || true)

if [[ -z $CODEX_LOCAL_BIN || ! -x $CODEX_LOCAL_BIN ]]; then
    printf 'Codex executable not found. Set CODEX_LOCAL_BIN explicitly.\n' >&2
    return 127
fi

if [[ $CODEX_APP_SERVER_SOCKET != /* ]]; then
    printf 'CODEX_APP_SERVER_SOCKET must be an absolute path.\n' >&2
    return 2
fi

CODEX_REMOTE_ENDPOINT="unix://${CODEX_APP_SERVER_SOCKET}"

codex-local() {
    "$CODEX_LOCAL_BIN" "$@"
}

codex() {
    local command_name=
    local arg
    local skip_value=0
    local explicit_remote=0
    local root_info=0

    # Find the root subcommand without changing the original arguments.
    for arg in "$@"; do
        if (( skip_value )); then
            skip_value=0
            continue
        fi

        case "$arg" in
            --)
                break
                ;;
            --remote)
                explicit_remote=1
                skip_value=1
                ;;
            --remote=*)
                explicit_remote=1
                ;;
            -c|--config|--enable|--disable|--remote-auth-token-env|-i|--image|-m|--model|--local-provider|-p|--profile|-s|--sandbox|-C|--cd|--add-dir|-a|--ask-for-approval)
                skip_value=1
                ;;
            --config=*|--enable=*|--disable=*|--remote-auth-token-env=*|--image=*|--model=*|--local-provider=*|--profile=*|--sandbox=*|--cd=*|--add-dir=*|--ask-for-approval=*|-c?*|-i?*|-m?*|-p?*|-s?*|-C?*|-a?*)
                ;;
            -h|--help|-V|--version)
                [[ -z $command_name ]] && root_info=1
                ;;
            -*)
                ;;
            *)
                [[ -z $command_name ]] && command_name=$arg
                ;;
        esac
    done

    if (( explicit_remote )); then
        codex-local "$@"
        return
    fi

    case "$command_name" in
        resume|fork|archive|delete|unarchive)
            codex-local --remote "$CODEX_REMOTE_ENDPOINT" "$@"
            ;;
        app|app-server|apply|a|cloud|cloud-tasks|completion|debug|doctor|exec|e|exec-server|execpolicy|features|help|login|logout|mcp|mcp-server|plugin|remote-control|review|sandbox|update)
            codex-local "$@"
            ;;
        '')
            if (( root_info )); then
                codex-local "$@"
            else
                codex-local --remote "$CODEX_REMOTE_ENDPOINT" "$@"
            fi
            ;;
        *)
            codex-local --remote "$CODEX_REMOTE_ENDPOINT" "$@"
            ;;
    esac
}
