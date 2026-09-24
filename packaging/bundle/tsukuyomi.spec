%global debug_package %{nil}
%global __os_install_post %{nil}
%global _build_id_links none
Name:           tsukuyomi
Version:        @VERSION@
Release:        @RELEASE@
Summary:        Independent coding-agent TUI with bundled Pi and Node.js
License:        MIT AND ISC AND Apache-2.0 AND BSD-2-Clause AND BSD-3-Clause
URL:            https://github.com/KaguyaMao/Tsukuyomi
Source0:        tsukuyomi-bundle.tar.gz
ExclusiveArch:  x86_64
AutoReqProv:    no
Requires:       /bin/sh
Requires:       bash
Requires:       glibc >= 2.28
Requires:       libstdc++
Requires:       libgcc
Requires:       ca-certificates
Requires:       ripgrep
Requires:       git
Recommends:     socat
Recommends:     wl-clipboard
Recommends:     xclip
%description
Tsukuyomi @VERSION@ with a private Node.js @NODE_VERSION@, npm and Pi
@PI_VERSION@ runtime. This complete application snapshot excludes account
credentials, user configuration and sessions.
%prep
%setup -q -c
%build
%install
mkdir -p %{buildroot}/usr
cp -a usr/. %{buildroot}/usr/
%post
echo "Tsukuyomi is /usr/bin/tsukuyomi"
%files
/usr/bin/tsukuyomi
/usr/lib/tsukuyomi
%license /usr/share/licenses/tsukuyomi
%doc /usr/share/doc/tsukuyomi
