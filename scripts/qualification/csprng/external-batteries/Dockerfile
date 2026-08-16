FROM debian:12.11-slim@sha256:b1a741487078b369e78119849663d7f1a5341ef2768798f7b7406c4240f86aef AS builder

ARG PRACTRAND_VERSION=0.96
ARG PRACTRAND_SHA256=e4caf7fda98b2c597bbda3b576753cf5a0f6047aab837c82be370ab798a672e1
ARG NIST_STS_VERSION=2.1.2
ARG NIST_STS_SHA256=0238d2f1d26e120e3cc748ed2d4c674cdc636de37fc4027c76cc2a394fff9157

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN g++ --version | sed -n '1p' > /build/COMPILER_VERSION
RUN curl --fail --location --retry 3 \
      "https://sourceforge.net/projects/pracrand/files/PractRand_${PRACTRAND_VERSION}.zip/download" \
      --output PractRand.zip \
    && echo "${PRACTRAND_SHA256}  PractRand.zip" | sha256sum --check --strict \
    && unzip -q PractRand.zip \
    && cd PractRand \
    && g++ -c src/*.cpp src/RNGs/*.cpp src/RNGs/other/*.cpp -O3 -Iinclude \
    && ar rcs PractRand.a *.o \
    && g++ -o RNG_test tools/RNG_test.cpp PractRand.a -O3 -Iinclude -Itools -pthread \
    && install -m 0755 RNG_test /usr/local/bin/RNG_test

RUN curl --fail --location --retry 3 \
      "https://csrc.nist.gov/CSRC/media/Projects/Random-Bit-Generation/documents/sts-2_1_2.zip" \
      --output nist-sts.zip \
    && echo "${NIST_STS_SHA256}  nist-sts.zip" | sha256sum --check --strict \
    && unzip -q nist-sts.zip \
    && cd sts-2.1.2/sts-2.1.2 \
    && mkdir -p obj \
    && make \
    && printf '%s\n' "NIST SP 800-22 STS ${NIST_STS_VERSION}" > VERSION \
    && printf '%s\n' "${NIST_STS_SHA256}" > SOURCE_SHA256

FROM debian:12.11-slim@sha256:b1a741487078b369e78119849663d7f1a5341ef2768798f7b7406c4240f86aef

ARG DIEHARDER_VERSION=3.31.1.4-1
RUN apt-get update \
    && apt-get install --yes --no-install-recommends "dieharder=${DIEHARDER_VERSION}" ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/RNG_test /usr/local/bin/RNG_test
COPY --from=builder /build/COMPILER_VERSION /opt/qualification/COMPILER_VERSION
COPY --from=builder /build/sts-2.1.2/sts-2.1.2 /opt/nist-sts
COPY battery-entrypoint.sh /usr/local/bin/mosera-csprng-battery

RUN chmod 0555 /usr/local/bin/mosera-csprng-battery /usr/local/bin/RNG_test /opt/nist-sts/assess \
    && chmod 0444 /opt/qualification/COMPILER_VERSION \
    && find /opt/nist-sts -type f -exec chmod a-w {} +

LABEL org.opencontainers.image.title="Mosera CSPRNG external statistical battery harness" \
      org.opencontainers.image.version="CSPRNG-1.2A" \
      org.opencontainers.image.description="Qualification-only PractRand, dieharder, and NIST STS environment"

ENTRYPOINT ["/usr/local/bin/mosera-csprng-battery"]
CMD ["inventory"]
