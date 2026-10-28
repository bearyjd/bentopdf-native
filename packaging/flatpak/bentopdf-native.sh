#!/bin/sh
# zypak-wrapper supplies the Chromium sandbox inside Flatpak. Do not add --no-sandbox.
exec zypak-wrapper /app/lib/bentopdf-native/bentopdf-native --ozone-platform-hint=auto "$@"
