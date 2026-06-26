#!/usr/bin/env bash
set -euo pipefail

readonly SCHEMA_MAX_BYTES=1048576

schema_location=""
schema_name_override=""
input_path=""
schema_file=""
temp_schema_path=""

cleanup() {
  if [[ -n "$temp_schema_path" ]]; then
    rm -f "$temp_schema_path"
  fi
}

trap cleanup EXIT HUP INT TERM

schema_error() {
  printf 'perf.jsonl schema: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage: validate-perf-jsonl.sh --schema <path-or-url> [--schema-name <name>] [perf-jsonl-file]
USAGE
}

default_temp_dir() {
  printf '/%s\n' "tmp"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --schema)
      shift
      [[ $# -gt 0 ]] || schema_error "missing --schema value"
      schema_location="$1"
      ;;
    --schema-name)
      shift
      [[ $# -gt 0 ]] || schema_error "missing --schema-name value"
      schema_name_override="$1"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*)
      schema_error "unsupported option"
      ;;
    *)
      if [[ -n "$input_path" ]]; then
        schema_error "too many perf.jsonl input files"
      fi
      input_path="$1"
      ;;
  esac
  shift
done

[[ -n "$schema_location" ]] || schema_error "missing --schema"

if ! command -v jq >/dev/null 2>&1; then
  schema_error "jq is required"
fi

acquire_schema() {
  local location="$1"
  if [[ "$location" == http://* || "$location" == https://* ]]; then
    if ! command -v curl >/dev/null 2>&1; then
      schema_error "curl is required for URL schemas"
    fi
    local temp_root="${TMPDIR:-$(default_temp_dir)}"
    temp_schema_path="$(mktemp "${temp_root%/}/perf-jsonl-schema.XXXXXX")"
    local capped_bytes
    capped_bytes=$((SCHEMA_MAX_BYTES + 1))
    local max_time="${PERF_JSONL_VALIDATE_CURL_MAX_TIME:-10}"
    set +e
    curl \
      --fail \
      --silent \
      --show-error \
      --location \
      --proto '=http,https' \
      --proto-redir '=http,https' \
      --max-redirs 3 \
      --connect-timeout 2 \
      --max-time "$max_time" \
      --retry 0 \
      --output - \
      "$location" 2>/dev/null | head -c "$capped_bytes" >"$temp_schema_path"
    local -a fetch_status=("${PIPESTATUS[@]}")
    set -e
    local curl_status="${fetch_status[0]}"
    local head_status="${fetch_status[1]}"
    if (( head_status != 0 )); then
      schema_error "fetch failed"
    fi
    if (( curl_status != 0 )); then
      local fetched_size
      fetched_size="$(wc -c <"$temp_schema_path" | tr -d '[:space:]')"
      if (( fetched_size <= SCHEMA_MAX_BYTES )); then
        schema_error "fetch failed"
      fi
    fi
    schema_file="$temp_schema_path"
    return
  fi

  if [[ "$location" =~ ^[A-Za-z][A-Za-z0-9+.-]*: ]]; then
    schema_error "unsupported location"
  fi

  [[ -f "$location" ]] || schema_error "schema file not found"
  schema_file="$location"
}

acquire_schema "$schema_location"

schema_size="$(wc -c <"$schema_file" | tr -d '[:space:]')"
if [[ "$schema_size" == "0" ]]; then
  schema_error "empty schema"
fi
if (( schema_size > SCHEMA_MAX_BYTES )); then
  schema_error "schema too large"
fi

if ! jq empty "$schema_file" >/dev/null 2>&1; then
  schema_error "malformed JSON"
fi

if ! jq -e '
  def string_array:
    type == "array" and all(.[]; type == "string");
  def supported_type:
    . == "string" or . == "number" or . == "integer" or . == "boolean";
  def allowed_top_level_key:
    . as $key
    | ["$id", "$schema", "type", "additionalProperties", "properties", "required"]
    | index($key) != null;
  def allowed_property_key:
    . as $key
    | ["type", "minimum", "maximum", "minLength", "maxLength", "pattern"]
    | index($key) != null;
  def valid_pattern:
    . as $pattern
    | try ("__jq_schema_pattern_probe__" | test($pattern) | true) catch false;

  type == "object"
  and .type == "object"
  and .additionalProperties == false
  and (.properties | type == "object")
  and ((has("required") | not) or (.required | string_array))
  and all(keys[]; allowed_top_level_key)
  and (
    ((.required // []) - (.properties | keys))
    | length == 0
  )
  and all(.properties[];
    type == "object"
    and (.type | type == "string" and supported_type)
    and all(keys[]; allowed_property_key)
    and ((has("minimum") | not) or (.minimum | type == "number"))
    and ((has("maximum") | not) or (.maximum | type == "number"))
    and ((has("minLength") | not) or (.minLength | type == "number"))
    and ((has("maxLength") | not) or (.maxLength | type == "number"))
    and ((has("pattern") | not) or (.pattern | type == "string" and valid_pattern))
  )
' "$schema_file" >/dev/null 2>&1; then
  schema_error "unsupported schema shape"
fi

derive_schema_name() {
  if [[ -n "$schema_name_override" ]]; then
    printf '%s\n' "${schema_name_override//-/_}"
    return
  fi

  local id_group
  id_group="$(
    jq -r 'try ((.["$id"] // "") | capture("/telemetry-contract/(?<group>[^/]+)/v[0-9]+").group) catch ""' \
      "$schema_file" 2>/dev/null
  )"
  if [[ -n "$id_group" ]]; then
    printf '%s\n' "${id_group//-/_}"
    return
  fi

  local location_without_query
  local base_name
  location_without_query="${schema_location%%\?*}"
  base_name="${location_without_query##*/}"
  base_name="${base_name%.schema.json}"
  base_name="${base_name%.json}"
  [[ -n "$base_name" ]] || base_name="unknown"
  printf '%s\n' "${base_name//-/_}"
}

schema_name="$(derive_schema_name)"

validate_row() {
  local row="$1"
  jq -cn \
    --arg row "$row" \
    --arg schemaName "$schema_name" \
    --slurpfile schema "$schema_file" '
      def alias_pairs:
        [
          { legacy: "model", canonical: "gen_ai.request.model" },
          { legacy: "input_tokens", canonical: "gen_ai.usage.input_tokens" },
          { legacy: "output_tokens", canonical: "gen_ai.usage.output_tokens" },
          { legacy: "cache_creation_input_tokens", canonical: "gen_ai.usage.cache_creation.input_tokens" },
          { legacy: "cache_read_input_tokens", canonical: "gen_ai.usage.cache_read.input_tokens" }
        ];

      def normalize_aliases($schemaName):
        if $schemaName == "gen_ai" then
          reduce alias_pairs[] as $pair ({ row: ., conflict: null };
            if .conflict != null then
              .
            elif (.row | has($pair.legacy)) then
              if (.row | has($pair.canonical)) then
                if .row[$pair.legacy] == .row[$pair.canonical] then
                  .row |= del(.[$pair.legacy])
                else
                  .conflict = $pair
                end
              else
                .row[$pair.canonical] = .row[$pair.legacy]
                | .row |= del(.[$pair.legacy])
              end
            else
              .
            end
          )
        else
          { row: ., conflict: null }
        end;

      def first_missing($row; $schema):
        [
          ($schema.required // [])[] as $name
          | select(($row | has($name)) | not)
          | $name
        ][0] // null;

      def first_unknown($row; $schema):
        [
          ($row | keys_unsorted[]) as $name
          | select((($schema.properties | has($name)) | not))
          | $name
        ][0] // null;

      def text_length:
        explode | length;

      def no_control_character_pattern:
        "^[^\\u0000-\\u001f\\u007f]+$";

      def url_path_pattern:
        "^(?!//)(?!/[^/?#]*:[^/?#]*@)(?!.*://)(?!.*[?#])/[^\\u0000-\\u001f\\u007f]*$";

      def has_no_control_characters:
        all(explode[]; . > 31 and . != 127);

      def matches_contract_pattern($pattern):
        if $pattern == no_control_character_pattern then
          has_no_control_characters
        elif $pattern == url_path_pattern then
          has_no_control_characters
          and test("^(?!//)(?!/[^/?#]*:[^/?#]*@)(?!.*://)(?!.*[?#])/.*$")
        else
          try test($pattern) catch false
        end;

      def property_error($name; $value; $rule):
        if $rule.type == "string" then
          if ($value | type) != "string" then
            { kind: "invalid_scalar", attribute: $name, reason: "expected string" }
          elif ($rule.minLength? != null and (($value | text_length) < $rule.minLength)) then
            { kind: "invalid_scalar", attribute: $name, reason: ("must have length >= " + ($rule.minLength | tostring)) }
          elif ($rule.maxLength? != null and (($value | text_length) > $rule.maxLength)) then
            { kind: "invalid_scalar", attribute: $name, reason: ("must have length <= " + ($rule.maxLength | tostring)) }
          elif ($rule.pattern? != null and (($value | matches_contract_pattern($rule.pattern)) | not)) then
            { kind: "invalid_scalar", attribute: $name, reason: "must match pattern" }
          else
            null
          end
        elif $rule.type == "integer" then
          if ($value | type) != "number" or ($value | floor) != $value then
            { kind: "invalid_scalar", attribute: $name, reason: "expected integer" }
          elif ($rule.minimum? != null and $value < $rule.minimum) then
            { kind: "invalid_scalar", attribute: $name, reason: ("must be >= " + ($rule.minimum | tostring)) }
          elif ($rule.maximum? != null and $value > $rule.maximum) then
            { kind: "invalid_scalar", attribute: $name, reason: ("must be <= " + ($rule.maximum | tostring)) }
          else
            null
          end
        elif $rule.type == "number" then
          if ($value | type) != "number" then
            { kind: "invalid_scalar", attribute: $name, reason: "expected number" }
          elif ($rule.minimum? != null and $value < $rule.minimum) then
            { kind: "invalid_scalar", attribute: $name, reason: ("must be >= " + ($rule.minimum | tostring)) }
          elif ($rule.maximum? != null and $value > $rule.maximum) then
            { kind: "invalid_scalar", attribute: $name, reason: ("must be <= " + ($rule.maximum | tostring)) }
          else
            null
          end
        elif $rule.type == "boolean" then
          if ($value | type) != "boolean" then
            { kind: "invalid_scalar", attribute: $name, reason: "expected boolean" }
          else
            null
          end
        else
          { kind: "invalid_scalar", attribute: $name, reason: "unsupported schema type" }
        end;

      def first_property_error($row; $schema):
        [
          ($row | keys_unsorted[]) as $name
          | $schema.properties[$name] as $rule
          | property_error($name; $row[$name]; $rule)
          | select(. != null)
        ][0] // null;

      ($schema[0]) as $activeSchema
      | (try { ok: true, row: ($row | fromjson) } catch { ok: false }) as $parsed
      | if ($parsed.ok | not) then
          { valid: false, kind: "invalid_json" }
        elif ($parsed.row | type) != "object" then
          { valid: false, kind: "invalid_scalar", attribute: "$", reason: "expected object" }
        else
          ($parsed.row | normalize_aliases($schemaName)) as $normalized
          | if $normalized.conflict != null then
              {
                valid: false,
                kind: "legacy_conflict",
                legacy: $normalized.conflict.legacy,
                canonical: $normalized.conflict.canonical
              }
            else
              $normalized.row as $normalizedRow
              | (first_missing($normalizedRow; $activeSchema)) as $missing
              | if $missing != null then
                  { valid: false, kind: "missing_required", attribute: $missing }
                else
                  (first_unknown($normalizedRow; $activeSchema)) as $unknown
                  | if $unknown != null then
                      { valid: false, kind: "unknown_attribute", attribute: $unknown }
                    else
                      (first_property_error($normalizedRow; $activeSchema)) as $propertyFailure
                      | if $propertyFailure != null then
                          { valid: false } + $propertyFailure
                        else
                          { valid: true }
                        end
                    end
                end
            end
        end
    ' 2>/dev/null
}

result_value() {
  local source="$1"
  local field="$2"
  printf '%s' "$source" | jq -r "$field"
}

row_error() {
  local row_number="$1"
  local message="$2"
  printf 'perf.jsonl row %s: %s (schema: %s)\n' \
    "$row_number" \
    "$message" \
    "$schema_name" >&2
  exit 1
}

process_line() {
  local row_number="$1"
  local line="$2"
  local result

  if ! result="$(validate_row "$line")"; then
    schema_error "validation failed"
  fi

  if [[ "$(result_value "$result" ".valid")" == "true" ]]; then
    return
  fi

  case "$(result_value "$result" ".kind")" in
    invalid_json)
      row_error "$row_number" "invalid JSON"
      ;;
    missing_required)
      row_error "$row_number" "missing required attribute '$(result_value "$result" ".attribute")'"
      ;;
    unknown_attribute)
      row_error "$row_number" "unknown attribute '$(result_value "$result" ".attribute")'"
      ;;
    legacy_conflict)
      row_error "$row_number" "conflicting legacy attribute '$(result_value "$result" ".legacy")' with canonical attribute '$(result_value "$result" ".canonical")'"
      ;;
    invalid_scalar)
      row_error "$row_number" "invalid attribute '$(result_value "$result" ".attribute")': $(result_value "$result" ".reason")"
      ;;
    *)
      schema_error "validation failed"
      ;;
  esac
}

if [[ -n "$input_path" ]]; then
  [[ -f "$input_path" ]] || schema_error "perf.jsonl file not found"
  exec <"$input_path"
fi

row_number=0
while IFS= read -r line || [[ -n "$line" ]]; do
  row_number=$((row_number + 1))
  process_line "$row_number" "$line"
done
