import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

export default function ThreeBrowserProofPage() { return <Suspense><Proof /></Suspense>; }
async function Proof() {
  await connection();
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.OPENDISCORD_VOICE_PROOF !== "1") notFound();
  const { ThreeBrowserProof } = await import("./proof");
  return <ThreeBrowserProof />;
}
