#!/usr/bin/env bash
# Forced SSH command for the backgammon deploy key. stdin = gzip'd docker image tarball.
#
# Everything on stdin is untrusted until checked. The deploy key must not be
# able to do more than roll out this one application, so before anything on
# the host changes:
#   1. the tarball may carry exactly one image, tagged backgammon:current
#      (docker load would otherwise silently re-tag e.g. postgres or caddy);
#   2. the compose file extracted from the image is normalised with
#      `docker compose config` and checked against an allowlist (no privileged
#      containers, host namespaces, bind mounts, published ports, foreign
#      images, extra services, volumes or networks);
#   3. the Caddy snippet may define only the backgammon.automated.ink site and
#      must adapt cleanly on its own.
# Only then is the compose file installed and started, and the snippet swapped
# in with the full Caddyfile validated (previous snippet restored on failure).
#
# Bumping the postgres image, adding a service, volume or network, or changing
# the site address requires updating the allowlists below and reinstalling this
# script on the host (/usr/local/bin/backgammon-deploy, root, mode 755).
set -euo pipefail

APP_DIR=/opt/backgammon
SITES_DIR=/opt/caddy/sites
IMAGE=backgammon:current
SITE=backgammon.automated.ink
CADDY_CONTAINER=caddy
CADDY_SITES_MOUNT=/etc/caddy/sites # $SITES_DIR as seen inside the Caddy container

ALLOWED_SERVICES=$'app\npostgres'
ALLOWED_IMAGES='^(backgammon:current|postgres:[0-9]+(\.[0-9]+)?-alpine)$'
ALLOWED_VOLUMES='^postgres-data$'
ALLOWED_NETWORKS='^(edge|internal)$'

fail() {
  echo "deploy: $*" >&2
  exit 1
}

# --- 1. image tarball -------------------------------------------------------

# Every place a docker/OCI tarball can name an image must name only $IMAGE.
check_image_tarball() {
  local tar=$1 manifest index repos
  manifest=$(tar -xOf "$tar" manifest.json 2>/dev/null | tr -d ' \n\r\t') \
    || fail "image tarball has no manifest.json"
  [ "$(grep -o '"Config":' <<<"$manifest" | wc -l)" -eq 1 ] \
    || fail "image tarball must contain exactly one image"
  [ "$(grep -o '"RepoTags":\[[^]]*\]' <<<"$manifest")" = "\"RepoTags\":[\"$IMAGE\"]" ] \
    || fail "image tarball must be tagged $IMAGE only"

  # OCI index (containerd image store reads names from these annotations).
  if index=$(tar -xOf "$tar" index.json 2>/dev/null); then
    index=$(tr -d ' \n\r\t' <<<"$index")
    [ "$(grep -o '"io.containerd.image.name":"[^"]*"' <<<"$index" | sort -u)" \
      = "\"io.containerd.image.name\":\"docker.io/library/$IMAGE\"" ] \
      || fail "image tarball index.json names an image other than $IMAGE"
    local ref
    ref=$(grep -o '"org.opencontainers.image.ref.name":"[^"]*"' <<<"$index" | sort -u)
    [ "$ref" = "\"org.opencontainers.image.ref.name\":\"${IMAGE#*:}\"" ] \
      || [ "$ref" = "\"org.opencontainers.image.ref.name\":\"docker.io/library/$IMAGE\"" ] \
      || fail "image tarball index.json references a tag other than ${IMAGE#*:}"
  fi

  # Legacy repositories file.
  if repos=$(tar -xOf "$tar" repositories 2>/dev/null); then
    [[ "$(tr -d ' \n\r\t' <<<"$repos")" =~ ^\{\"${IMAGE%%:*}\":\{\"${IMAGE#*:}\":\"[0-9a-f]+\"\}\}$ ]] \
      || fail "image tarball repositories file names an image other than $IMAGE"
  fi
}

# --- 2. compose file --------------------------------------------------------

# Print one top-level section (e.g. "volumes") of canonical compose YAML.
yaml_section() {
  awk -v name="$1" '
    /^[^ ]/ { inside = ($0 == name ":") ; next }
    inside { print }'
}

# Keys of the mappings directly under a section (two-space indent).
yaml_section_keys() {
  yaml_section "$1" | sed -nE "s/^  ([A-Za-z0-9_.-]+|'[^']*'):.*/\1/p" | tr -d "'"
}

check_compose() {
  local file=$1 project_dir=$2 canon services
  canon=$(docker compose --project-directory "$project_dir" -f "$file" config --no-interpolate 2>/dev/null) \
    || fail "compose file does not parse"
  services=$(docker compose --project-directory "$project_dir" -f "$file" config --no-interpolate --services 2>/dev/null | sort) \
    || fail "compose file does not parse"

  [ "$services" = "$ALLOWED_SERVICES" ] || fail "compose services must be exactly: ${ALLOWED_SERVICES//$'\n'/, }"
  [ "$(grep -E '^[^ ]' <<<"$canon" | sed -E 's/:.*//' | sort | tr '\n' ' ')" = "name networks services volumes " ] \
    || fail "compose file may only define services, volumes and networks"

  # aliases/ip addresses under a service's network entry would let this stack
  # answer DNS for the other apps on the shared edge network.
  local forbidden='^ +(privileged|cap_add|pid|ipc|network_mode|security_opt|devices|device_cgroup_rules|userns_mode|sysctls|volumes_from|build|ports|cgroup|cgroup_parent|runtime|driver|driver_opts|extends|develop|aliases|ipv4_address|ipv6_address|link_local_ips|mac_address|interface_name|priority|gw_priority):'
  grep -Eq "$forbidden" <<<"$canon" && fail "compose file uses a forbidden key ($(grep -Eo "$forbidden" <<<"$canon" | head -1 | tr -d ' :'))"
  grep -Eq '^ +type: *(bind|npipe|cluster|image)' <<<"$canon" && fail "compose file mounts something other than a named volume or tmpfs"

  local bad
  bad=$(sed -nE 's/^ +image: *//p' <<<"$canon" | grep -Ev "$ALLOWED_IMAGES" || true)
  [ -z "$bad" ] || fail "compose image not allowed: $bad"
  bad=$(yaml_section_keys volumes <<<"$canon" | grep -Ev "$ALLOWED_VOLUMES" || true)
  [ -z "$bad" ] || fail "compose volume not allowed: $bad"
  yaml_section volumes <<<"$canon" | grep -Eq '^ +external:' && fail "compose file must not use external volumes"
  bad=$(yaml_section_keys networks <<<"$canon" | grep -Ev "$ALLOWED_NETWORKS" || true)
  [ -z "$bad" ] || fail "compose network not allowed: $bad"
  return 0
}

# --- 3. Caddy snippet -------------------------------------------------------

# Structural check with Caddy's own tokenisation: braces count only as
# whitespace-separated tokens (so {http.x} placeholders do not), the only
# top-level line allowed besides blanks is the single "$SITE {" opener, and
# nothing may follow the closing brace of the site on its line. Quotes,
# backticks, comments and heredocs are rejected because they could hide braces
# from this tokenisation.
check_caddy_snippet() {
  local file=$1
  grep -Eq '["'"'"'`#]|<<' "$file" && fail "caddy snippet must not contain quotes, backticks, comments or heredocs"
  awk -v site="$SITE" '
    {
      before = depth
      if (before == 0) {
        if (NF == 0) next
        if (!(NF == 2 && $1 == site && $2 == "{")) exit 1
        if (++blocks > 1) exit 1
      }
      for (i = 1; i <= NF; i++) {
        if ($i == "{") depth++
        else if ($i == "}") { depth--; if (depth == 0 && i < NF) exit 1 }
        if (depth < 0) exit 1
      }
    }
    END { if (depth != 0 || blocks != 1) exit 1 }' "$file" \
    || fail "caddy snippet may only define the $SITE site block"
}

# The snippet must adapt and validate on its own; runs inside the Caddy container.
adapt_caddy_snippet() {
  docker exec "$CADDY_CONTAINER" caddy adapt --config "$CADDY_SITES_MOUNT/$1" --adapter caddyfile --validate >/dev/null 2>&1 \
    || fail "caddy snippet does not adapt"
}

# --- roll-out ---------------------------------------------------------------

main() {
  local tarball cid compose_new snippet_new snippet_prev
  tarball=$(mktemp "$APP_DIR/.image.XXXXXXXX")
  cid=""
  compose_new="$APP_DIR/docker-compose.yml.new"
  snippet_new="$SITES_DIR/backgammon.caddy.new" # *.caddy.new is not matched by the Caddyfile's import glob
  snippet_prev="$SITES_DIR/backgammon.caddy.prev"
  # shellcheck disable=SC2064  # expand now: the trap must use the values as they are at this point
  trap "rm -f '$tarball' '$compose_new' '$snippet_new'; [ -n \"\${cid:-}\" ] && docker rm -f \"\$cid\" >/dev/null 2>&1 || true" EXIT

  gunzip -c >"$tarball"
  check_image_tarball "$tarball"
  docker load -i "$tarball" >/dev/null
  rm -f "$tarball"

  # Pull compose + caddy snippet out of the freshly loaded image and check them.
  cid=$(docker create "$IMAGE")
  docker cp "$cid:/deploy/docker-compose.yml" "$compose_new"
  docker cp "$cid:/deploy/backgammon.caddy" "$snippet_new"
  check_compose "$compose_new" "$APP_DIR"
  check_caddy_snippet "$snippet_new"
  adapt_caddy_snippet "$(basename "$snippet_new")"

  # Nothing on the host has changed up to here.
  mv -f "$compose_new" "$APP_DIR/docker-compose.yml"
  docker compose -f "$APP_DIR/docker-compose.yml" up -d --remove-orphans

  [ -f "$SITES_DIR/backgammon.caddy" ] && cp -f "$SITES_DIR/backgammon.caddy" "$snippet_prev"
  mv -f "$snippet_new" "$SITES_DIR/backgammon.caddy"
  if ! docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    [ -f "$snippet_prev" ] && mv -f "$snippet_prev" "$SITES_DIR/backgammon.caddy"
    fail "Caddyfile invalid with the new snippet; previous snippet restored, Caddy not reloaded"
  fi
  rm -f "$snippet_prev"
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile
  docker image prune -f >/dev/null
  echo "deploy: ok"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
