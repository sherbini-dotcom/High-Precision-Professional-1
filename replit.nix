{ pkgs }: {
  deps = [
    pkgs.nodejs_22
    pkgs.nodePackages.pnpm
    pkgs.cmake
    pkgs.python3
    pkgs.gcc
    pkgs.gnumake
    pkgs.pkg-config
    pkgs.openssl
  ];
}
