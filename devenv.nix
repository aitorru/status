{ pkgs, lib, config, ... }:

{
  name = "status";

  packages = [
    pkgs.git
    pkgs.jq
    pkgs.biome
  ];

  languages.javascript = {
    enable = true;
    # The TypeScript LSP lives in the `ide` profile.
    lsp.enable = lib.mkDefault false;
    # Node 24 runs the .ts sources directly (type stripping): no build step.
    package = pkgs.nodejs_24;
    pnpm = {
      enable = true;
      # Only dev tooling (tsc, @types/node): the app itself has no dependencies.
      install.enable = true;
    };
  };

  env = {
    # Dev ports in the 30000–39999 range, open on the LAN / tailnet.
    PORT = "34100";
    STATUS_MOCK_PORT = "34101";
    STATE_FILE = "${config.devenv.state}/demo-state.json";
    npm_config_store_dir = "${config.devenv.state}/pnpm-store";
  };

  scripts = {
    lint.exec = ''
      set -euo pipefail
      cd "$DEVENV_ROOT"
      biome ci .
      pnpm exec tsc --noEmit
      bash -n scripts/sync-punto.sh
      for f in public/*.js; do node --check "$f"; done
    '';
    unit.exec = ''
      set -euo pipefail
      cd "$DEVENV_ROOT"
      node --test "test/*.test.ts"
    '';
    dev.exec = ''
      set -euo pipefail
      cd "$DEVENV_ROOT"
      # Fake upstreams + fake GitLab; links point at this host so they work from another machine.
      DEMO_HOST="''${DEMO_HOST:-$(hostname)}" node --watch-path=src --watch-path=demo demo/run.ts
    '';
    start.exec = ''
      set -euo pipefail
      cd "$DEVENV_ROOT"
      [ -f config/services.json ] || { echo "falta config/services.json (cp config/services.example.json config/services.json)" >&2; exit 1; }
      if [ -f .env ]; then exec node --env-file=.env src/server.ts; else exec node src/server.ts; fi
    '';
    sync-punto.exec = ''
      "$DEVENV_ROOT/scripts/sync-punto.sh" "$@"
    '';
  };

  git-hooks.hooks = {
    biome = {
      enable = true;
      entry = lib.mkForce "${pkgs.biome}/bin/biome check --write --no-errors-on-unmatched";
    };
  };

  profiles = {
    # Editor tooling: devenv --profile ide shell
    ide.module = {
      languages.javascript.lsp.enable = true;
    };
  };

  enterShell = ''
    echo "status dev shell · node $(node --version) · biome $(biome --version | cut -d' ' -f2)"
    echo "  dev   → demo con fuentes y GitLab simulados: página :$PORT · GitLab simulado :$STATUS_MOCK_PORT/gitlab/issues"
    echo "  start → config/services.json + .env reales"
    echo "  lint | unit | sync-punto [ref]"
  '';

  enterTest = ''
    lint
    unit
  '';
}
