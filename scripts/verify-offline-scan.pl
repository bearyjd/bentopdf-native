# Scanner for scripts/verify-offline.sh. Reads NUL-separated ./relative file names on stdin
# (cwd = bundle root) and prints one "file<TAB>host<TAB>url" line per external URL that a
# browser could request. Env: SKIP_RE (engine dirs), CDN_RE (hosts reported inside engine dirs),
# ENGINE_ALL=1 (report every URL in engine dirs, for audits).
use strict;
use warnings;

$/ = "\0";
my $skip = qr/$ENV{SKIP_RE}/;
my $cdn  = qr/$ENV{CDN_RE}/i;
my $engine_all = ($ENV{ENGINE_ALL} // '') eq '1';
my $nfiles = 0;

# https://host/..., or protocol-relative //host/... when it syntactically starts a value
# (after a quote, backtick, "(" or "="). Needs a dotted host so "//1" and path-like strings are skipped.
my $URL_CHARS = q{A-Za-z0-9._~:/?#@!$&*+,;=%-};
my $ABS = qr{https?://[$URL_CHARS]+};
my $REL = qr{(?<=["'`(=])//(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9.-])[$URL_CHARS]*};
my $ANY = qr{$ABS|$REL};

# A URL in a position where the code fetches it (used inside engine dirs, whose code is full of doc links).
my $CALL = qr{(?:\bfetch|\bimportScripts|\bimport|\.open|\bWebSocket|\bEventSource|\bsendBeacon|\bWorker|\bSharedWorker|\bsrc|\bhref|\baction|\bindexURL|\bsetCdnUrl|\bloadPackage|\burl)\s*[(=:]\s*(?:["']?[A-Za-z_.]+["']?\s*,\s*)?["'`]?\z|\@import\s+(?:url\()?["'`]?\z};

sub urls_in { # text -> list of normalised URLs
  my ($t) = @_;
  my @u;
  while ($t =~ /$ANY/g) { my $m = $&; $m = "https:$m" if $m =~ m{^//}; push @u, $m; }
  return @u;
}

sub call_urls_in { # text -> URLs directly passed to a fetching construct
  my ($t) = @_;
  my @u;
  while ($t =~ /$ANY/g) {
    my $m = $&; my $at = $-[0];
    my $before = substr($t, $at > 160 ? $at - 160 : 0, $at > 160 ? 160 : $at);
    next unless $before =~ $CALL;
    $m = "https:$m" if $m =~ m{^//};
    push @u, $m;
  }
  return @u;
}

while (my $path = <STDIN>) {
  chomp $path;
  my $f = $path; $f =~ s{^\./}{};
  my $in_engine = ($f =~ $skip);
  open(my $fh, "<:raw", $path) or next;
  my $s = do { local $/ = undef; <$fh> };
  close $fh;
  $nfiles++;
  my @urls;
  if ($f =~ /\.html$/) {
    # Resource-loading tags: every attribute (src, href, srcset, data, action, poster, ...).
    while ($s =~ /<(?:script|img|iframe|link|source|video|audio|embed|object|form|use)\b[^>]*>/gis) {
      my $t = $&; next if $t =~ /\brel\s*=\s*["']?(canonical|alternate)/i;
      push @urls, urls_in($t);
    }
    # <meta http-equiv=refresh content="0;url=...">
    while ($s =~ /<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gis) { push @urls, urls_in($&); }
    # Inline <script> bodies (JSON-LD is metadata) and <style> bodies: fetch(...), import, @import, url(...).
    while ($s =~ /<script\b([^>]*)>(.*?)<\/script\s*>/gis) { my ($a, $b) = ($1, $2); push @urls, urls_in($b) unless $a =~ /ld\+json/i; }
    while ($s =~ /<style\b[^>]*>(.*?)<\/style\s*>/gis) { push @urls, urls_in($1); }
    # style="..." attributes on any element
    while ($s =~ /\bstyle\s*=\s*("[^"]*"|'[^']*')/gis) { push @urls, urls_in($1); }
  } elsif ($in_engine && !$engine_all) {
    # Engine dirs (pyodide, gs, tesseract core, libreoffice, PDF.js viewers): CDN-like hosts anywhere,
    # plus ANY host when the URL is handed straight to fetch/import/open/src=/... .
    my %seen;
    for my $u (urls_in($s)) { my ($h) = $u =~ m{^https?://([^/:?#]+)}; push @urls, $u if defined $h && $h =~ $cdn && !$seen{$u}++; }
    for my $u (call_urls_in($s)) { push @urls, $u unless $seen{$u}++; }
  } else {
    push @urls, urls_in($s);
  }
  for my $u (@urls) {
    $u =~ s{[).,;:"'`\\]+$}{};
    my ($h) = $u =~ m{^https?://([^/:?#]+)}; next unless defined $h;
    print "$f\t$h\t$u\n";
  }
}
print STDERR "scanned $nfiles text files\n";
