#!/bin/sh
set -eu

classification="NON_QUALIFICATION_SMOKE_TEST"

inventory() {
  echo "classification=${classification}"
  echo "container_base=debian:12.11-slim@sha256:b1a741487078b369e78119849663d7f1a5341ef2768798f7b7406c4240f86aef"
  . /etc/os-release
  echo "operating_system=${PRETTY_NAME}"
  echo "build_compiler=$(cat /opt/qualification/COMPILER_VERSION)"
  echo "practrand_source_version=0.96"
  echo "practrand_source_sha256=e4caf7fda98b2c597bbda3b576753cf5a0f6047aab837c82be370ab798a672e1"
  RNG_test --help 2>&1 | sed -n '1,3p' || true
  dieharder -h 2>&1 | sed -n '1,3p' || true
  echo "dieharder_package_version=$(dpkg-query -W -f='${Version}' dieharder)"
  echo "nist_sts_version=$(cat /opt/nist-sts/VERSION)"
  echo "nist_sts_source_sha256=$(cat /opt/nist-sts/SOURCE_SHA256)"
  echo "testu01_status=NOT_INSTALLED_OPTIONAL_NO_REPRODUCIBLE_DEBIAN_12_PACKAGE"
}

require_sample() {
  sample=${1:-}
  if [ -z "$sample" ] || [ ! -f "$sample" ]; then
    echo "A readable raw sample path is required." >&2
    exit 64
  fi
}

run_practrand() {
  require_sample "${1:-}"
  max=${2:-1MB}
  echo "$classification"
  echo "command=RNG_test stdin -tlmin 1KB -tlmax $max"
  RNG_test stdin -tlmin 1KB -tlmax "$max" < "$sample"
}

run_dieharder() {
  require_sample "${1:-}"
  echo "$classification"
  echo "command=dieharder -g 201 -f $sample -d 0"
  dieharder -g 201 -f "$sample" -d 0
}

run_nist() {
  require_sample "${1:-}"
  output=${2:-/output}
  sequence_bits=${3:-1000000}
  sequences=${4:-1}
  mkdir -p "$output"
  work=$(mktemp -d /tmp/nist-sts.XXXXXX)
  trap 'rm -rf "$work"' EXIT INT TERM
  cp -R /opt/nist-sts/. "$work/"
  chmod -R u+w "$work"
  cp "$sample" "$work/sample.bin"
  cd "$work"
  echo "$classification"
  echo "command=assess $sequence_bits; input=binary; sequences=$sequences; selected_test=Frequency"
  set +e
  printf '0\nsample.bin\n0\n100000000000000\n%s\n1\n' "$sequences" | ./assess "$sequence_bits"
  assess_status=$?
  set -e
  report=experiments/AlgorithmTesting/finalAnalysisReport.txt
  if [ ! -s "$report" ]; then
    echo "NIST STS did not produce finalAnalysisReport.txt (assess status $assess_status)." >&2
    exit 1
  fi
  tar -czf "$output/nist-sts-output.tar.gz" experiments/AlgorithmTesting
  cat "$report"
  echo "nist_reference_assess_status=$assess_status"
  echo "nist_wrapper_status=accepted"
}

case "${1:-inventory}" in
  inventory) inventory ;;
  practrand) shift; run_practrand "$@" ;;
  dieharder) shift; run_dieharder "$@" ;;
  nist) shift; run_nist "$@" ;;
  *) echo "Usage: mosera-csprng-battery {inventory|practrand|dieharder|nist}" >&2; exit 64 ;;
esac
