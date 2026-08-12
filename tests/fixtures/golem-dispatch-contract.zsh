# Hermetic CI snapshot of the launcher clauses cmuxlayer's spawn schema relies on.
if [[ -n "${CLAUDE_MODEL:-}" ]]; then
  _claude_model="$CLAUDE_MODEL"
else
  _claude_model="claude-opus-5[1m]"
fi

_golem_parse_codex_flags() {
  _flag_codex_effort="xhigh"
  case "$1" in
    --effort)
      case "$2" in
        medium|high|xhigh|ultra) _flag_codex_effort="$2" ;;
      esac
      ;;
  esac
}

_golem_launch_cursor() {
  _golem_refuse_agent_model_override "$@"
  REPOGOLEM_ALLOW_MODEL="${REPOGOLEM_ALLOW_MODEL:-0}"
}
