import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      accepted: false,
      error:
        "This legacy result publisher is retired. Use the certificate-backed Game Engine outcome publication workflow.",
      canonicalEndpoint: "/api/game-engine/outcome-publications",
    },
    {
      status: 410,
      headers: {
        Deprecation: "true",
        Link: '</api/game-engine/outcome-publications>; rel="successor-version"',
      },
    }
  );
}
