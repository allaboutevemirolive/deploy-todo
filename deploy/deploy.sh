#!/usr/bin/env bash
# Runs ON THE SERVER. CI calls it over SSH; you can also run it by hand.
#
#   ~/deploy-todo/deploy/deploy.sh
#
# It does what you would type yourself: update the files, pull the new images,
# restart what changed.

# Everything lives inside main() and the script ends with `exit`. Bash reads a
# script while running it, and `git pull` below may rewrite THIS file. Reading
# a whole function first means a changed file cannot confuse the run.
main() {
  set -euo pipefail

  cd "$(dirname "$0")/.."        # repository root
  git pull --ff-only             # new compose / Caddy files, and this script

  cd deploy
  docker compose pull
  docker compose up -d --remove-orphans

  # Remove old, untagged images of THIS project only. A plain `image prune`
  # would also touch dangling images that belong to other projects on the host.
  docker image prune -f \
    --filter "label=org.opencontainers.image.source=https://github.com/allaboutevemirolive/deploy-todo"

  docker compose ps
}

main "$@"
exit $?
